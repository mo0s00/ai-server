"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
const FETCH_TIMEOUT_MS = 25000;
const SERVER_REV = "v13-final-clean";

const app = express();
app.use(express.json({ limit: "1mb" }));

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, rev: SERVER_REV });
});


// =========================
// 📌 메모 저장 (local_id 포함)
// =========================
app.post("/memo", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const { user_id, content, local_id } = req.body;

    const { data, error } = await supabase
      .from("memos")
      .insert([{ user_id, content, local_id }])
      .select("id")
      .single();

    if (error) {
      console.log("❌ memo save error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log("✅ memo saved:", data.id, "local_id:", local_id);

    res.json({ ok: true, id: data.id });

  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "server error" });
  }
});


// =========================
// 📌 메모 목록
// =========================
app.get("/memos/:userId", async (req, res) => {
  try {
    const supabase = getSupabase();
    const userId = req.params.userId;

    const { data, error } = await supabase
      .from("memos")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});


// =========================
// 📌 댓글 생성 + 저장 (UUID 변환 포함)
// =========================
app.post("/comment", async (req, res) => {
  try {
    const supabase = getSupabase();

    const {
      prompt,
      memo_id,
      user_id,
      commenter_id,
      sender
    } = req.body;

    // 🔥 AI 호출
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }]
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let dsRes;
    try {
      dsRes = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: payload,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const json = await dsRes.json();

    const text =
      json?.choices?.[0]?.message?.content?.trim() || "";

    if (!text) {
      return res.status(500).json({ text: "댓글 생성 실패" });
    }

    // 🔥 핵심: local_id → UUID 변환
    let finalMemoId = memo_id;

    if (!memo_id.includes("-")) {
      console.log("👉 resolving memo:", memo_id, user_id);

      const { data, error } = await supabase
        .from("memos")
        .select("id")
        .eq("user_id", user_id)
        .eq("local_id", memo_id)
        .single();

      if (error || !data) {
        console.log("❌ memo resolve failed:", error);
        return res.status(500).json({ error: "memo resolve failed" });
      }

      finalMemoId = data.id;
      console.log("✅ resolved UUID:", finalMemoId);
    }

    // 🔥 저장
    const { error } = await supabase.from("comments").insert([
      {
        memo_id: finalMemoId,
        user_id,
        commenter_id,
        sender: sender || "commenter",
        content: text
      }
    ]);

    if (error) {
      console.log("❌ comment save error:", error.message);
    } else {
      console.log("✅ comment saved");
    }

    res.json({ text });

  } catch (e) {
    console.log(e);
    res.status(500).json({ text: "server error" });
  }
});


// =========================
// 🚀 서버 실행
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});