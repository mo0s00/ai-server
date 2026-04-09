"use strict";

const express = require("express");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-3-5-haiku-20241022";
const FETCH_TIMEOUT_MS = 25000;
/** Bump when changing behavior (check with GET /health). */
const SERVER_REV = "v6-garbage-detect-nfkc";

const app = express();
app.use(express.json({ limit: "1mb" }));

process.on("unhandledRejection", (reason) => {
  console.log("[ai-server] unhandledRejection:", reason);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, rev: SERVER_REV, model: MODEL });
});

app.get("/comment", (_req, res) => {
  try {
    res.status(200).json({ text: "" });
  } catch (e) {
    console.log("[ai-server] GET /comment:", e && e.message ? e.message : e);
    res.status(200).json({ text: "" });
  }
});

/** Reject replies that are only a "model: claude-…" line (incl. homoglyphs / ZWSP). */
function isGarbageModelLine(s) {
  if (!s || typeof s !== "string") return false;
  let t = s
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKC")
    .replace(/\uFF1A/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  const expected = `model: ${MODEL}`;
  if (t === expected) return true;
  if (t.toLowerCase() === expected.toLowerCase()) return true;
  const compact = t.replace(/\s/g, "");
  const compactExpected = expected.replace(/\s/g, "");
  if (compact === compactExpected) return true;
  if (/^model\s*:\s*claude-/i.test(t)) return true;
  return false;
}

app.post("/comment", async (req, res) => {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || typeof key !== "string" || !key.trim()) {
      console.log("[ai-server] ANTHROPIC_API_KEY is missing or empty");
      return res.status(503).json({ text: "서버 설정 오류입니다." });
    }

    const prompt = req.body && req.body.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }

    const payload = JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let anthropicRes;
    try {
      anthropicRes = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": key.trim(),
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawText = await anthropicRes.text();
    let data = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        console.log("[ai-server] Anthropic response JSON parse error:", parseErr.message);
        console.log("[ai-server] raw (first 300 chars):", rawText.slice(0, 300));
        return res.status(502).json({ text: "응답을 해석할 수 없습니다." });
      }
    }

    if (!anthropicRes.ok) {
      console.log(
        "[ai-server] Anthropic HTTP",
        anthropicRes.status,
        typeof data === "object" ? JSON.stringify(data).slice(0, 500) : rawText.slice(0, 300)
      );
      const msg =
        (data.error && data.error.message) ||
        data.message ||
        "Anthropic 요청에 실패했습니다.";
      const statusOut = anthropicRes.status >= 500 ? 502 : anthropicRes.status;
      return res.status(statusOut).json({ text: String(msg) });
    }

    console.log("[ai-server] Anthropic ok, raw head:", rawText.slice(0, 400));

    const blocks = Array.isArray(data.content) ? data.content : [];
    const textParts = [];
    for (const b of blocks) {
      if (!b || b.type !== "text" || typeof b.text !== "string") continue;
      const t = b.text.trim();
      if (t) textParts.push(t);
    }
    const text = textParts.join("\n\n").trim();

    if (!text) {
      console.log("[ai-server] No text block in Anthropic response");
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    if (isGarbageModelLine(text)) {
      console.log("[ai-server] rejected garbage model-line reply");
      console.log("[ai-server] full text was:", JSON.stringify(text));
      console.log("[ai-server] codepoints:", [...text].map((c) => c.codePointAt(0)).join(","));
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    return res.status(200).json({ text });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log("[ai-server] POST /comment error:", msg);
    if (e && e.stack) console.log(e.stack);
    if (e && e.name === "AbortError") {
      return res.status(504).json({ text: "요청 시간이 초과되었습니다." });
    }
    return res.status(500).json({ text: "서버 오류가 발생했습니다." });
  }
});

const PORT = Number(process.env.PORT) || 3000;

try {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("server running on " + PORT);
  });
  server.on("error", (err) => {
    console.log("[ai-server] listen error:", err.message);
    process.exit(1);
  });
} catch (e) {
  console.log("[ai-server] failed to start:", e && e.message ? e.message : e);
  process.exit(1);
}
