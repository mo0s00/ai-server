"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
/** Override on host: DEEPSEEK_MODEL (e.g. deepseek-chat, deepseek-reasoner). */
const MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
const FETCH_TIMEOUT_MS = 25000;
/** Bump when changing behavior (check with GET /health). */
const SERVER_REV = "v10-memos-get";

const app = express();
app.use(express.json({ limit: "1mb" }));

process.on("unhandledRejection", (reason) => {
  console.log("[ai-server] unhandledRejection:", reason);
});

/** Prefer service role on the server so inserts are not blocked by RLS. */
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || typeof url !== "string" || !url.trim()) return null;
  if (!key || typeof key !== "string" || !key.trim()) return null;
  return createClient(url.trim(), key.trim());
}

app.get("/health", (_req, res) => {
  const supabaseOk = Boolean(getSupabase());
  res.json({
    ok: true,
    rev: SERVER_REV,
    model: MODEL,
    memo: supabaseOk,
  });
});

app.get("/comment", (_req, res) => {
  try {
    res.status(200).json({ text: "" });
  } catch (e) {
    console.log("[ai-server] GET /comment:", e && e.message ? e.message : e);
    res.status(200).json({ text: "" });
  }
});

/**
 * POST /memo — body: { user_id: string, content: string }
 * Requires Supabase table `memos` (see supabase/memos_schema.sql).
 */
app.post("/memo", async (req, res) => {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);
  try {
    const supabase = getSupabase();
    if (!supabase) {
      console.log("[ai-server] POST /memo: SUPABASE_URL or key missing");
      return res.status(503).json({ error: "Supabase 환경 변수가 설정되지 않았습니다." });
    }

    const userId = req.body && req.body.user_id;
    const content = req.body && req.body.content;
    if (typeof userId !== "string" || !userId.trim()) {
      return res.status(400).json({ error: "user_id 필드가 필요합니다." });
    }
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content 필드가 필요합니다." });
    }

    const { data, error } = await supabase
      .from("memos")
      .insert({
        user_id: userId.trim(),
        content: content.trim(),
      })
      .select("id")
      .maybeSingle();

    if (error) {
      console.log("[ai-server] POST /memo Supabase:", error.message);
      if (error.details) console.log("[ai-server] details:", error.details);
      if (error.hint) console.log("[ai-server] hint:", error.hint);
      if (error.code) console.log("[ai-server] code:", error.code);
      const dev = process.env.NODE_ENV !== "production";
      return res.status(500).json({
        error: "메모 저장에 실패했습니다. memos 테이블 스키마를 확인하세요.",
        ...(dev ? { supabase: error.message, code: error.code } : {}),
      });
    }

    return res.status(201).json({ ok: true, id: data && data.id });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log("[ai-server] POST /memo error:", msg);
    if (e && e.stack) console.log(e.stack);
    return res.status(500).json({ error: "서버 오류가 발생했습니다." });
  }
});

/**
 * GET /memos/:userId — JSON array of { id, user_id, content, created_at } (newest first).
 */
app.get("/memos/:userId", async (req, res) => {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);
  try {
    const supabase = getSupabase();
    if (!supabase) {
      console.log("[ai-server] GET /memos: Supabase env missing");
      return res.status(503).json({ error: "Supabase 환경 변수가 설정되지 않았습니다." });
    }

    let userId = req.params.userId;
    if (typeof userId === "string") {
      try {
        userId = decodeURIComponent(userId);
      } catch (_) {
        /* keep raw */
      }
    }
    userId = String(userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "user_id가 비어 있습니다." });
    }

    const { data, error } = await supabase
      .from("memos")
      .select("id, user_id, content, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.log("[ai-server] GET /memos Supabase:", error.message);
      if (error.code) console.log("[ai-server] code:", error.code);
      const dev = process.env.NODE_ENV !== "production";
      return res.status(500).json({
        error: "목록을 불러오지 못했습니다.",
        ...(dev ? { supabase: error.message, code: error.code } : {}),
      });
    }

    return res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log("[ai-server] GET /memos error:", msg);
    if (e && e.stack) console.log(e.stack);
    return res.status(500).json({ error: "서버 오류가 발생했습니다." });
  }
});

