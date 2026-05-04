"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
const FETCH_TIMEOUT_MS = 25000;
/** Bump when changing behavior (check with GET /health). */
const SERVER_REV = "v70 community feed"

let supabaseEnvLogged = false;

function logSupabaseInit() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const hasServiceRole = !!(
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim()
  );
  const hasAnon = !!(process.env.SUPABASE_ANON_KEY && String(process.env.SUPABASE_ANON_KEY).trim());
  console.log("[ai-server] SUPABASE INIT CHECK");
  console.log("[ai-server]   SUPABASE_URL:", url || "(missing or empty)");
  console.log("[ai-server]   SUPABASE_SERVICE_ROLE_KEY:", hasServiceRole ? "OK" : "MISSING");
  console.log("[ai-server]   SUPABASE_ANON_KEY:", hasAnon ? "OK" : "MISSING");
  console.log("[ai-server]   client can start:", url && (hasServiceRole || hasAnon) ? "yes" : "no");
}

function safeJsonForLog(value, maxLen) {
  const n = maxLen === undefined ? 800 : maxLen;
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > n ? s.slice(0, n) + "…" : s;
  } catch (_e) {
    return "[unserializable]";
  }
}

function getSupabase() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();

  if (!supabaseEnvLogged) {
    supabaseEnvLogged = true;
    console.log("[ai-server] getSupabase (first call) SUPABASE_URL:", url || "(empty)");
    console.log(
      "[ai-server] getSupabase (first call) SUPABASE_SERVICE_ROLE_KEY:",
      process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "MISSING"
    );
    console.log(
      "[ai-server] getSupabase (first call) SUPABASE_ANON_KEY:",
      process.env.SUPABASE_ANON_KEY ? "OK" : "MISSING"
    );
  }

  if (!url || !key) return null;
  return createClient(url, key);
}

function requireSupabase(res) {
  const supabase = getSupabase();
  if (!supabase) {
    console.error("[ai-server] Supabase not initialized (missing SUPABASE_URL or key)");
    res.status(500).json({ error: "supabase not configured" });
    return null;
  }
  return supabase;
}

const app = express();
/** 피메모+[검증된 사실] 등 긴 프롬프트 — 1mb 초과 시 express가 본문 파싱 단계에서 실패할 수 있음 */
app.use(express.json({ limit: "5mb" }));

process.on("unhandledRejection", (reason) => {
  console.log("[ai-server] unhandledRejection:", reason);
});

app.get("/health", (_req, res) => {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();
  res.json({
    ok: true,
    rev: SERVER_REV,
    model: MODEL,
    supabaseConfigured: !!(url && key),
    supabasePostPaths: [
      "POST /api/cookie-tx",
      "POST /api/commenter-state",
      "POST /commenter-state",
      "POST /api/memo",
      "POST /memo",
      "POST /api/chat/message",
      "POST /api/chat-message",
      "POST /api/custom-prompt",
      "POST /api/custom-prompts (same handler as custom-prompt)",
      "GET /api/custom-prompts?user_id=…",
      "GET /api/custom-prompts/:userId",
      "POST /api/comment-save",
      "POST /comment-save",
    ],
  });
});

function readString(body, key) {
  const v = body && body[key];
  return typeof v === "string" ? v.trim() : "";
}

function readInt(body, key, fallback) {
  const v = body && body[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim()) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function readBool(body, key) {
  const v = body && body[key];
  if (v === true || v === false) return v;
  return false;
}

function isUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      s.trim()
    )
  );
}

/** comments.memo_id 가 uuid 일 때: 앱이 보내는 로컬 왕관 id → memos.id(uuid) 로 치환 */
async function resolveMemoUuidForComment(supabase, userId, memoIdRaw) {
  const raw = (memoIdRaw || "").trim();
  if (!raw) {
    return { memoUuid: null, err: "empty memo_id" };
  }
  if (isUuid(raw)) {
    return { memoUuid: raw, err: null };
  }
  const { data, error } = await supabase
    .from("memos")
    .select("id")
    .eq("user_id", userId)
    .eq("local_id", raw)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return { memoUuid: null, err: error.message };
  }
  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row || !row.id) {
    return {
      memoUuid: null,
      err:
        `no memos row for local_id="${raw}" user_id="${userId}" — ` +
        `memos 테이블에 text 컬럼 local_id 를 추가하고 /memo 저장 시 넘기세요`,
    };
  }
  return { memoUuid: row.id, err: null };
}

