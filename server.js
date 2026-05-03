"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const SERVER_REV = "v63-comment-fix"; // T: 버전 변경

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

  if (!url || !key) return null;
  return createClient(url, key);
}

function requireSupabase(res) {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: "no supabase" });
    return null;
  }
  return supabase;
}

// =========================
// health
// =========================
app.get("/health", (_req, res) => {
  const supabase = getSupabase();
  res.json({
    ok: true,
    rev: SERVER_REV,
    supabaseConfigured: !!supabase
  });
});

// =========================
// MEMO SAVE
// =========================
app.post("/api/memo", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { user_id, content, local_id } = req.body;

    const { data, error } = await supabase
      .from("memos")
      .insert([{ user_id, content, local_id }])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// MEMO GET
// =========================
app.get("/api/memos/:userId", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { userId } = req.params;

  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json(data || []);
});

// =========================
// COMMENT SAVE (🔥 핵심 수정)
// =========================
app.post("/api/comment-save", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { memo_id, user_id, commenter_id, sender, content } = req.body;

    if (!memo_id) return res.status(400).json({ ok: false, error: "no memo_id" });
    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (!content) return res.status(400).json({ ok: false, error: "no content" });

    // 🔥 핵심: local_id → uuid 변환
    const { data: memo, error: memoError } = await supabase
      .from("memos")
      .select("id")
      .eq("local_id", memo_id)
      .single();

    if (memoError || !memo) {
      console.error("[comment-save memo lookup error]", memoError);
      return res.status(400).json({
        ok: false,
        error: "memo not found: " + memo_id
      });
    }

    const realMemoId = memo.id;

    const { data, error } = await supabase
      .from("comments")
      .insert([
        {
          memo_id: realMemoId,
          user_id,
          commenter_id: commenter_id || null,
          sender: sender || "commenter",
          content
        }
      ])
      .select()
      .single();

    if (error) {
      console.error("[comment-save error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[comment-save server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// COMMENT GET
// =========================
app.get("/api/comments/:userId", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { userId } = req.params;

  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json(data || []);
});

// =========================
// COMMENTER STATE
// =========================
app.post("/api/commenter-state", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { user_id, commenter_id, exp, level, is_unlocked, is_favorite } = req.body;

  const { data, error } = await supabase
    .from("commenter_state")
    .upsert({
      user_id,
      commenter_id,
      exp,
      level,
      is_unlocked,
      is_favorite,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,commenter_id" })
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, data });
});

// =========================
// CHAT MESSAGE
// =========================
app.post("/api/chat-message", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { user_id, session_key, role, content, commenter_id } = req.body;

  const { data, error } = await supabase
    .from("chat_messages")
    .insert([{
      user_id,
      session_key,
      role,
      content,
      commenter_id
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, data });
});

// =========================
// COOKIE
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { user_id, delta, reason, platform } = req.body;

  const { data, error } = await supabase
    .from("cookie_transactions")
    .insert([{ user_id, delta, reason, platform }])
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, data });
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
  console.log("rev:", SERVER_REV);
});