/** Reject replies that are only a "model: …" line (incl. homoglyphs / ZWSP). */
function isGarbageModelLine(s) {
  if (!s || typeof s !== "string") return false;
  let t = s
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKC")
    .replace(/\uFF1A/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  const expected = `model: ${MODEL}`;
  if (t === expected) return true;
  if (t.toLowerCase() === expected.toLowerCase()) return true;
  const compact = t.replace(/\s/g, "");
  const compactExpected = expected.replace(/\s/g, "");
  if (compact === compactExpected) return true;
  if (/^model\s*:\s*(claude-|deepseek-)/i.test(t)) return true;
  return false;
}

app.post("/comment", async (req, res) => {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key || typeof key !== "string" || !key.trim()) {
      console.log("[ai-server] DEEPSEEK_API_KEY is missing or empty");
      return res.status(503).json({ text: "서버 설정 오류입니다." });
    }

    const prompt = req.body && req.body.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }

    const requestedTemperature = Number(req.body && req.body.temperature);
    const requestedMaxTokens = Number(req.body && req.body.maxTokens);
    const temperature =
      Number.isFinite(requestedTemperature) && requestedTemperature >= 0 && requestedTemperature <= 2
        ? requestedTemperature
        : 0.9;
    const maxTokens =
      Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? Math.min(2048, Math.floor(requestedMaxTokens))
        : 200;

    const payload = JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let dsRes;
    try {
      dsRes = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawText = await dsRes.text();
    let data = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        console.log("[ai-server] DeepSeek response JSON parse error:", parseErr.message);
        console.log("[ai-server] raw (first 300 chars):", rawText.slice(0, 300));
        return res.status(502).json({ text: "응답을 해석할 수 없습니다." });
      }
    }

    if (!dsRes.ok) {
      console.log(
        "[ai-server] DeepSeek HTTP",
        dsRes.status,
        typeof data === "object" ? JSON.stringify(data).slice(0, 500) : rawText.slice(0, 300)
      );
      const apiMsg =
        (data.error && data.error.message) ||
        data.message ||
        "DeepSeek 요청에 실패했습니다.";
      const statusOut = dsRes.status >= 500 ? 502 : dsRes.status;
      let textOut = String(apiMsg);
      if (dsRes.status === 404) {
        textOut = `[API 404] 모델을 찾을 수 없습니다. 현재 MODEL=${MODEL}. 환경 변수 DEEPSEEK_MODEL을 DeepSeek 문서에 맞게 설정하세요. 원문: ${apiMsg}`;
      }
      return res.status(statusOut).json({ text: textOut });
    }

    console.log("[ai-server] DeepSeek ok, raw head:", rawText.slice(0, 400));

    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    const msgObj = first && first.message;
    const text =
      msgObj && typeof msgObj.content === "string" ? msgObj.content.trim() : "";

    if (!text) {
      console.log("[ai-server] No assistant content in DeepSeek response");
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    if (isGarbageModelLine(text)) {
      console.log("[ai-server] rejected garbage model-line reply");
      console.log("[ai-server] full text was:", JSON.stringify(text));
      console.log("[ai-server] codepoints:", [...text].map((c) => c.codePointAt(0)).join(","));
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    return res.status(200).json({ text });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log("[ai-server] POST /comment error:", msg);
    if (e && e.stack) console.log(e.stack);
    if (e && e.name === "AbortError") {
      return res.status(504).json({ text: "요청 시간이 초과되었습니다." });
    }
    return res.status(500).json({ text: "서버 오류가 발생했습니다." });
  }
});

const PORT = Number(process.env.PORT) || 3000;

try {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("server running on " + PORT);
  });
  server.on("error", (err) => {
    console.log("[ai-server] listen error:", err.message);
    process.exit(1);
  });
} catch (e) {
  console.log("[ai-server] failed to start:", e && e.message ? e.message : e);
  process.exit(1);
}
