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
// 댓글러 풀 (임시)
// =========================
const commenterPool = [
  { id: "c01", name: "도혁", style: "현실적이고 직설적으로 말한다." },
  { id: "c02", name: "현우", style: "차분하고 분석적으로 설명한다." },
  { id: "c03", name: "유진", style: "감정적으로 공감하며 말한다." },
  { id: "c04", name: "지훈", style: "냉정하게 핵심만 말한다." },
  { id: "c05", name: "서연", style: "친근하고 부드럽게 말한다." },
  { id: "c06", name: "민준", style: "논리적으로 핵심만 정리한다." }
];

// =========================
// 랜덤 댓글러 선택
// =========================
function pickRandomCommenters(n = 3) {
  return [...commenterPool]
    .sort(() => 0.5 - Math.random())
    .slice(0, n);
}

// =========================
// AI 호출 (1명)
// =========================
async function callAIForCommenter(prompt, commenter) {
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
          content: `
너는 "${commenter.name}"이다.
성격: ${commenter.style}

짧고 자연스럽게 한 문단으로 답해.
JSON 쓰지 마.
`
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const data = await res.json();

  return data?.choices?.[0]?.message?.content || "답변 실패";
}

// =========================
// COMMENT (핵심)
// =========================
async function handleComment(req, res) {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "no prompt" });

    console.log("[POST comment multi AI]");

    const selected = pickRandomCommenters(3);

    // 🔥 병렬 AI 호출
    const results = await Promise.all(
      selected.map(async (c) => {
        const text = await callAIForCommenter(prompt, c);
        return {
          commenter_id: c.id,
          name: c.name,
          text
        };
      })
    );

    // 🔥 Flutter 호환 (문자열 JSON)
    res.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              comments: results
            })
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