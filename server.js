"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const SERVER_REV = "v39-json-fix";

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
// COMMENT (핵심 수정 완료)
// =========================
async function handleComment(req, res) {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "no prompt" });
    }

    console.log("[POST comment]");

    res.json({
      choices: [
        {
          message: {
            // 🔥 JSON.stringify 제거
            content: {
              comments: [
                { name: "도혁", text: "지금 시작이면 방향 잡는 게 먼저다\n작게라도 움직여라" },
                { name: "현우", text: "처음이면 불안한 게 정상이다\n호흡부터 정리해라" },
                { name: "유진", text: "이미 시작했다는 게 중요해\n그 흐름 계속 가져가" }
              ]
            }
          }
        }
      ]
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 둘 다 지원
app.post("/comment", handleComment);
app.post("/api/comment", handleComment);

// =========================
// COMMENT SAVE
// =========================
function handleCommentSave(req, res) {
  try {
    console.log("[POST comment-save]", req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/comment-save", handleCommentSave);
app.post("/api/comment-save", handleCommentSave);

// =========================
// COMMENTER STATE
// =========================
function handleCommenterState(req, res) {
  try {
    console.log("[POST commenter-state]", req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/commenter-state", handleCommenterState);
app.post("/api/commenter-state", handleCommenterState);

// =========================
// MEMO SAVE
// =========================
app.post("/api/memo", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { user_id, content, local_id } = req.body;

    const { data, error } = await supabase
      .from("memos")
      .insert([{ user_id, content, local_id }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, id: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// MEMO GET
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
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

// =========================
// MEMO DELETE
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
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});