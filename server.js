"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SERVER_REV = "v21-api-memo-comment-save-alias";

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
      "POST /api/cookie-tx"
    ]
  });
});

// =========================
// COOKIE TX
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  try {
    console.log("REQ:", req.body);

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
      console.error("INSERT ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("SERVER ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =========================
// MEMO SAVE
// =========================
app.post("/api/memo", async (req, res) => {
  try {
    console.log("📩 memo req:", req.body);

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
      console.error("MEMO INSERT ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error("MEMO SERVER ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =========================
// COMMENT SAVE
// =========================
app.post("/api/comment-save", async (req, res) => {
  try {
    console.log("📩 comment req:", req.body);

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
      console.error("❌ memo resolve failed:", memoError);
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
      console.error("COMMENT INSERT ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("COMMENT SERVER ERROR:", e);
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