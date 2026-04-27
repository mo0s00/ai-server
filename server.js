"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SERVER_REV = "v18-full";

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
// 🍪 COOKIE TX
// =========================
app.post("/api/cookie-tx", async (req, res) => {
try {
const supabase = getSupabase();
const { user_id, delta, reason, platform } = req.body;

```
if (!user_id || delta === undefined) {
  return res.status(400).json({ error: "invalid request" });
}

await supabase.from("cookie_transactions").insert([
  { user_id, delta, reason, platform }
]);

res.json({ ok: true });
```

} catch {
res.status(500).json({ error: "server error" });
}
});

// =========================
// 🍪 COOKIE BALANCE
// =========================
app.get("/api/cookie-balance/:userId", async (req, res) => {
try {
const supabase = getSupabase();
const userId = req.params.userId;

```
const { data } = await supabase
  .from("cookie_transactions")
  .select("delta")
  .eq("user_id", userId);

const balance = (data || []).reduce(
  (sum, r) => sum + (r.delta || 0),
  0
);

res.json({ balance });
```

} catch {
res.status(500).json({ error: "server error" });
}
});

// =========================
// 👤 COMMENTER STATE 저장
// =========================
app.post("/api/commenter-state", async (req, res) => {
try {
const supabase = getSupabase();

```
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
  return res.status(500).json({ error: error.message });
}

res.json({ ok: true });
```

} catch {
res.status(500).json({ error: "server error" });
}
});

// =========================
// 👤 COMMENTER STATE 조회
// =========================
app.get("/api/commenter-state/:userId", async (req, res) => {
try {
const supabase = getSupabase();
const userId = req.params.userId;

```
const { data } = await supabase
  .from("commenter_state")
  .select("*")
  .eq("user_id", userId);

res.json(data || []);
```

} catch {
res.status(500).json({ error: "server error" });
}
});

// =========================
// 📝 MEMO 저장
// =========================
app.post("/memo", async (req, res) => {
try {
const supabase = getSupabase();
const { user_id, content, local_id } = req.body;

```
const { data, error } = await supabase
  .from("memos")
  .insert([{ user_id, content, local_id }])
  .select("id")
  .single();

if (error) return res.status(500).json({ error: error.message });

res.json({ ok: true, id: data.id });
```

} catch {
res.status(500).json({ error: "server error" });
}
});

// =========================
// 💬 COMMENT 생성 (AI 없이 테스트용)
// =========================
app.post("/comment", async (req, res) => {
try {
const { prompt } = req.body;

```
if (!prompt) {
  return res.json({ text: "빈 요청" });
}

res.json({ text: "응답: " + prompt.slice(0, 30) });
```

} catch {
res.status(500).json({ text: "server error" });
}
});

// =========================
// 💬 CHAT 저장
// =========================
app.post("/api/chat/message", async (req, res) => {
try {
const supabase = getSupabase();
const { user_id, commenter_id, sender, content } = req.body;

```
await supabase.from("chat_messages").insert([
  { user_id, commenter_id, sender, content }
]);

res.json({ ok: true });
```

} catch {
res.status(500).json({ error: "server error" });
}
});

// =========================
// 🚀 START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
console.log("server running on " + PORT);
});