function logSupabaseErr(label, err) {
  console.log(`❌ ${label}:`, err?.message || err);
  try {
    console.log(`❌ ${label} (full):`, JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  } catch (_) {
    console.log(`❌ ${label} (raw):`, err);
  }
}

/** DeepSeek/호환 API 오류 본문에서 사람이 읽을 문자열만 뽑는다. */
function deepSeekErrorMessage(json) {
  if (!json || typeof json !== "object") return "";
  const e = json.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  if (typeof json.message === "string") return json.message;
  return "";
}

/** Null 등 API 페이로드를 깨뜨릴 수 있는 문자 제거 */
function sanitizePromptForApi(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\u0000/g, "").trim();
}

const MAX_PROMPT_CHARS = Math.max(
  8_000,
  Number.parseInt(process.env.MAX_PROMPT_CHARS || "100000", 10) || 100_000
);

/** `message.content` — 문자열·배열·구조화 객체({ comments })·null */
function assistantTextFromContent(c) {
  if (typeof c === "string") return c.trim();
  if (c == null) return "";
  if (Array.isArray(c)) {
    const parts = [];
    for (const part of c) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object") {
        if (typeof part.text === "string") parts.push(part.text);
        else if (part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
    return parts.join("").trim();
  }
  if (typeof c === "object") {
    try {
      return JSON.stringify(c);
    } catch (_) {
      return "";
    }
  }
  return "";
}

/**
 * deepseek-reasoner / thinking 응답에서 `content`가 비고 `reasoning_content`만 채워진 경우.
 * 사용자에게 보일 짧은 본문은 보통 맨 끝 단락에 가깝다.
 */
function assistantTextFromReasoning(reasoningRaw) {
  if (typeof reasoningRaw !== "string") return "";
  let t = reasoningRaw.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  const max = 8000;
  if (t.length > max) {
    t = t.slice(-max);
  }
  const paras = t
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length >= 1) {
    return paras[paras.length - 1];
  }
  return t;
}

/** DeepSeek/호환 API assistant 메시지 */
function assistantTextFromMessage(msgObj) {
  if (!msgObj || typeof msgObj !== "object") return "";
  let out = assistantTextFromContent(msgObj.content);
  if (out) return out;
  if (typeof msgObj.reasoning_content === "string") {
    out = assistantTextFromReasoning(msgObj.reasoning_content);
    if (out) return out;
  }
  return "";
}

/** DeepSeek 동시 outbound 제한(Render·API 과부하·일시 차단 완화) */
const DEEPSEEK_MAX_CONCURRENT = Math.max(
  1,
  Number.parseInt(process.env.DEEPSEEK_MAX_CONCURRENT || "3", 10) || 3
);
let dsPermits = DEEPSEEK_MAX_CONCURRENT;
const dsWaitQueue = [];

function acquireDeepSeekSlot() {
  return new Promise((resolve) => {
    if (dsPermits > 0) {
      dsPermits--;
      resolve();
    } else {
      dsWaitQueue.push(resolve);
    }
  });
}

function releaseDeepSeekSlot() {
  if (dsWaitQueue.length > 0) {
    const next = dsWaitQueue.shift();
    next();
  } else {
    dsPermits++;
  }
}

