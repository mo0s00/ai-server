"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const SERVER_REV = "v62-full-save-apis";

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
    supabaseConfigured: !!supabase,
    apis: [
      "POST /api/memo",
      "GET /api/memos/:userId",
      "DELETE /api/memos/:id",
      "POST /api/comment-save",
      "GET /api/comments/:userId",
      "POST /api/commenter-state",
      "GET /api/commenter-state/:userId",
      "GET /api/commenter-states/:userId",
      "POST /api/custom-prompts",
      "GET /api/custom-prompts/:userId",
      "POST /api/chat-message",
      "GET /api/chat-messages/:userId",
      "POST /api/cookie-tx",
      "GET /api/cookie-tx/:userId"
    ]
  });
});

// =========================
// 댓글러 풀
// =========================
const commenterPool = [
  { id: "c01", name: "도혁", style: "현실적이고 직설적으로 말한다." },
  { id: "c02", name: "현우", style: "차분하고 분석적으로 설명한다." },
  { id: "c03", name: "유진", style: "감정적으로 공감하며 말한다." },
  { id: "c04", name: "지훈", style: "냉정하게 핵심만 말한다." },
  { id: "c05", name: "서연", style: "친근하고 부드럽게 말한다." },
  { id: "c06", name: "민준", style: "논리적으로 핵심만 정리한다." }
];

function pickRandomCommenters(n = 3) {
  return [...commenterPool]
    .sort(() => 0.5 - Math.random())
    .slice(0, n);
}

async function callAIForCommenter(prompt, commenter) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
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
// COMMENT AI
// =========================
async function handleComment(req, res) {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "no prompt" });

    const selected = pickRandomCommenters(3);

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
    console.error("[comment error]", e);
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
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { user_id, content, local_id } = req.body;

    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (!content) return res.status(400).json({ ok: false, error: "no content" });

    const { data, error } = await supabase
      .from("memos")
      .insert([{ user_id, content, local_id }])
      .select()
      .single();

    if (error) {
      console.error("[memo save error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, id: data.id, data });
  } catch (e) {
    console.error("[memo save server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// MEMO GET
// =========================
app.get("/api/memos/:userId", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("memos")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[memo get error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json(data || []);
  } catch (e) {
    console.error("[memo get server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// MEMO DELETE
// =========================
app.delete("/api/memos/:id", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { id } = req.params;

    const { error } = await supabase
      .from("memos")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[memo delete error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[memo delete server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// COMMENT SAVE
// comments 메모댓글 저장
// =========================
app.post("/api/comment-save", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { memo_id, user_id, commenter_id, sender, content } = req.body;

    if (!memo_id) return res.status(400).json({ ok: false, error: "no memo_id" });
    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (!content) return res.status(400).json({ ok: false, error: "no content" });

    const { data, error } = await supabase
      .from("comments")
      .insert([
        {
          memo_id,
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
// comments 메모댓글 조회
// =========================
app.get("/api/comments/:userId", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[comments get error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json(data || []);
  } catch (e) {
    console.error("[comments get server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// COMMENTER STATE SAVE
// commenter_state 댓글러 해제/레벨 저장
// =========================
app.post("/api/commenter-state", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const {
      user_id,
      commenter_id,
      exp,
      level,
      is_unlocked,
      is_favorite
    } = req.body;

    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (!commenter_id) return res.status(400).json({ ok: false, error: "no commenter_id" });

    const row = {
      user_id,
      commenter_id,
      updated_at: new Date().toISOString()
    };

    if (exp !== undefined) row.exp = exp;
    if (level !== undefined) row.level = level;
    if (is_unlocked !== undefined) row.is_unlocked = is_unlocked;
    if (is_favorite !== undefined) row.is_favorite = is_favorite;

    const { data, error } = await supabase
      .from("commenter_state")
      .upsert(row, { onConflict: "user_id,commenter_id" })
      .select()
      .single();

    if (error) {
      console.error("[commenter-state save error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[commenter-state server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// COMMENTER STATE GET
// =========================
async function handleGetCommenterState(req, res) {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("commenter_state")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("[commenter-state get error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json(data || []);
  } catch (e) {
    console.error("[commenter-state get server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.get("/api/commenter-state/:userId", handleGetCommenterState);
app.get("/api/commenter-states/:userId", handleGetCommenterState);

// =========================
// CUSTOM PROMPTS SAVE
// custom_prompts 나만의 댓글러 저장
// =========================
app.post("/api/custom-prompts", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const {
      user_id,
      commenter_id,
      prompt,
      name,
      description,
      image_url,
      is_public,
      payload
    } = req.body;

    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (!commenter_id) return res.status(400).json({ ok: false, error: "no commenter_id" });

    const row = {
      user_id,
      commenter_id,
      updated_at: new Date().toISOString()
    };

    if (prompt !== undefined) row.prompt = prompt;
    if (name !== undefined) row.name = name;
    if (description !== undefined) row.description = description;
    if (image_url !== undefined) row.image_url = image_url;
    if (is_public !== undefined) row.is_public = is_public;
    if (payload !== undefined) row.payload = payload;

    const { data, error } = await supabase
      .from("custom_prompts")
      .upsert(row, { onConflict: "user_id,commenter_id" })
      .select()
      .single();

    if (error) {
      console.error("[custom-prompts save error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[custom-prompts server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// CUSTOM PROMPTS GET
// =========================
app.get("/api/custom-prompts/:userId", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("custom_prompts")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("[custom-prompts get error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json(data || []);
  } catch (e) {
    console.error("[custom-prompts get server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// CHAT MESSAGE SAVE
// chat_messages 채팅 저장
// =========================
app.post("/api/chat-message", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const {
      user_id,
      session_key,
      role,
      content,
      commenter_id
    } = req.body;

    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (!content) return res.status(400).json({ ok: false, error: "no content" });

    const row = {
      user_id,
      session_key: session_key || "default",
      role: role || "user",
      content
    };

    if (commenter_id !== undefined) row.commenter_id = commenter_id;

    const { data, error } = await supabase
      .from("chat_messages")
      .insert([row])
      .select()
      .single();

    if (error) {
      console.error("[chat-message save error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[chat-message server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// CHAT MESSAGE GET
// =========================
app.get("/api/chat-messages/:userId", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { userId } = req.params;
    const { session_key } = req.query;

    let query = supabase
      .from("chat_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (session_key) {
      query = query.eq("session_key", session_key);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[chat-messages get error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json(data || []);
  } catch (e) {
    console.error("[chat-messages get server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// COOKIE TX SAVE
// cookie_transactions 코키 사용내역 저장
// =========================
app.post("/api/cookie-tx", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const {
      user_id,
      delta,
      reason,
      platform
    } = req.body;

    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    if (delta === undefined || delta === null) {
      return res.status(400).json({ ok: false, error: "no delta" });
    }

    const { data, error } = await supabase
      .from("cookie_transactions")
      .insert([
        {
          user_id,
          delta,
          reason: reason || null,
          platform: platform || null
        }
      ])
      .select()
      .single();

    if (error) {
      console.error("[cookie-tx save error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[cookie-tx server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// COOKIE TX GET
// =========================
app.get("/api/cookie-tx/:userId", async (req, res) => {
  try {
    const supabase = requireSupabase(res);
    if (!supabase) return;

    const { userId } = req.params;

    const { data, error } = await supabase
      .from("cookie_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[cookie-tx get error]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json(data || []);
  } catch (e) {
    console.error("[cookie-tx get server error]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
  console.log("rev:", SERVER_REV);
});