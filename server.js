"use strict";

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SERVER_REV = "v19-fix";

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
// START
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("server running on " + PORT);
});