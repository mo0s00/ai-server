"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const SERVER_REV = "v26-node-fetch-removed";

// =========================
// CONFIG
// =========================
const MAX_PROMPT_CHARS = Math.max(
  8000,
  Number.parseInt(process.env.MAX_PROMPT_CHARS || "100000", 10) || 100000
);

const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const API_URL =
  process.env.DEEPSEEK_API_URL ||
  "https://api.deepseek.com/v1/chat/completions";
const API_KEY = process.env.DEEPSEEK_API_KEY;

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
// utils
// =========================
function sanitizePrompt(text) {
  if (!text) return "";
  return String(text)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncatePrompt(text) {
  if (text.length > MAX_PROMPT_CHARS) {
    console.log("[truncate]", text.length);
    return text.slice(0, MAX_PROMPT_CHARS) + "\n\n[…truncated]";
  }
  return text;
}

function extractText(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c.trim();

  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .join(" ")
      .trim();
  }

  return "";
}

// =========================
// health
// =========================
app.get("/health", (_req, res) => {
  res.json({ ok: true, rev: SERVER_REV });
});

// =========================
// 🔥 COMMENT (핵심)
// =========================
app.post("/comment", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ text: "API KEY missing" });
    }

    let { prompt, temperature = 0.7, max_tokens = 300 } = req.body;

    if (!prompt) {
      return res.status(400).json({ text: "no prompt" });
    }

    prompt = sanitizePrompt(prompt);
    prompt = truncatePrompt(prompt);

    let payload;
    try {
      payload = JSON.stringify({
        model: MODEL,
        temperature,
        max_tokens,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (e) {
      return res.status(400).json({ text: "stringify fail" });
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: payload,
    });

    const data = await response.json();

    const msg = data?.choices?.[0]?.message;
    const text = extractText(msg);

    if (!text) {
      return res.status(500).json({ text: "empty response" });
    }

    res.json({ text });
  } catch (e) {
    console.error("[comment error]", e);
    res.status(500).json({ text: "server error" });
  }
});

// =========================
// COOKIE TX
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { user_id, delta, reason, platform } = req.body;

    if (!user_id || delta === undefined) {
      return res.status(400).json({ error: "invalid" });
    }

    const { error } = await supabase
      .from("cookie_transactions")
      .insert([{ user_id, delta, reason, platform }]);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// MEMO
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
// COMMENT SAVE
// =========================
app.post("/api/comment-save", async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const { user_id, memo_id, commenter_id, content, sender } = req.body;

    const { data: memo } = await supabase
      .from("memos")
      .select("id")
      .eq("user_id", user_id)
      .eq("local_id", memo_id)
      .single();

    if (!memo) {
      return res.status(400).json({ error: "memo resolve fail" });
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

    if (error) return res.status(500).json({ error: error.message });

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