/** 모델명만 던지는 쓰레기 응답(동형 문자·ZWSP 등) 거르기. */
function isGarbageModelLine(s, modelStr) {
  const model = typeof modelStr === "string" && modelStr.trim() ? modelStr.trim() : "deepseek-chat";
  if (!s || typeof s !== "string") return false;
  let t = s
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKC")
    .replace(/\uFF1A/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  const expected = `model: ${model}`;
  if (t === expected) return true;
  if (t.toLowerCase() === expected.toLowerCase()) return true;
  const compact = t.replace(/\s/g, "");
  const compactExpected = expected.replace(/\s/g, "");
  if (compact === compactExpected) return true;
  if (/^model\s*:\s*(claude-|deepseek-)/i.test(t)) return true;
  return false;
}

app.get("/comment", (_req, res) => {
  res.status(200).json({ text: "" });
});

app.get("/api/comment", (_req, res) => {
  res.status(200).json({ text: "" });
});

// =========================
// 메모 저장 (local_id = 앱 왕관 TodoItem.id, comments FK 용)
// =========================
async function handleMemoPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const content = readString(req.body, "content");
    const local_id = readString(req.body, "local_id");
    if (!user_id || !content) {
      return res.status(400).json({ error: "user_id, content 필요" });
    }

    const row = { user_id, content };
    if (local_id) row.local_id = local_id;

    // 동일 user_id + local_id 가 있으면 내용만 갱신(중복 행 방지).
    if (local_id) {
      const { data: existing, error: selErr } = await supabase
        .from("memos")
        .select("id")
        .eq("user_id", user_id)
        .eq("local_id", local_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (selErr) {
        logSupabaseErr("[memo] select existing", selErr);
      } else if (existing && existing.id) {
        const { error: upErr } = await supabase
          .from("memos")
          .update({ content })
          .eq("id", existing.id);
        if (upErr) {
          logSupabaseErr("[memo] update", upErr);
          return res.status(500).json({ error: upErr.message });
        }
        console.log("✅ memo updated id=", existing.id, `local_id=${local_id}`);
        return res.json({ ok: true, id: existing.id, updated: true });
      }
    }

    const { data, error } = await supabase
      .from("memos")
      .insert([row])
      .select("id")
      .single();

    if (error) {
      logSupabaseErr("[memo] insert", error);
      return res.status(500).json({ error: error.message });
    }

    console.log("✅ memo saved id=", data?.id, local_id ? `local_id=${local_id}` : "");
    res.json({ ok: true, id: data.id });
  } catch (e) {
    console.log("[memo]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.post("/memo", handleMemoPost);
app.post("/api/memo", handleMemoPost);

async function handleMemosList(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("memos")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json(data || []);
  } catch (e) {
    console.log("[memos]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.get("/memos/:userId", handleMemosList);
app.get("/api/memos/:userId", handleMemosList);

async function handleMemosDelete(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const id = decodeURIComponent(req.params.id || "").trim();
    // eslint-disable-next-line no-console
    console.log("[DELETE memos] id:", id);

    if (!id) return res.status(400).json({ error: "id 필요" });

    const { error } = await supabase.from("memos").delete().eq("id", id);

    if (error) {
      console.error("[DELETE memos error]", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE memos crash]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.delete("/api/memos/:id", handleMemosDelete);
app.delete("/memos/:id", handleMemosDelete);

async function handleCommentSave(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const memo_id_raw = readString(req.body, "memo_id");
    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const content = readString(req.body, "content");
    const sender = readString(req.body, "sender") || "commenter";

    if (!memo_id_raw || !user_id || !commenter_id || !content) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    const { memoUuid, err: resolveErr } = await resolveMemoUuidForComment(
      supabase,
      user_id,
      memo_id_raw
    );
    if (!memoUuid) {
      console.log("❌ [comment-save] resolve memo_id failed:", resolveErr);
      return res.status(400).json({ ok: false, error: resolveErr || "memo_id resolve failed" });
    }

    const { error } = await supabase.from("comments").insert([
      { memo_id: memoUuid, user_id, commenter_id, sender, content },
    ]);

    if (error) {
      logSupabaseErr("[comment-save] insert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    console.log("✅ [comment-save] saved memo_id(uuid)=", memoUuid);
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[comment-save]", e);
    return res.status(500).json({ ok: false });
  }
}

async function handleAiCommentPost(req, res) {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const supabase = getSupabase();
    const promptRaw = req.body && req.body.prompt;
    const memo_id_raw = readString(req.body, "memo_id");
    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const sender = readString(req.body, "sender") || "commenter";

    console.log("📩 comment req:", {
      memo_id: memo_id_raw || null,
      user_id: user_id || null,
      commenter_id: commenter_id || null,
      has_prompt: typeof promptRaw === "string" && !!promptRaw.trim(),
    });

    if (typeof promptRaw !== "string" || !promptRaw.trim()) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }

    let cleanedPrompt = sanitizePromptForApi(promptRaw);
    if (!cleanedPrompt) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }
    if (cleanedPrompt.length > MAX_PROMPT_CHARS) {
      console.log(
        "[comment] truncating prompt length",
        cleanedPrompt.length,
        "->",
        MAX_PROMPT_CHARS
      );
      cleanedPrompt =
        cleanedPrompt.slice(0, MAX_PROMPT_CHARS) + "\n\n[…prompt truncated]";
    }

    const key = process.env.DEEPSEEK_API_KEY;
    if (!key || typeof key !== "string" || !key.trim()) {
      console.log("[comment] DEEPSEEK_API_KEY missing");
      return res.status(503).json({ text: "서버 설정 오류입니다." });
    }

    const requestedTemperature = Number(req.body && req.body.temperature);
    const requestedMaxTokens = Number(req.body && req.body.maxTokens);
    const temperature =
      Number.isFinite(requestedTemperature) && requestedTemperature >= 0 && requestedTemperature <= 2
        ? requestedTemperature
        : 0.9;
    const max_tokens =
      Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? Math.min(2048, Math.floor(requestedMaxTokens))
        : 200;

    await acquireDeepSeekSlot();
    try {
    let payload;
    try {
      payload = JSON.stringify({
        model: MODEL,
        temperature,
        max_tokens,
        messages: [{ role: "user", content: cleanedPrompt }],
      });
    } catch (stringifyErr) {
      console.error("[comment] JSON.stringify(payload) failed:", stringifyErr);
      return res.status(400).json({ text: "프롬프트 인코딩에 실패했습니다." });
    }

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
    const safeRaw = typeof rawText === "string" ? rawText : String(rawText ?? "");
    let json = {};
    if (safeRaw) {
      try {
        json = JSON.parse(safeRaw);
      } catch (parseErr) {
        console.log("[comment] DeepSeek JSON parse", parseErr.message);
        return res.status(502).json({ text: "응답을 해석할 수 없습니다." });
      }
    }

    if (!dsRes.ok) {
      const apiMsg =
        deepSeekErrorMessage(json) || "DeepSeek 요청에 실패했습니다.";
      const statusOut = dsRes.status >= 500 ? 502 : dsRes.status;
      let textOut = String(apiMsg);
      if (dsRes.status === 404) {
        textOut = `[API 404] 모델을 찾을 수 없습니다. 현재 MODEL=${MODEL}. 환경변수 DEEPSEEK_MODEL을 확인하세요. 원문: ${apiMsg}`;
      }
      console.log(
        "[comment] DeepSeek HTTP",
        dsRes.status,
        safeRaw.length ? safeRaw.slice(0, 400) : "(empty body)"
      );
      return res.status(statusOut).json({ text: textOut });
    }

    if (safeRaw.length) {
      console.log("[comment] DeepSeek ok, raw head:", safeRaw.slice(0, 400));
    }

    const choices = Array.isArray(json?.choices) ? json.choices : [];
    const first = choices[0];
    const msgObj = first && first.message;
    let text = assistantTextFromMessage(msgObj);
    if (!text && first && typeof first.text === "string") {
      text = first.text.trim();
    }

    if (!text) {
      console.log("[comment] No assistant content in DeepSeek response");
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    if (isGarbageModelLine(text, MODEL)) {
      console.log("[comment] rejected garbage model-line reply");
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    // 클라우드 저장 실패는 DM/댓글 응답을 막지 않는다(예외 삼킴 + 로그).
    if (supabase && memo_id_raw && user_id && commenter_id) {
      try {
        const { memoUuid, err: resolveErr } = await resolveMemoUuidForComment(
          supabase,
          user_id,
          memo_id_raw
        );
        if (!memoUuid) {
          console.log("❌ [comment] Supabase 저장 생략 — memo_id 해석 실패:", resolveErr);
        } else {
          const { error } = await supabase.from("comments").insert([
            {
              memo_id: memoUuid,
              user_id,
              commenter_id,
              sender,
              content: text,
            },
          ]);

          if (error) {
            logSupabaseErr("[comment] comments insert", error);
          } else {
            console.log("✅ [comment] comment saved memo_id(uuid)=", memoUuid);
          }
        }
      } catch (sbErr) {
        console.log("❌ [comment] Supabase 저장 중 예외(응답은 정상 반환):", sbErr?.message || sbErr);
        if (sbErr?.stack) console.log(sbErr.stack);
      }
    }

    res.json({ text });
    } finally {
      releaseDeepSeekSlot();
    }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const cause = e && e.cause != null ? e.cause : null;
    const causeMsg =
      cause && typeof cause === "object" && typeof cause.message === "string"
        ? cause.message
        : "";
    const combined = `${msg} ${causeMsg}`.trim();
    console.error("[ai-server] POST /comment error:", combined);
    if (e && e.stack) console.error(e.stack);
    if (e && e.name === "AbortError") {
      return res.status(504).json({ text: "요청 시간이 초과되었습니다." });
    }
    if (
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket|certificate|timed out|TTFB|ECONN/i.test(
        combined
      )
    ) {
      return res.status(502).json({
        text: "AI 서버 연결이 불안정합니다. 잠시 후 다시 시도해 주세요.",
      });
    }
    res.status(500).json({ text: "server error" });
  }
}

// 댓글러 XP/잠금/즐겨찾기 — 앱 `GET /api/commenter-states/:userId`
async function handleCommenterStatesGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("commenter_state")
      .select("commenter_id, exp, level, is_unlocked, is_favorite, user_id")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ [commenter-states]", error?.message || error);
      return res.json([]);
    }
    res.json(data || []);
  } catch (e) {
    console.log("[commenter-states]", e);
    res.json([]);
  }
}

app.get("/api/commenter-states/:userId", handleCommenterStatesGet);
app.get("/commenter-states/:userId", handleCommenterStatesGet);

// 댓글러 상태 upsert — `handleCommenterStatePost` (아래 POST `/api/commenter-state` · `/commenter-state`).
async function handleCommenterStatePost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    if (!user_id || !commenter_id) {
      return res.status(400).json({ ok: false, error: "user_id, commenter_id 필요" });
    }

    const exp = readInt(req.body, "exp", 0);
    const level = readInt(req.body, "level", 1);
    const is_unlocked = readBool(req.body, "is_unlocked");
    const is_favorite = readBool(req.body, "is_favorite");

    const row = {
      user_id,
      commenter_id,
      exp: Math.max(0, exp),
      level: Math.max(1, level),
      is_unlocked,
      is_favorite,
    };

    const { error } = await supabase.from("commenter_state").upsert([row], {
      onConflict: "user_id,commenter_id",
    });

    if (error) {
      logSupabaseErr("[commenter-state] upsert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    console.log("✅ [commenter-state] upsert", user_id, commenter_id);
    return res.json({ ok: true });
  } catch (e) {
    console.log("[commenter-state]", e);
    return res.status(500).json({ ok: false });
  }
}

// POST 별칭: 동일 핸들러를 `/api/*` 와 루트 경로에 각각 한 번만 등록
app.post("/api/comment", handleAiCommentPost);
app.post("/comment", handleAiCommentPost);

app.post("/api/comment-save", handleCommentSave);
app.post("/comment-save", handleCommentSave);

app.post("/api/commenter-state", handleCommenterStatePost);
app.post("/commenter-state", handleCommenterStatePost);

// 커스텀 댓글러 프롬프트 — 앱 `POST /api/custom-prompt` · 배포별칭 `POST /api/custom-prompts`
async function handleCustomPromptPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const prompt = readString(req.body, "prompt");
    if (!user_id || !commenter_id || !prompt) {
      return res.status(400).json({ ok: false, error: "user_id, commenter_id, prompt 필요" });
    }

    const row = {
      user_id,
      commenter_id,
      prompt,
      updated_at: new Date().toISOString(),
    };

    let { error } = await supabase
      .from("custom_prompts")
      .upsert(row, { onConflict: "user_id,commenter_id" });

    if (error) {
      logSupabaseErr("[custom-prompt] upsert (retry delete+insert)", error);
      await supabase
        .from("custom_prompts")
        .delete()
        .eq("user_id", user_id)
        .eq("commenter_id", commenter_id);
      const ins = await supabase.from("custom_prompts").insert([row]);
      error = ins.error;
    }

    if (error) {
      logSupabaseErr("[custom-prompt] save failed", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.log("[custom-prompt]", e);
    return res.status(500).json({ ok: false });
  }
}

app.post("/api/custom-prompt", handleCustomPromptPost);
app.post("/api/custom-prompts", handleCustomPromptPost);
app.post("/custom-prompt", handleCustomPromptPost);
app.post("/custom-prompts", handleCustomPromptPost);

// 구버전 `GET /api/custom-prompts?user_id=` — `:userId` 라우트보다 먼저 등록
async function handleCustomPromptsQueryGet(req, res) {
  try {
    const raw = req.query && req.query.user_id;
    const userId =
      typeof raw === "string"
        ? decodeURIComponent(raw).trim()
        : Array.isArray(raw) && typeof raw[0] === "string"
          ? decodeURIComponent(raw[0]).trim()
          : "";
    if (!userId) {
      return res.status(400).json({ error: "user_id required" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const { data, error } = await supabase
      .from("custom_prompts")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ [custom-prompts ?user_id]", error?.message || error);
      return res.json([]);
    }
    res.json(data || []);
  } catch (e) {
    console.log("[custom-prompts query]", e);
    res.json([]);
  }
}

app.get("/api/custom-prompts", handleCustomPromptsQueryGet);
app.get("/custom-prompts", handleCustomPromptsQueryGet);

// 앱 `GET /api/custom-prompts/:userId` — [game_cloud_sync] gameCloudFetchCustomPrompts
async function handleCustomPromptsByUserGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("custom_prompts")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ [custom-prompts]", error?.message || error);
      return res.json([]);
    }
    res.json(data || []);
  } catch (e) {
    console.log("[custom-prompts]", e);
    res.json([]);
  }
}

app.get("/api/custom-prompts/:userId", handleCustomPromptsByUserGet);
app.get("/custom-prompts/:userId", handleCustomPromptsByUserGet);

// 쿠키 거래 1건 — 앱 `POST /api/cookie-tx`
async function handleCookieTxPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "user_id 필요" });
    }

    const deltaRaw = req.body && req.body.delta;
    const delta =
      typeof deltaRaw === "number" && Number.isFinite(deltaRaw)
        ? Math.trunc(deltaRaw)
        : parseInt(String(deltaRaw || "").trim(), 10);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: "delta 필요(0 제외)" });
    }

    const reason = readString(req.body, "reason") || "unknown";
    const platformRaw = readString(req.body, "platform");
    const platform = platformRaw || null;

    const { error } = await supabase.from("cookie_transactions").insert([
      {
        user_id,
        delta,
        reason,
        platform,
      },
    ]);

    if (error) {
      logSupabaseErr("[cookie-tx] insert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[cookie-tx]", e);
    return res.status(500).json({ ok: false });
  }
}

