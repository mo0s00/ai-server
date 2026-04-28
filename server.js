"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SERVER_REV = "v22-add-missing-apis";

// =========================
// Supabase
// =========================
function getSupabase() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();

  console.log("SUPABASE_URL:", url);
  console.log("SUPABASE_KEY:", key ? "OK" : "MISSING");

  if (!url || !key) return null;

  return createClient(url, key);
}

// =========================
// health
// =========================
app.get("/health", (_req, res) => {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  res.json({
    ok: true,
    rev: SERVER_REV,
    supabaseConfigured: !!(url && key),
    supabasePostPaths: [
      "POST /api/memo",
      "POST /api/comment-save",
      "POST /api/cookie-tx",
      "POST /api/custom-prompts",
      "POST /api/commenter-state",
      "POST /api/chat-message"
    ]
  });
});

// =========================
// COOKIE TX
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    const { user_id, delta, reason, platform } = req.body;

    if (!user_id || delta === undefined) {
      return res.status(400).json({ error: "invalid request" });
    }

    const { error } = await supabase.from("cookie_transactions").insert([
      { user_id, delta, reason, platform },
    ]);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// MEMO SAVE
// =========================
app.post("/api/memo", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    const { user_id, content, local_id } = req.body;

    if (!user_id || !content) {
      return res.status(400).json({ error: "invalid request" });
    }

    const { data, error } = await supabase
      .from("memos")
      .insert([{ user_id, content, local_id }])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, id: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// COMMENT SAVE
// =========================
app.post("/api/comment-save", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    const { user_id, memo_id, commenter_id, content, sender } = req.body;

    if (!user_id || !memo_id) {
      return res.status(400).json({ error: "invalid request" });
    }

    const { data: memo, error: memoError } = await supabase
      .from("memos")
      .select("id")
      .eq("user_id", user_id)
      .eq("local_id", memo_id)
      .single();

    if (memoError || !memo) {
      return res.status(400).json({ error: "memo resolve failed" });
    }

    const { error } = await supabase.from("comments").insert([
      {
        memo_id: memo.id,
        user_id,
        commenter_id,
        content,
        sender,
      },
    ]);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// CUSTOM PROMPTS
// =========================
app.post("/api/custom-prompts", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    const { user_id, commenter_id, prompt } = req.body;

    if (!user_id || !commenter_id || !prompt) {
      return res.status(400).json({ error: "invalid request" });
    }

    const { error } = await supabase
      .from("custom_prompts")
      .insert([{ user_id, commenter_id, prompt }]);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// COMMENTER STATE
// =========================
app.post("/api/commenter-state", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    const { user_id, commenter_id, exp, level, is_unlocked } = req.body;

    if (!user_id || !commenter_id) {
      return res.status(400).json({ error: "invalid request" });
    }

    const { error } = await supabase
      .from("commenter_state")
      .upsert(
        [{ user_id, commenter_id, exp, level, is_unlocked }],
        { onConflict: ["user_id", "commenter_id"] }
      );

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// CHAT MESSAGE
// =========================
app.post("/api/chat-message", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    const { user_id, session_key, role, content } = req.body;

    if (!user_id || !content) {
      return res.status(400).json({ error: "invalid request" });
    }

    const { error } = await supabase
      .from("chat_messages")
      .insert([{ user_id, session_key, role, content }]);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});