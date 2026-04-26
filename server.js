"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
const FETCH_TIMEOUT_MS = 25000;
const SERVER_REV = "v16-cookie-restore";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =========================
// 🔧 Supabase 연결
// =========================
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// =========================
// 🔍 health
// =========================
app.get("/health", (_req, res) => {
  res.json({ ok: true, rev: SERVER_REV });
});

// =========================
// 📌 메모 저장
// =========================
app.post("/memo", async (req, res) => {
  try {
    const supabase = getSupabase();
    const { user_id, content, local_id } = req.body;

    const { data, error } = await supabase
      .from("memos")
      .insert([{ user_id, content, local_id }])
      .select("id")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    console.log("✅ memo saved:", data.id);
    res.json({ ok: true, id: data.id });

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// 📌 댓글 생성 + 저장
// =========================
app.post("/comment", async (req, res) => {
  try {
    const supabase = getSupabase();

    let { prompt, memo_id, user_id, commenter_id, sender } = req.body;

    const safePrompt = prompt || "";
    const memo_id_safe = memo_id || "";

    console.log("📩 comment req:", req.body);

    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: safePrompt }]
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let text = "";

    try {
      const dsRes = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: payload,
        signal: controller.signal
      });

      const json = await dsRes.json();
      text = json?.choices?.[0]?.message?.content?.trim() || "";

    } finally {
      clearTimeout(timer);
    }

    if (!text) text = "응답 생성 실패";

    let finalMemoId = memo_id;

    if (!memo_id_safe.includes("-") && supabase) {
      const { data } = await supabase
        .from("memos")
        .select("id")
        .eq("user_id", user_id)
        .eq("local_id", memo_id)
        .single();

      if (data) finalMemoId = data.id;
    }

    if (supabase && finalMemoId) {
      await supabase.from("comments").insert([{
        memo_id: finalMemoId,
        user_id,
        commenter_id,
        sender: sender || "commenter",
        content: text
      }]);
    }

    res.json({ text });

  } catch (e) {
    res.status(500).json({ text: "server error" });
  }
});

// =========================
// 📌 채팅 저장
// =========================
app.post("/api/chat/message", async (req, res) => {
  try {
    const supabase = getSupabase();

    const { user_id, commenter_id, sender, content } = req.body;

    if (!user_id || !commenter_id || !content) {
      return res.status(400).json({ error: "missing fields" });
    }

    await supabase.from("chat_messages").insert([{
      user_id,
      commenter_id,
      sender: sender || "user",
      content
    }]);

    console.log("✅ chat saved");
    res.json({ ok: true });

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// 🍪 쿠키 거래 기록 저장
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  try {
    const supabase = getSupabase();

    const { user_id, delta, reason, platform } = req.body;

    if (!user_id || delta === undefined) {
      return res.status(400).json({ error: "invalid request" });
    }

    await supabase.from("cookie_transactions").insert([{
      user_id,
      delta,
      reason: reason || "unknown",
      platform: platform || "app"
    }]);

    console.log("✅ cookie tx saved");

    res.json({ ok: true });

  } catch (e) {
    console.log("❌ cookie tx error:", e);
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// 🍪 쿠키 잔액 조회 (복구 핵심)
// =========================
app.get("/api/cookie-balance/:userId", async (req, res) => {
  try {
    const supabase = getSupabase();
    const userId = req.params.userId;

    const { data, error } = await supabase
      .from("cookie_transactions")
      .select("delta")
      .eq("user_id", userId);

    if (error) return res.status(500).json({ error: error.message });

    const balance = (data || []).reduce((sum, row) => {
      return sum + (row.delta || 0);
    }, 0);

    console.log("🍪 balance:", balance);

    res.json({ balance });

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// 🚀 서버 실행
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});