app.post("/api/cookie-tx", handleCookieTxPost);
app.post("/cookie-tx", handleCookieTxPost);

// 쿠키 잔액(SUM) — 앱 `GET /api/cookie-balance/:userId`
async function handleCookieBalanceGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ balance: 0, count: 0 });

    const { data, error } = await supabase
      .from("cookie_transactions")
      .select("delta")
      .eq("user_id", userId);

    if (error) {
      logSupabaseErr("[cookie-balance]", error);
      return res.status(500).json({ error: error.message });
    }

    const rows = data || [];
    let balance = 0;
    for (const r of rows) {
      balance += Number(r.delta) || 0;
    }
    res.json({ balance, count: rows.length });
  } catch (e) {
    console.log("[cookie-balance]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.get("/api/cookie-balance/:userId", handleCookieBalanceGet);
app.get("/cookie-balance/:userId", handleCookieBalanceGet);

// 재설치·복원용 — 앱 GET 스냅샷
async function handleCommentsListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json([]);

    res.json(data || []);
  } catch (e) {
    console.log("[comments-list]", e);
    res.status(500).json([]);
  }
}

app.get("/api/comments/:userId", handleCommentsListGet);
app.get("/comments/:userId", handleCommentsListGet);

async function handleChatMessagesListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json([]);

    res.json(data || []);
  } catch (e) {
    console.log("[chat-messages-list]", e);
    res.status(500).json([]);
  }
}

