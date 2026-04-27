```js
"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

// =========================
// CONFIG
// =========================
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
const FETCH_TIMEOUT_MS = 25000;

// 🔥 버전
const SERVER_REV = "v17-commenter-state-fixed";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =========================
// Supabase
// =========================
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  return createClient(url, key);
}

// =========================
// health
// =========================
app.get("/health", (_req, res) => {
  res.json({ ok: true, rev: SERVER_REV });
});

// =========================
// memo
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

    res.json({ ok: true, id: data.id });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// comment 생성
// =========================
app.post("/comment", async (req, res) => {
  try {
    const supabase = getSupabase();
    const { prompt, memo_id, user_id, commenter_id, sender } = req.body;

    const payload = JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: String(prompt || "")
        }
      ]
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let text = "";

    try {
      const dsRes = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.DEEPSEEK_API_KEY,
          "Content-Type": "application/json"
        },
        body: payload,
        signal: controller.signal
      });

      const json = await dsRes.json();
      text = json?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      console.log("deepseek error:", e);
    } finally {
      clearTimeout(timer);
    }

    if (!text) text = "응답 실패";

    if (supabase && memo_id) {
      await supabase.from("comments").insert([
        {
          memo_id,
          user_id,
          commenter_id,
          sender: sender || "commenter",
          content: text
        }
      ]);
    }

    res.json({ text });
  } catch {
    res.status(500).json({ text: "server error" });
  }
});

// =========================
// chat 저장
// =========================
app.post("/api/chat/message", async (req, res) => {
  try {
    const supabase = getSupabase();
    const { user_id, commenter_id, sender, content } = req.body;

    if (!user_id || !commenter_id || !content) {
      return res.status(400).json({ error: "missing fields" });
    }

    await supabase.from("chat_messages").insert([
      { user_id, commenter_id, sender, content }
    ]);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// cookie tx
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  try {
    const supabase = getSupabase();
    const { user_id, delta, reason, platform } = req.body;

    if (!user_id || delta === undefined) {
      return res.status(400).json({ error: "invalid request" });
    }

    await supabase.from("cookie_transactions").insert([
      { user_id, delta, reason, platform }
    ]);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// cookie balance
// =========================
app.get("/api/cookie-balance/:userId", async (req, res) => {
  try {
    const supabase = getSupabase();
    const userId = req.params.userId;

    const { data } = await supabase
      .from("cookie_transactions")
      .select("delta")
      .eq("user_id", userId);

    const balance = (data || []).reduce(
      (sum, r) => sum + (r.delta || 0),
      0
    );

    res.json({ balance });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// 🔥 commenter state 저장
// =========================
app.post("/api/commenter-state", async (req, res) => {
  try {
    const supabase = getSupabase();

    const {
      user_id,
      commenter_id,
      exp = 0,
      level = 1,
      is_unlocked = false,
      is_favorite = false
    } = req.body;

    if (!user_id || !commenter_id) {
      return res.status(400).json({ error: "missing fields" });
    }

    const { error } = await supabase.from("commenter_state").upsert(
      [
        {
          user_id,
          commenter_id,
          exp,
          level,
          is_unlocked,
          is_favorite,
          updated_at: new Date()
        }
      ],
      { onConflict: "user_id,commenter_id" }
    );

    if (error) {
      console.log("commenter_state error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// 🔥 commenter state 조회
// =========================
app.get("/api/commenter-state/:userId", async (req, res) => {
  try {
    const supabase = getSupabase();
    const userId = req.params.userId;

    const { data } = await supabase
      .from("commenter_state")
      .select("*")
      .eq("user_id", userId);

    res.json(data || []);
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// start
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});
```