"use strict";

import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const SERVER_REV = "v40-ai-connected";

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
// AI 호출
// =========================
async function callAI(prompt) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: "너는 현실적인 조언을 하는 댓글러 3명이다. 각자 짧고 다르게 답해."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const data = await res.json();

  return data?.choices?.[0]?.message?.content || "답변 생성 실패";
}

// =========================
// COMMENT (AI 적용)
// =========================
async function handleComment(req, res) {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "no prompt" });
    }

    console.log("[POST comment AI]");

    const aiText = await callAI(prompt);

    const parts = aiText
      .split("\n")
      .map(t => t.trim())
      .filter(t => t.length > 0);

    res.json({
      choices: [
        {
          message: {
            content: {
              comments: [
                { name: "도혁", text: parts[0] || aiText },
                { name: "현우", text: parts[1] || aiText },
                { name: "유진", text: parts[2] || aiText }
              ]
            }
          }
        }
      ]
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

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