app.get("/api/chat-messages/:userId", handleChatMessagesListGet);
app.get("/chat-messages/:userId", handleChatMessagesListGet);

async function handleCookieTransactionsListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("cookie_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json([]);

    res.json(data || []);
  } catch (e) {
    console.log("[cookie-transactions-list]", e);
    res.status(500).json([]);
  }
}

app.get("/api/cookie-transactions/:userId", handleCookieTransactionsListGet);
app.get("/cookie-transactions/:userId", handleCookieTransactionsListGet);

// 1:1 채팅 메시지 — 앱 `POST /api/chat/message` · 별칭 `POST /api/chat-message`
// Flutter(game_cloud_sync): session_key, commenter_id, sender, content
// GPT 스펙(/api/chat-message): user_id, session_key, role, content → sender=role, commenter_id=session_key(또는 body)
async function handleChatMessagePost(req, res, opts) {
  const requireSessionKey = opts && opts.requireSessionKey;
  /** GPT 스펙 경로만 session_key·role 컬럼까지 넣음(테이블에 컬럼 없으면 앱 경로는 4필드만 유지). */
  const extendRow = opts && opts.extendRow;
  try {
    console.log("📩 chat message body keys:", req.body && Object.keys(req.body));
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const content = readString(req.body, "content");
    const session_key = readString(req.body, "session_key");
    const role = readString(req.body, "role");
    const commenter_id = readString(req.body, "commenter_id");
    const sender = readString(req.body, "sender");

    if (!user_id || !content) {
      return res.status(400).json({ ok: false, error: "user_id, content 필요" });
    }
    if (requireSessionKey && !session_key) {
      return res.status(400).json({ ok: false, error: "session_key 필요" });
    }

    const senderOut = (sender || role || "user").trim() || "user";
    const commenterOut = (commenter_id || session_key).trim();
    if (!commenterOut) {
      return res
        .status(400)
        .json({ ok: false, error: "commenter_id 또는 session_key 필요" });
    }

    const row = {
      user_id,
      commenter_id: commenterOut,
      sender: senderOut,
      content,
    };
    if (extendRow) {
      if (session_key) row.session_key = session_key;
      if (role) row.role = role;
    }

    const { error } = await supabase.from("chat_messages").insert([row]);

    if (error) {
      logSupabaseErr("[chat/message] insert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[chat/message]", e);
    return res.status(500).json({ ok: false });
  }
}


app.get("/api/memos", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error });

  res.json(data || []);
});

app.get("/api/comments-by-memo/:memoId", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { memoId } = req.params;

  let memoUuid = memoId;

  if (!isUuid(memoId)) {
    const { data } = await supabase
      .from("memos")
      .select("id")
      .eq("local_id", memoId)
      .limit(1)
      .single();

    if (!data) return res.json([]);

    memoUuid = data.id;
  }

  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("memo_id", memoUuid)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error });

  res.json(data || []);
});


app.post("/api/chat/message", (req, res) =>
  handleChatMessagePost(req, res, { requireSessionKey: false, extendRow: false }),
);
app.post("/api/chat-message", (req, res) =>
  handleChatMessagePost(req, res, { requireSessionKey: true, extendRow: true }),
);
app.post("/chat-message", (req, res) =>
  handleChatMessagePost(req, res, { requireSessionKey: true, extendRow: true }),
);

const PORT = Number(process.env.PORT) || 3000;

logSupabaseInit();

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
