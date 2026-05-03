"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const SERVER_REV = "v61-fixed-memo-delete-upsert-comments";

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

// =========================
// health
// =========================
app.get("/health", (_req, res) => {
  const supabase = getSupabase();
  res.json({
    ok: true,
    rev: SERVER_REV,
    supabaseConfigured: !!supabase,
  });
});

// =========================
// MEMO SAVE (🔥 upsert로 수정)
// =========================
app.post("/api/memo", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { user_id, content, local_id } = req.body;

    const { data, error } = await supabase
      .from("memos")
      .upsert(
        [{ user_id, content, local_id }],
        { onConflict: "local_id" }
      )
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, id: data.id });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// MEMO GET (최신 30개 제한)
// =========================
app.get("/api/memos/:userId", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("memos")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// MEMO DELETE (정상)
// =========================
app.delete("/api/memos/:id", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { id } = req.params;

    const { error } = await supabase
      .from("memos")
      .delete()
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// COMMENTS GET (🔥 추가)
// =========================
app.get("/api/comments/:userId", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});