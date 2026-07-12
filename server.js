"use strict";

import express from "express";
import FormData from "form-data";
import { createClient } from "@supabase/supabase-js";
import { handleIapCookieVerifyPost } from "./iap-cookie.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || "").trim();
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-v4-flash").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
/** OpenAI — TTS·이미지 생성 전용 (스토리채팅·추천·comment는 DeepSeek). */
const OPENAI_TTS_MODEL = "tts-1";
const OPENAI_IMAGE_MODEL = "gpt-image-1";
const OPENAI_IMAGE_QUALITY = "high";
const STORY_IMAGE_SIZE_PORTRAIT = "1024x1536";
const STORY_IMAGE_SIZE_LANDSCAPE = "1536x1024";
const FETCH_TIMEOUT_MS = 25000;
/** Bump when changing behavior (check with GET /health or GET /api/health). */
const SERVER_REV = "story-image-quality-high";

/** 표지·장면 배경 GPT 이미지 — 기본 꺼짐. Render에 `STORY_IMAGE_GENERATION=1` 일 때만 허용. */
function storyImageGenerationEnabled() {
  const v = (process.env.STORY_IMAGE_GENERATION || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let supabaseEnvLogged = false;

function logSupabaseInit() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const hasServiceRole = !!(
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim()
  );
  const hasAnon = !!(process.env.SUPABASE_ANON_KEY && String(process.env.SUPABASE_ANON_KEY).trim());
  console.log("[ai-server] SUPABASE INIT CHECK");
  console.log("[ai-server]   SUPABASE_URL:", url || "(missing or empty)");
  console.log("[ai-server]   SUPABASE_SERVICE_ROLE_KEY:", hasServiceRole ? "OK" : "MISSING");
  console.log("[ai-server]   SUPABASE_ANON_KEY:", hasAnon ? "OK" : "MISSING");
  console.log("[ai-server]   client can start:", url && (hasServiceRole || hasAnon) ? "yes" : "no");
}

function safeJsonForLog(value, maxLen) {
  const n = maxLen === undefined ? 800 : maxLen;
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > n ? s.slice(0, n) + "…" : s;
  } catch (_e) {
    return "[unserializable]";
  }
}

function getSupabase() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();

  if (!supabaseEnvLogged) {
    supabaseEnvLogged = true;
    console.log("[ai-server] getSupabase (first call) SUPABASE_URL:", url || "(empty)");
    console.log(
      "[ai-server] getSupabase (first call) SUPABASE_SERVICE_ROLE_KEY:",
      process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "MISSING"
    );
    console.log(
      "[ai-server] getSupabase (first call) SUPABASE_ANON_KEY:",
      process.env.SUPABASE_ANON_KEY ? "OK" : "MISSING"
    );
  }

  if (!url || !key) return null;
  return createClient(url, key);
}

function requireSupabase(res) {
  const supabase = getSupabase();
  if (!supabase) {
    console.error("[ai-server] Supabase not initialized (missing SUPABASE_URL or key)");
    res.status(500).json({ error: "supabase not configured" });
    return null;
  }
  return supabase;
}

const app = express();
/** 피메모+[검증된 사실] 등 긴 프롬프트 — 1mb 초과 시 express가 본문 파싱 단계에서 실패할 수 있음 */
app.use(express.json({ limit: "30mb" }));

process.on("unhandledRejection", (reason) => {
  console.log("[ai-server] unhandledRejection:", reason);
});

function buildHealthPayload() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();
  return {
    ok: true,
    rev: SERVER_REV,
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    storyProvider: "deepseek",
    storyModel: DEEPSEEK_MODEL,
    deepseekConfigured: !!DEEPSEEK_API_KEY,
    openaiConfigured: !!OPENAI_API_KEY,
    storyImageGeneration: storyImageGenerationEnabled(),
    supabaseConfigured: !!(url && key),
  };
}

app.get("/health", (_req, res) => {
  res.json(buildHealthPayload());
});

app.get("/api/health", (_req, res) => {
  res.json(buildHealthPayload());
});

function readString(body, key) {
  const v = body && body[key];
  return typeof v === "string" ? v.trim() : "";
}

function readInt(body, key, fallback) {
  const v = body && body[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim()) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function readBool(body, key) {
  const v = body && body[key];
  if (v === true || v === false) return v;
  return false;
}

function isUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      s.trim()
    )
  );
}

/** comments.memo_id 가 uuid 일 때: 앱이 보내는 로컬 왕관 id → memos.id(uuid) 로 치환 */
async function resolveMemoUuidForComment(supabase, userId, memoIdRaw) {
  const raw = (memoIdRaw || "").trim();
  if (!raw) {
    return { memoUuid: null, err: "empty memo_id" };
  }
  if (isUuid(raw)) {
    return { memoUuid: raw, err: null };
  }
  const { data, error } = await supabase
    .from("memos")
    .select("id")
    .eq("user_id", userId)
    .eq("local_id", raw)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return { memoUuid: null, err: error.message };
  }
  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row || !row.id) {
    return {
      memoUuid: null,
      err:
        `no memos row for local_id="${raw}" user_id="${userId}" — ` +
        `memos 테이블에 text 컬럼 local_id 를 추가하고 /memo 저장 시 넘기세요`,
    };
  }
  return { memoUuid: row.id, err: null };
}

function logSupabaseErr(label, err) {
  console.log(`❌ ${label}:`, err?.message || err);
  try {
    console.log(`❌ ${label} (full):`, JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  } catch (_) {
    console.log(`❌ ${label} (raw):`, err);
  }
}

/** DeepSeek/호환 API 오류 본문에서 사람이 읽을 문자열만 뽑는다. */
function deepSeekErrorMessage(json) {
  if (!json || typeof json !== "object") return "";
  const e = json.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  if (typeof json.message === "string") return json.message;
  return "";
}

/** OpenAI/호환 API 오류 본문에서 사람이 읽을 문자열만 뽑는다. */
function openAiErrorMessage(json) {
  if (!json || typeof json !== "object") return "";
  const e = json.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  if (typeof json.message === "string") return json.message;
  return "";
}

/** Null 등 API 페이로드를 깨뜨릴 수 있는 문자 제거 */
function sanitizePromptForApi(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\u0000/g, "").trim();
}

const MAX_PROMPT_CHARS = Math.max(
  8_000,
  Number.parseInt(process.env.MAX_PROMPT_CHARS || "100000", 10) || 100_000
);

/** `message.content` — 문자열·배열·구조화 객체({ comments })·null */
function assistantTextFromContent(c) {
  if (typeof c === "string") return c.trim();
  if (c == null) return "";
  if (Array.isArray(c)) {
    const parts = [];
    for (const part of c) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object") {
        if (typeof part.text === "string") parts.push(part.text);
        else if (part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
    return parts.join("").trim();
  }
  if (typeof c === "object") {
    try {
      return JSON.stringify(c);
    } catch (_) {
      return "";
    }
  }
  return "";
}

/**
 * deepseek-reasoner / thinking 응답에서 `content`가 비고 `reasoning_content`만 채워진 경우.
 * 사용자에게 보일 짧은 본문은 보통 맨 끝 단락에 가깝다.
 */
function assistantTextFromReasoning(reasoningRaw) {
  if (typeof reasoningRaw !== "string") return "";
  let t = reasoningRaw.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  const max = 8000;
  if (t.length > max) {
    t = t.slice(-max);
  }
  const paras = t
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length >= 1) {
    return paras[paras.length - 1];
  }
  return t;
}

/** DeepSeek/호환 API assistant 메시지 */
function assistantTextFromMessage(msgObj) {
  if (!msgObj || typeof msgObj !== "object") return "";
  let out = assistantTextFromContent(msgObj.content);
  if (out) return out;
  if (typeof msgObj.reasoning_content === "string") {
    out = assistantTextFromReasoning(msgObj.reasoning_content);
    if (out) return out;
  }
  return "";
}

/** DeepSeek 동시 outbound 제한(Render·API 과부하·일시 차단 완화) */
const DEEPSEEK_MAX_CONCURRENT = Math.max(
  1,
  Number.parseInt(process.env.DEEPSEEK_MAX_CONCURRENT || "3", 10) || 3
);
let dsPermits = DEEPSEEK_MAX_CONCURRENT;
const dsWaitQueue = [];

function acquireDeepSeekSlot() {
  return new Promise((resolve) => {
    if (dsPermits > 0) {
      dsPermits--;
      resolve();
    } else {
      dsWaitQueue.push(resolve);
    }
  });
}

function releaseDeepSeekSlot() {
  if (dsWaitQueue.length > 0) {
    const next = dsWaitQueue.shift();
    next();
  } else {
    dsPermits++;
  }
}

/** DeepSeek Chat Completions — story-chat, story-suggestions, comment 공통. */
async function callDeepSeekCompletion({
  userPrompt,
  temperature,
  max_tokens,
  logTag,
  systemPrompt,
}) {
  if (!DEEPSEEK_API_KEY) {
    return {
      ok: false,
      provider: "deepseek",
      status: 503,
      errorText: "서버 설정 오류입니다.",
      skipped: true,
    };
  }

  const messages = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }
  messages.push({ role: "user", content: userPrompt });

  let payload;
  try {
    payload = JSON.stringify({
      model: DEEPSEEK_MODEL,
      thinking: { type: "disabled" },
      temperature,
      max_tokens,
      messages,
    });
  } catch (stringifyErr) {
    console.error(`[${logTag}] JSON.stringify(deepseek payload) failed:`, stringifyErr);
    return {
      ok: false,
      provider: "deepseek",
      status: 400,
      errorText: "프롬프트 인코딩에 실패했습니다.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let dsRes;
  try {
    dsRes = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: payload,
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    const msg = fetchErr?.message || String(fetchErr);
    console.error(`[${logTag}] DeepSeek fetch error:`, msg);
    return {
      ok: false,
      provider: "deepseek",
      status: fetchErr?.name === "AbortError" ? 504 : 502,
      errorText:
        fetchErr?.name === "AbortError"
          ? "요청 시간이 초과되었습니다."
          : "AI 서버 연결이 불안정합니다. 잠시 후 다시 시도해 주세요.",
    };
  } finally {
    clearTimeout(timer);
  }

  const rawText = await dsRes.text();
  const safeRaw = typeof rawText === "string" ? rawText : String(rawText ?? "");
  let json = {};
  if (safeRaw) {
    try {
      json = JSON.parse(safeRaw);
    } catch (parseErr) {
      console.log(`[${logTag}] DeepSeek JSON parse`, parseErr.message);
      return {
        ok: false,
        provider: "deepseek",
        status: 502,
        errorText: "응답을 해석할 수 없습니다.",
      };
    }
  }

  if (!dsRes.ok) {
    const apiMsg = deepSeekErrorMessage(json) || "DeepSeek 요청에 실패했습니다.";
    const statusOut = dsRes.status >= 500 ? 502 : dsRes.status;
    console.log(
      `[${logTag}] DeepSeek HTTP ${dsRes.status} provider=deepseek model=${DEEPSEEK_MODEL}`,
      safeRaw.length ? safeRaw.slice(0, 400) : "(empty body)"
    );
    return {
      ok: false,
      provider: "deepseek",
      status: statusOut,
      errorText: apiMsg,
    };
  }

  const choices = Array.isArray(json?.choices) ? json.choices : [];
  const first = choices[0];
  const msgObj = first && first.message;
  let text = assistantTextFromMessage(msgObj);
  if (!text && first && typeof first.text === "string") {
    text = first.text.trim();
  }

  if (!text) {
    console.log(
      `[${logTag}] No assistant content in DeepSeek response provider=deepseek model=${DEEPSEEK_MODEL}`,
    );
    return {
      ok: false,
      provider: "deepseek",
      status: 502,
      errorText: "추천문 생성 실패",
    };
  }

  console.log(`[${logTag}] provider=deepseek model=${DEEPSEEK_MODEL}`);
  return {
    ok: true,
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    text,
    raw: json,
  };
}
/** 모델명만 던지는 쓰레기 응답(동형 문자·ZWSP 등) 거르기. */
function isGarbageModelLine(s, modelStr) {
  const model =
    typeof modelStr === "string" && modelStr.trim() ? modelStr.trim() : DEEPSEEK_MODEL;
  if (!s || typeof s !== "string") return false;
  let t = s
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKC")
    .replace(/\uFF1A/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  const expected = `model: ${model}`;
  if (t === expected) return true;
  if (t.toLowerCase() === expected.toLowerCase()) return true;
  const compact = t.replace(/\s/g, "");
  const compactExpected = expected.replace(/\s/g, "");
  if (compact === compactExpected) return true;
  if (/^model\s*:\s*(claude-|deepseek-|gpt-)/i.test(t)) return true;
  return false;
}

app.get("/comment", (_req, res) => {
  res.status(200).json({ text: "" });
});

app.get("/api/comment", (_req, res) => {
  res.status(200).json({ text: "" });
});

// =========================
// 메모 저장 (local_id = 앱 왕관 TodoItem.id, comments FK 용)
// =========================
async function handleMemoPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const content = readString(req.body, "content");
    const local_id = readString(req.body, "local_id");
    if (!user_id || !content) {
      return res.status(400).json({ error: "user_id, content 필요" });
    }

    const row = { user_id, content };
    if (local_id) row.local_id = local_id;

    // 동일 (user_id, local_id)는 DB 유니크 + upsert로 한 행만 유지(동시 POST 레이스 방지).
    if (local_id) {
      const { data: upserted, error: upErr } = await supabase
        .from("memos")
        .upsert(row, { onConflict: "user_id,local_id" })
        .select("id")
        .single();

      if (upErr) {
        logSupabaseErr("[memo] upsert", upErr);
        return res.status(500).json({ error: upErr.message });
      }
      if (!upserted?.id) {
        return res.status(500).json({ error: "memo upsert 응답 없음" });
      }
      console.log(
        "✅ memo upsert id=",
        upserted.id,
        `local_id=${local_id}`,
      );
      return res.json({ ok: true, id: upserted.id, upserted: true });
    }

    const { data, error } = await supabase
      .from("memos")
      .insert([row])
      .select("id")
      .single();

    if (error) {
      logSupabaseErr("[memo] insert", error);
      return res.status(500).json({ error: error.message });
    }

    console.log("✅ memo saved id=", data?.id, local_id ? `local_id=${local_id}` : "");
    res.json({ ok: true, id: data.id });
  } catch (e) {
    console.log("[memo]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.post("/memo", handleMemoPost);
app.post("/api/memo", handleMemoPost);

/// 전체 사용자 메모 피드 — `GET /api/memos/feed?limit=40&offset=0&embed=comments`
/// [embed=comments]이면 같은 묶음의 memos에 `comments` 배열을 붙여 한 번에 반환(N+1 방지).
/// `:userId` 라우트보다 **먼저** 등록해야 `userId=feed` 오인 없음.
async function handleMemosFeedGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const limRaw = req.query && req.query.limit;
    const offRaw = req.query && req.query.offset;
    let limit = 40;
    let offset = 0;
    if (typeof limRaw === "string" && limRaw.trim()) {
      const n = parseInt(limRaw, 10);
      if (Number.isFinite(n)) limit = Math.min(120, Math.max(1, n));
    }
    if (typeof offRaw === "string" && offRaw.trim()) {
      const n = parseInt(offRaw, 10);
      if (Number.isFinite(n)) offset = Math.max(0, n);
    }

    const embed =
      typeof req.query?.embed === "string" &&
      req.query.embed.trim().toLowerCase() === "comments";

    const hi = offset + limit - 1;
    const { data: memos, error } = await supabase
      .from("memos")
      .select("id, user_id, content, local_id, created_at")
      .order("created_at", { ascending: false })
      .range(offset, hi);

    if (error) {
      logSupabaseErr("[memos-feed] select", error);
      return res.status(500).json({ error: error.message });
    }

    const list = memos || [];
    if (!embed || list.length === 0) {
      return res.json(list);
    }

    const ids = list.map((m) => m && m.id).filter(Boolean);
    const { data: comments, error: cErr } = await supabase
      .from("comments")
      .select("*")
      .in("memo_id", ids)
      .order("created_at", { ascending: true });

    if (cErr) {
      logSupabaseErr("[memos-feed] comments", cErr);
      return res.status(500).json({ error: cErr.message });
    }

    /** @type {Record<string, any[]>} */
    const bucket = Object.create(null);
    for (const row of comments || []) {
      const k = row.memo_id;
      if (!bucket[k]) bucket[k] = [];
      bucket[k].push(row);
    }

    const out = list.map((m) => ({
      ...m,
      comments: bucket[m.id] || [],
    }));
    res.json(out);
  } catch (e) {
    console.log("[memos-feed]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.get("/api/memos/feed", handleMemosFeedGet);
app.get("/memos/feed", handleMemosFeedGet);

async function handleMemosList(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const embed =
      typeof req.query?.embed === "string" &&
      req.query.embed.trim().toLowerCase() === "comments";

    const { data, error } = await supabase
      .from("memos")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const list = data || [];
    if (!embed || list.length === 0) {
      return res.json(list);
    }

    const ids = list.map((m) => m && m.id).filter(Boolean);
    const { data: comments, error: cErr } = await supabase
      .from("comments")
      .select("*")
      .in("memo_id", ids)
      .order("created_at", { ascending: true });

    if (cErr) {
      logSupabaseErr("[memos-user] comments", cErr);
      return res.status(500).json({ error: cErr.message });
    }

    /** @type {Record<string, any[]>} */
    const bucket = Object.create(null);
    for (const row of comments || []) {
      const k = row.memo_id;
      if (!bucket[k]) bucket[k] = [];
      bucket[k].push(row);
    }

    const out = list.map((m) => ({
      ...m,
      comments: bucket[m.id] || [],
    }));
    res.json(out);
  } catch (e) {
    console.log("[memos]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.get("/memos/:userId", handleMemosList);
app.get("/api/memos/:userId", handleMemosList);

async function handleMemosDelete(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "no supabase" });

    const id = decodeURIComponent(req.params.id || "").trim();
    // eslint-disable-next-line no-console
    console.log("[DELETE memos] id:", id);

    if (!id) return res.status(400).json({ error: "id 필요" });

    const { error } = await supabase.from("memos").delete().eq("id", id);

    if (error) {
      console.error("[DELETE memos error]", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE memos crash]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.delete("/api/memos/:id", handleMemosDelete);
app.delete("/memos/:id", handleMemosDelete);

async function handleCommentSave(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const memo_id_raw = readString(req.body, "memo_id");
    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const content = readString(req.body, "content");
    const sender = readString(req.body, "sender") || "commenter";

    if (!memo_id_raw || !user_id || !commenter_id || !content) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    const { memoUuid, err: resolveErr } = await resolveMemoUuidForComment(
      supabase,
      user_id,
      memo_id_raw
    );
    if (!memoUuid) {
      console.log("❌ [comment-save] resolve memo_id failed:", resolveErr);
      return res.status(400).json({ ok: false, error: resolveErr || "memo_id resolve failed" });
    }

    const { error } = await supabase.from("comments").insert([
      { memo_id: memoUuid, user_id, commenter_id, sender, content },
    ]);

    if (error) {
      logSupabaseErr("[comment-save] insert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    console.log("✅ [comment-save] saved memo_id(uuid)=", memoUuid);
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[comment-save]", e);
    return res.status(500).json({ ok: false });
  }
}

async function handleAiCommentPost(req, res) {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const supabase = getSupabase();
    const promptRaw = req.body && req.body.prompt;
    const memo_id_raw = readString(req.body, "memo_id");
    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const sender = readString(req.body, "sender") || "commenter";

    console.log("📩 comment req:", {
      memo_id: memo_id_raw || null,
      user_id: user_id || null,
      commenter_id: commenter_id || null,
      has_prompt: typeof promptRaw === "string" && !!promptRaw.trim(),
    });

    if (typeof promptRaw !== "string" || !promptRaw.trim()) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }

    let cleanedPrompt = sanitizePromptForApi(promptRaw);
    if (!cleanedPrompt) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }
    if (cleanedPrompt.length > MAX_PROMPT_CHARS) {
      console.log(
        "[comment] truncating prompt length",
        cleanedPrompt.length,
        "->",
        MAX_PROMPT_CHARS
      );
      cleanedPrompt =
        cleanedPrompt.slice(0, MAX_PROMPT_CHARS) + "\n\n[…prompt truncated]";
    }

    if (!DEEPSEEK_API_KEY) {
      console.log("[comment] DEEPSEEK_API_KEY missing");
      return res.status(503).json({ text: "서버 설정 오류입니다." });
    }

    const requestedTemperature = Number(req.body && req.body.temperature);
    const requestedMaxTokens = Number(req.body && req.body.maxTokens);
    const temperature =
      Number.isFinite(requestedTemperature) && requestedTemperature >= 0 && requestedTemperature <= 2
        ? requestedTemperature
        : 0.9;
    const max_tokens =
      Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? Math.min(2048, Math.floor(requestedMaxTokens))
        : 200;

    await acquireDeepSeekSlot();
    let llmResult;
    try {
      llmResult = await callDeepSeekCompletion({
        userPrompt: cleanedPrompt,
        temperature,
        max_tokens,
        logTag: "comment",
      });
    } finally {
      releaseDeepSeekSlot();
    }

    if (!llmResult.ok) {
      const statusOut = llmResult.status || 502;
      return res.status(statusOut).json({
        text: llmResult.errorText || "DeepSeek 요청에 실패했습니다.",
      });
    }

    const text = llmResult.text;

    if (isGarbageModelLine(text, DEEPSEEK_MODEL)) {
      console.log("[comment] rejected garbage model-line reply");
      return res.status(502).json({ text: "댓글 생성 실패" });
    }

    // 클라우드 저장 실패는 DM/댓글 응답을 막지 않는다(예외 삼킴 + 로그).
    if (supabase && memo_id_raw && user_id && commenter_id) {
      try {
        const { memoUuid, err: resolveErr } = await resolveMemoUuidForComment(
          supabase,
          user_id,
          memo_id_raw
        );
        if (!memoUuid) {
          console.log("❌ [comment] Supabase 저장 생략 — memo_id 해석 실패:", resolveErr);
        } else {
          const { error } = await supabase.from("comments").insert([
            {
              memo_id: memoUuid,
              user_id,
              commenter_id,
              sender,
              content: text,
            },
          ]);

          if (error) {
            logSupabaseErr("[comment] comments insert", error);
          } else {
            console.log("✅ [comment] comment saved memo_id(uuid)=", memoUuid);
          }
        }
      } catch (sbErr) {
        console.log("❌ [comment] Supabase 저장 중 예외(응답은 정상 반환):", sbErr?.message || sbErr);
        if (sbErr?.stack) console.log(sbErr.stack);
      }
    }

    res.json({ text });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const cause = e && e.cause != null ? e.cause : null;
    const causeMsg =
      cause && typeof cause === "object" && typeof cause.message === "string"
        ? cause.message
        : "";
    const combined = `${msg} ${causeMsg}`.trim();
    console.error("[ai-server] POST /comment error:", combined);
    if (e && e.stack) console.error(e.stack);
    if (e && e.name === "AbortError") {
      return res.status(504).json({ text: "요청 시간이 초과되었습니다." });
    }
    if (
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket|certificate|timed out|TTFB|ECONN/i.test(
        combined
      )
    ) {
      return res.status(502).json({
        text: "AI 서버 연결이 불안정합니다. 잠시 후 다시 시도해 주세요.",
      });
    }
    res.status(500).json({ text: "server error" });
  }
}

function resolveStorySuggestionMaxTokens(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return 350;
  return Math.min(2048, Math.max(220, Math.floor(n)));
}

/** 스토리 beat 추천 재작성 — DeepSeek only. */
async function handleStorySuggestionsPost(req, res) {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const promptRaw = req.body && req.body.prompt;
    if (typeof promptRaw !== "string" || !promptRaw.trim()) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }

    let cleanedPrompt = sanitizePromptForApi(promptRaw);
    if (!cleanedPrompt) {
      return res.status(400).json({ text: "prompt 필드가 필요합니다." });
    }
    if (cleanedPrompt.length > MAX_PROMPT_CHARS) {
      console.log(
        "[story-suggestions] truncating prompt length",
        cleanedPrompt.length,
        "->",
        MAX_PROMPT_CHARS
      );
      cleanedPrompt =
        cleanedPrompt.slice(0, MAX_PROMPT_CHARS) + "\n\n[…prompt truncated]";
    }

    if (!DEEPSEEK_API_KEY) {
      console.log("[story-suggestions] DEEPSEEK_API_KEY missing");
      return res.status(503).json({ text: "서버 설정 오류입니다." });
    }

    const storyId = readString(req.body, "story_id");
    const programId = readString(req.body, "program_id");
    const slotCount = readInt(req.body, "slot_count", 2);
    const requestedTemperature = Number(req.body && req.body.temperature);
    const max_tokens = resolveStorySuggestionMaxTokens(req.body && req.body.maxTokens);

    const temperature =
      Number.isFinite(requestedTemperature) && requestedTemperature >= 0 && requestedTemperature <= 2
        ? requestedTemperature
        : 0.72;

    console.log(
      `[story-suggestions] storyId=${storyId || "(none)"} programId=${programId || "(none)"} ` +
        `slotCount=${slotCount} promptLen=${cleanedPrompt.length} maxTokens=${max_tokens} ` +
        `provider=deepseek model=${DEEPSEEK_MODEL}`,
    );

    await acquireDeepSeekSlot();
    let llmResult;
    try {
      llmResult = await callDeepSeekCompletion({
        userPrompt: cleanedPrompt,
        temperature,
        max_tokens,
        logTag: "story-suggestions",
      });
    } finally {
      releaseDeepSeekSlot();
    }

    if (!llmResult.ok) {
      const statusOut = llmResult.status || 502;
      const errorText = llmResult.errorText || "DeepSeek 요청에 실패했습니다.";
      return res.status(statusOut).json({ text: errorText });
    }

    const text = llmResult.text;
    if (isGarbageModelLine(text, DEEPSEEK_MODEL)) {
      console.log("[story-suggestions] rejected garbage model-line reply");
      return res.status(502).json({ text: "추천문 생성 실패" });
    }

    return res.json({ text, raw: llmResult.raw });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    console.error("[ai-server] POST /api/story-suggestions error:", msg);
    if (e && e.name === "AbortError") {
      return res.status(504).json({ text: "요청 시간이 초과했습니다." });
    }
    return res.status(500).json({ text: "server error" });
  }
}

// 댓글러 XP/잠금/즐겨찾기 — 앱 `GET /api/commenter-states/:userId`
async function handleCommenterStatesGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("commenter_state")
      .select("commenter_id, exp, level, is_unlocked, is_favorite, user_id")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ [commenter-states]", error?.message || error);
      return res.json([]);
    }
    res.json(data || []);
  } catch (e) {
    console.log("[commenter-states]", e);
    res.json([]);
  }
}

app.get("/api/commenter-states/:userId", handleCommenterStatesGet);
app.get("/commenter-states/:userId", handleCommenterStatesGet);

// 댓글러 상태 upsert — `handleCommenterStatePost` (아래 POST `/api/commenter-state` · `/commenter-state`).
async function handleCommenterStatePost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    if (!user_id || !commenter_id) {
      return res.status(400).json({ ok: false, error: "user_id, commenter_id 필요" });
    }

    const exp = readInt(req.body, "exp", 0);
    const level = readInt(req.body, "level", 1);
    const is_unlocked = readBool(req.body, "is_unlocked");
    const is_favorite = readBool(req.body, "is_favorite");

    const row = {
      user_id,
      commenter_id,
      exp: Math.max(0, exp),
      level: Math.max(1, level),
      is_unlocked,
      is_favorite,
    };

    const { error } = await supabase.from("commenter_state").upsert([row], {
      onConflict: "user_id,commenter_id",
    });

    if (error) {
      logSupabaseErr("[commenter-state] upsert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    console.log("✅ [commenter-state] upsert", user_id, commenter_id);
    return res.json({ ok: true });
  } catch (e) {
    console.log("[commenter-state]", e);
    return res.status(500).json({ ok: false });
  }
}

// POST 별칭: 동일 핸들러를 `/api/*` 와 루트 경로에 각각 한 번만 등록
app.post("/api/comment", handleAiCommentPost);
app.post("/comment", handleAiCommentPost);

app.post("/api/story-suggestions", handleStorySuggestionsPost);
app.post("/story-suggestions", handleStorySuggestionsPost);

app.post("/api/comment-save", handleCommentSave);
app.post("/comment-save", handleCommentSave);

app.post("/api/commenter-state", handleCommenterStatePost);
app.post("/commenter-state", handleCommenterStatePost);

// 커스텀 댓글러 프롬프트 — 앱 `POST /api/custom-prompt` · 배포별칭 `POST /api/custom-prompts`
async function handleCustomPromptPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const prompt = readString(req.body, "prompt");
    if (!user_id || !commenter_id || !prompt) {
      return res.status(400).json({ ok: false, error: "user_id, commenter_id, prompt 필요" });
    }

    const row = {
      user_id,
      commenter_id,
      prompt,
      updated_at: new Date().toISOString(),
    };

    let { error } = await supabase
      .from("custom_prompts")
      .upsert(row, { onConflict: "user_id,commenter_id" });

    if (error) {
      logSupabaseErr("[custom-prompt] upsert (retry delete+insert)", error);
      await supabase
        .from("custom_prompts")
        .delete()
        .eq("user_id", user_id)
        .eq("commenter_id", commenter_id);
      const ins = await supabase.from("custom_prompts").insert([row]);
      error = ins.error;
    }

    if (error) {
      logSupabaseErr("[custom-prompt] save failed", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.log("[custom-prompt]", e);
    return res.status(500).json({ ok: false });
  }
}

app.post("/api/custom-prompt", handleCustomPromptPost);
app.post("/api/custom-prompts", handleCustomPromptPost);
app.post("/custom-prompt", handleCustomPromptPost);
app.post("/custom-prompts", handleCustomPromptPost);

// 구버전 `GET /api/custom-prompts?user_id=` — `:userId` 라우트보다 먼저 등록
async function handleCustomPromptsQueryGet(req, res) {
  try {
    const raw = req.query && req.query.user_id;
    const userId =
      typeof raw === "string"
        ? decodeURIComponent(raw).trim()
        : Array.isArray(raw) && typeof raw[0] === "string"
          ? decodeURIComponent(raw[0]).trim()
          : "";
    if (!userId) {
      return res.status(400).json({ error: "user_id required" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const { data, error } = await supabase
      .from("custom_prompts")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ [custom-prompts ?user_id]", error?.message || error);
      return res.json([]);
    }
    res.json(data || []);
  } catch (e) {
    console.log("[custom-prompts query]", e);
    res.json([]);
  }
}

app.get("/api/custom-prompts", handleCustomPromptsQueryGet);
app.get("/custom-prompts", handleCustomPromptsQueryGet);

// 앱 `GET /api/custom-prompts/:userId` — [game_cloud_sync] gameCloudFetchCustomPrompts
async function handleCustomPromptsByUserGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("custom_prompts")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ [custom-prompts]", error?.message || error);
      return res.json([]);
    }
    res.json(data || []);
  } catch (e) {
    console.log("[custom-prompts]", e);
    res.json([]);
  }
}

app.get("/api/custom-prompts/:userId", handleCustomPromptsByUserGet);
app.get("/custom-prompts/:userId", handleCustomPromptsByUserGet);

// 쿠키 거래 1건 — 앱 `POST /api/cookie-tx`
async function handleCookieTxPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "user_id 필요" });
    }

    const deltaRaw = req.body && req.body.delta;
    const delta =
      typeof deltaRaw === "number" && Number.isFinite(deltaRaw)
        ? Math.trunc(deltaRaw)
        : parseInt(String(deltaRaw || "").trim(), 10);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: "delta 필요(0 제외)" });
    }

    const reason = readString(req.body, "reason") || "unknown";
    const platformRaw = readString(req.body, "platform");
    const platform = platformRaw || null;

    const { error } = await supabase.from("cookie_transactions").insert([
      {
        user_id,
        delta,
        reason,
        platform,
      },
    ]);

    if (error) {
      logSupabaseErr("[cookie-tx] insert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[cookie-tx]", e);
    return res.status(500).json({ ok: false });
  }
}

app.post("/api/cookie-tx", handleCookieTxPost);
app.post("/cookie-tx", handleCookieTxPost);

// Google Play 쿠키 IAP 검증·지급 — 앱 `POST /api/iap/verify-cookie`
async function handleIapCookieVerifyRoute(req, res) {
  return handleIapCookieVerifyPost(req, res, {
    getSupabase,
    readString,
    logSupabaseErr,
  });
}

app.post("/api/iap/verify-cookie", handleIapCookieVerifyRoute);
app.post("/iap/verify-cookie", handleIapCookieVerifyRoute);

// 쿠키 잔액(SUM) — 앱 `GET /api/cookie-balance/:userId`
async function handleCookieBalanceGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ balance: 0, count: 0 });

    const { data, error } = await supabase
      .from("cookie_transactions")
      .select("delta")
      .eq("user_id", userId);

    if (error) {
      logSupabaseErr("[cookie-balance]", error);
      return res.status(500).json({ error: error.message });
    }

    const rows = data || [];
    let balance = 0;
    for (const r of rows) {
      balance += Number(r.delta) || 0;
    }
    res.json({ balance, count: rows.length });
  } catch (e) {
    console.log("[cookie-balance]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.get("/api/cookie-balance/:userId", handleCookieBalanceGet);
app.get("/cookie-balance/:userId", handleCookieBalanceGet);

// 재설치·복원용 — 앱 GET 스냅샷
async function handleCommentsListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json([]);

    res.json(data || []);
  } catch (e) {
    console.log("[comments-list]", e);
    res.status(500).json([]);
  }
}

app.get("/api/comments/:userId", handleCommentsListGet);
app.get("/comments/:userId", handleCommentsListGet);

// 메모( uuid 또는 memos.local_id )별 댓글 — `GET /api/comments-by-memo/:memoId`
async function handleCommentsByMemoGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const raw = decodeURIComponent(req.params.memoId || "").trim();
    if (!raw) return res.status(400).json([]);

    let memoUuid = null;
    if (isUuid(raw)) {
      memoUuid = raw;
    } else {
      const { data, error } = await supabase
        .from("memos")
        .select("id")
        .eq("local_id", raw)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) {
        logSupabaseErr("[comments-by-memo] memos lookup", error);
        return res.status(500).json([]);
      }
      const row = Array.isArray(data) && data.length ? data[0] : null;
      memoUuid = row?.id ?? null;
    }

    if (!memoUuid) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("memo_id", memoUuid)
      .order("created_at", { ascending: true });

    if (error) {
      logSupabaseErr("[comments-by-memo] select", error);
      return res.status(500).json([]);
    }

    res.json(data || []);
  } catch (e) {
    console.log("[comments-by-memo]", e);
    res.status(500).json([]);
  }
}

app.get("/api/comments-by-memo/:memoId", handleCommentsByMemoGet);
app.get("/comments-by-memo/:memoId", handleCommentsByMemoGet);

async function handleChatMessagesListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json([]);

    res.json(data || []);
  } catch (e) {
    console.log("[chat-messages-list]", e);
    res.status(500).json([]);
  }
}

app.get("/api/chat-messages/:userId", handleChatMessagesListGet);
app.get("/chat-messages/:userId", handleChatMessagesListGet);

async function deleteChatMessagesForUserSession(
  supabase,
  userId,
  sessionKey,
  extraCommenterIds,
) {
  const keys = new Set(
    [sessionKey, ...(extraCommenterIds || [])]
      .map((v) => String(v || "").trim())
      .filter(Boolean),
  );
  for (const key of keys) {
    const bySession = await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", userId)
      .eq("session_key", key);
    if (bySession.error) {
      logSupabaseErr("[chat-messages/delete] session_key", bySession.error);
    }

    const byCommenter = await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", userId)
      .eq("commenter_id", key);
    if (byCommenter.error) {
      logSupabaseErr("[chat-messages/delete] commenter_id", byCommenter.error);
    }
  }
}

async function handleChatMessagesSessionDelete(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    const sessionKey = decodeURIComponent(req.params.sessionKey || "").trim();
    const commenterIdRaw = req.query && req.query.commenter_id;
    const commenterId =
      typeof commenterIdRaw === "string" ? commenterIdRaw.trim() : "";

    if (!userId || !sessionKey) {
      return res.status(400).json({ ok: false, error: "userId, sessionKey 필요" });
    }

    const extra = [];
    if (commenterId) extra.push(commenterId);
    const dmPrefix = "direct_dm:";
    if (sessionKey.startsWith(dmPrefix)) {
      const moniker = sessionKey.substring(dmPrefix.length).trim();
      if (moniker) extra.push(moniker);
    }

    await deleteChatMessagesForUserSession(
      supabase,
      userId,
      sessionKey,
      extra,
    );

    return res.json({ ok: true });
  } catch (e) {
    console.log("[chat-messages/delete]", e);
    return res.status(500).json({ ok: false });
  }
}

app.delete(
  "/api/chat-messages/:userId/:sessionKey",
  handleChatMessagesSessionDelete,
);
app.delete(
  "/chat-messages/:userId/:sessionKey",
  handleChatMessagesSessionDelete,
);

async function handleCookieTransactionsListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json([]);

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) return res.status(400).json([]);

    const { data, error } = await supabase
      .from("cookie_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json([]);

    res.json(data || []);
  } catch (e) {
    console.log("[cookie-transactions-list]", e);
    res.status(500).json([]);
  }
}

app.get("/api/cookie-transactions/:userId", handleCookieTransactionsListGet);
app.get("/cookie-transactions/:userId", handleCookieTransactionsListGet);

// 1:1 채팅 메시지 — 앱 `POST /api/chat/message` · 별칭 `POST /api/chat-message`
// Flutter(game_cloud_sync): session_key, commenter_id, sender, content
// GPT 스펙(/api/chat-message): user_id, session_key, role, content → sender=role, commenter_id=session_key(또는 body)
async function handleChatMessagePost(req, res, opts) {
  const requireSessionKey = opts && opts.requireSessionKey;
  /** GPT 스펙 경로만 session_key·role 컬럼까지 넣음(테이블에 컬럼 없으면 앱 경로는 4필드만 유지). */
  const extendRow = opts && opts.extendRow;
  try {
    console.log("📩 chat message body keys:", req.body && Object.keys(req.body));
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const content = readString(req.body, "content");
    const session_key = readString(req.body, "session_key");
    const role = readString(req.body, "role");
    const commenter_id = readString(req.body, "commenter_id");
    const sender = readString(req.body, "sender");

    if (!user_id || !content) {
      return res.status(400).json({ ok: false, error: "user_id, content 필요" });
    }
    if (requireSessionKey && !session_key) {
      return res.status(400).json({ ok: false, error: "session_key 필요" });
    }

    const senderOut = (sender || role || "user").trim() || "user";
    const commenterOut = (commenter_id || session_key).trim();
    if (!commenterOut) {
      return res
        .status(400)
        .json({ ok: false, error: "commenter_id 또는 session_key 필요" });
    }

    const row = {
      user_id,
      commenter_id: commenterOut,
      sender: senderOut,
      content,
    };
    if (extendRow) {
      if (session_key) row.session_key = session_key;
      if (role) row.role = role;
    }

    const { error } = await supabase.from("chat_messages").insert([row]);

    if (error) {
      logSupabaseErr("[chat/message] insert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[chat/message]", e);
    return res.status(500).json({ ok: false });
  }
}

app.post("/api/chat/message", (req, res) =>
  handleChatMessagePost(req, res, { requireSessionKey: false, extendRow: false }),
);
app.post("/api/chat-message", (req, res) =>
  handleChatMessagePost(req, res, { requireSessionKey: true, extendRow: true }),
);
app.post("/chat-message", (req, res) =>
  handleChatMessagePost(req, res, { requireSessionKey: true, extendRow: true }),
);

// =========================
// STORY CHAT (OpenAI reply + OpenAI scene prediction)
// =========================

const STORY_SCENE_KEYS = [
  "default",
  "royal_banquet",
  "royal_private_room",
  "palace_corridor",
  "palace_garden",
  "throne_room",
  "war_room",
  "secret_room",
  "prison",
  "fantasy_forest",
  "fantasy_castle",
  "battlefield",
  "dungeon",
  "village",
  "dragon_lair",
  "romance_cafe",
  "restaurant",
  "night_street",
  "rain_street",
  "rooftop_night",
  "bedroom_night",
  "science_roundtable",
  "laboratory",
  "auditorium",
  "news_studio",
  "debate_stage",
];

function safeJsonObjectFromText(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;

  try {
    return JSON.parse(t);
  } catch (_e) {
    /* continue */
  }

  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_e) {
      /* continue */
    }
  }

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (_e) {
      /* continue */
    }
  }

  return null;
}

function normalizeStorySceneKey(value) {
  const key = String(value || "").trim();
  return STORY_SCENE_KEYS.includes(key) ? key : "default";
}

function normalizeStoryScenePreload(value, scene) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];

  for (const v of arr) {
    const key = normalizeStorySceneKey(v);
    if (key !== "default" && key !== scene && !out.includes(key)) {
      out.push(key);
    }
    if (out.length >= 3) break;
  }

  return out;
}

function storyChatSkipsScenePrediction(storyId, programId) {
  const sid = String(storyId || "").trim();
  const pid = String(programId || "").trim();
  return sid === "movie_alien_x" || sid.startsWith("movie_") || pid === "movie_story";
}

async function predictStoryScene(contextText) {
  if (!DEEPSEEK_API_KEY) {
    return {
      scene: "default",
      preload: [],
      source: "fallback_no_deepseek_key",
    };
  }

  const safeContext = String(contextText || "").trim().slice(-9000);
  if (!safeContext) {
    return {
      scene: "default",
      preload: [],
      source: "fallback_empty_context",
    };
  }

  const sceneSystemPrompt = `You are the scene director for an AI story chat.

Goals:
- Pick the background scene key for the next character reply.
- From current scene and recent dialogue, pick up to 3 preload scene keys that may be needed soon.
- Stay natural to the dialogue flow; do not over-dramatize.

Allowed scene keys:
${STORY_SCENE_KEYS.join("\n")}

Output rules:
- JSON only.
- scene must be one allowed key.
- preload: up to 3 allowed keys.

Format:
{"scene":"royal_banquet","preload":["palace_corridor","palace_garden"]}`;

  const llmResult = await callDeepSeekCompletion({
    userPrompt: safeContext,
    temperature: 0.25,
    max_tokens: 220,
    logTag: "story-chat-scene",
    systemPrompt: sceneSystemPrompt,
  });

  if (!llmResult.ok) {
    console.error("[story-chat scene error]", llmResult.status, llmResult.errorText);
    return {
      scene: "default",
      preload: [],
      source: "fallback_deepseek_error",
    };
  }

  try {
    const content = llmResult.text || "";
    const parsed = safeJsonObjectFromText(content);
    const scene = normalizeStorySceneKey(parsed?.scene);

    return {
      scene,
      preload: normalizeStoryScenePreload(parsed?.preload, scene),
      source: "deepseek",
    };
  } catch (e) {
    console.error("[story-chat scene parse error]", e?.message || e);
    return {
      scene: "default",
      preload: [],
      source: "fallback_parse_error",
    };
  }
}

app.post("/api/story-chat", async (req, res) => {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const promptRaw = req.body && req.body.prompt;
    const storyContext = readString(req.body, "story_context");
    const requestedTemperature = Number(req.body && req.body.temperature);
    const requestedMaxTokens = Number(req.body && req.body.maxTokens);
    const temperature =
      Number.isFinite(requestedTemperature) && requestedTemperature >= 0 && requestedTemperature <= 2
        ? requestedTemperature
        : 0.82;
    const max_tokens =
      Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? Math.min(2048, Math.floor(requestedMaxTokens))
        : 620;

    if (typeof promptRaw !== "string" || !promptRaw.trim()) {
      return res.status(400).json({ ok: false, error: "no prompt" });
    }

    if (!DEEPSEEK_API_KEY) {
      return res.status(500).json({ ok: false, error: "no DEEPSEEK_API_KEY" });
    }

    const cleanedPrompt = sanitizePromptForApi(promptRaw);
    if (!cleanedPrompt) {
      return res.status(400).json({ ok: false, error: "no prompt" });
    }

    const sceneContext = storyContext || cleanedPrompt;
    const storyId = readString(req.body, "story_id");
    const programId = readString(req.body, "program_id");
    const beatScene = readString(req.body, "beat_scene");
    const skipScenePrediction =
      (req.body && req.body.skip_scene_prediction === true) ||
      storyChatSkipsScenePrediction(storyId, programId);

    await acquireDeepSeekSlot();
    let llmResult;
    let sceneData;
    try {
      const scenePromise = skipScenePrediction
        ? Promise.resolve({
            scene: "default",
            preload: [],
            source: "beat_scene_only",
          })
        : predictStoryScene(sceneContext);

      [llmResult, sceneData] = await Promise.all([
        callDeepSeekCompletion({
          userPrompt: cleanedPrompt,
          temperature,
          max_tokens,
          logTag: "story-chat",
        }),
        scenePromise,
      ]);
    } finally {
      releaseDeepSeekSlot();
    }

    if (!llmResult.ok) {
      const statusOut = llmResult.status || 502;
      const errMsg = llmResult.errorText || "deepseek failed";
      console.error(
        "[story-chat llm error]",
        `provider=deepseek model=${DEEPSEEK_MODEL}`,
        statusOut,
        errMsg,
      );
      return res.status(statusOut).json({ ok: false, error: errMsg });
    }

    const reply = llmResult.text;
    if (!reply) {
      return res.status(502).json({ ok: false, error: "empty reply" });
    }

    const upstreamRaw = llmResult.raw;

    console.log(
      `[story-chat] storyId=${storyId || "(none)"} programId=${programId || "(none)"} ` +
        `currentBeat.scene=${beatScene || "(none)"} appliedScenePreset=${sceneData.scene} ` +
        `preload=${JSON.stringify(sceneData.preload)} source=${sceneData.source} ` +
        `provider=deepseek model=${DEEPSEEK_MODEL}`,
    );

    return res.json({
      ok: true,
      reply,
      scene: sceneData.scene,
      preload: sceneData.preload,
      scene_source: sceneData.source,
      raw: upstreamRaw,
    });
  } catch (e) {
    console.error("[story-chat server error]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const OPENAI_TTS_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
]);

app.post("/api/story-tts", async (req, res) => {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);

  try {
    const text = readString(req.body, "text");
    const voiceRaw = readString(req.body, "voice") || "alloy";
    const provider = (readString(req.body, "provider") || "openai").toLowerCase();

    if (!text) {
      return res.status(400).json({ ok: false, error: "no text" });
    }
    if (provider !== "openai") {
      return res.status(400).json({ ok: false, error: "unsupported provider" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "no OPENAI_API_KEY" });
    }

    const voice = OPENAI_TTS_VOICES.has(voiceRaw) ? voiceRaw : "alloy";
    const input = text.length > 4096 ? text.slice(0, 4096) : text;

    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        input,
        voice,
        response_format: "mp3",
      }),
    });

    if (!ttsRes.ok) {
      const raw = await ttsRes.text();
      console.error("[story-tts] openai error", ttsRes.status, raw.slice(0, 400));
      return res.status(502).json({ ok: false, error: raw.slice(0, 200) || "tts failed" });
    }

    const buffer = Buffer.from(await ttsRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.send(buffer);
  } catch (e) {
    console.error("[story-tts] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "tts failed" });
  }
});

// =========================
// STORY IMAGE GENERATION (GPT cover + scene backgrounds)
// =========================

const STORY_IMAGE_REFERENCE_RULES = `IMPORTANT:

Use the provided reference images as the source of truth for all characters.

Maintain the exact appearance of referenced characters.

Do not redesign faces.
Do not change hairstyle.
Do not change age.
Do not change ethnicity.
Do not change body type.

Only change pose, expression, scene, lighting and environment according to the story.`;

const STORY_STYLE_REFERENCE_RULES = `IMPORTANT:

Use the provided reference image as a VISUAL STYLE guide only.

Match the rendering quality, color palette, lighting mood, composition style, and art direction from the reference.

Do NOT copy the person's face, identity, hairstyle, age, ethnicity, or exact pose from the reference.

Create a NEW original character based on the prompt while matching the reference aesthetic.`;

const STORY_IMAGE_COMMON_RULES = `Visual rules:
- vertical 9:16 composition
- cinematic lighting
- full background scene
- no speech bubbles
- no text
- no watermark
- no UI elements
- emotionally clear storytelling`;

const STORY_CATEGORY_STYLES = {
  fantasy:
    "fantasy cinematic illustration, epic fantasy atmosphere, magical world, enchanted lighting, ancient ruins, castles, forests, mythical creatures, glowing magic effects, dramatic composition, high detail, storybook fantasy, immersive adventure scene",
  romance:
    "romantic cinematic illustration, warm emotional atmosphere, soft natural lighting, expressive characters, intimate moment, modern daily life, cafe, bedroom, street at night, school, office, subtle facial expression, gentle mood, beautiful composition, no magic effects, no dragons",
  movie:
    "cinematic movie still, dramatic lighting, realistic film composition, wide angle shot, strong visual storytelling, atmospheric scene, high contrast, professional cinematography, dynamic camera angle, movie poster quality, immersive scene",
  royal:
    "cinematic historical drama still, elegant palace atmosphere, period drama lighting, suspenseful composition, ornate interiors, dramatic shadows, film-quality storytelling",
  science:
    "curious intellectual cinematic illustration, modern science atmosphere, clean dramatic lighting",
  issue:
    "dramatic newsroom cinematic illustration, tense atmosphere, professional lighting",
  character_chat:
    "high-quality character portrait illustration for mobile chat background, upper-body portrait, expressive face with clean detailed features, soft atmospheric background, cinematic lighting, art-style faithful to reference, no text, no UI, no watermark",
};

const STORY_CATEGORY_FOCUS = {
  fantasy:
    "Focus: Visualize the current location as an epic fantasy scene. Emphasize world-building, magical atmosphere, and adventure tension. Location-first composition.",
  romance:
    "Focus: Visualize emotional distance and mood between characters. Soft lighting, intimate spaces, subtle expressions. Emotion-first; avoid fantasy magic effects.",
  movie:
    "Focus: Visualize as a cinematic film still. Strong camera angle, dramatic lighting, and genre-appropriate tension. Composition-first.",
  royal:
    "Focus: Visualize as a historical drama film still. Palace corridors, period atmosphere, elegant suspense.",
  science:
    "Focus: Visualize curiosity and discovery in a cinematic educational scene.",
  issue:
    "Focus: Visualize a dramatic debate or newsroom atmosphere.",
  character_chat:
    "Focus: Single character portrait for vertical mobile chat wallpaper. Center face and upper body, match reference art style, keep background atmospheric but non-distracting.",
};

function storyImageApiSize({ landscape = false } = {}) {
  return landscape ? STORY_IMAGE_SIZE_LANDSCAPE : STORY_IMAGE_SIZE_PORTRAIT;
}

function normalizeStoryProgramType(raw) {
  const t = String(raw || "fantasy")
    .trim()
    .toLowerCase();
  if (t === "movie" || t === "film" || t === "영화" || t === "드라마") return "movie";
  if (Object.prototype.hasOwnProperty.call(STORY_CATEGORY_STYLES, t)) return t;
  return "fantasy";
}

function parseStoryReferenceImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, i) => {
      if (!item || typeof item !== "object") return null;
      const name = String(item.name || `character${i + 1}`).trim();
      const data = String(item.data || "").trim();
      if (!data) return null;
      return { name, data };
    })
    .filter(Boolean)
    .slice(0, 4);
}

const STORY_BANNER_TITLE_RULES = `Visual rules for story banner card:
- horizontal 16:9 composition (landscape banner card)
- cinematic lighting, full background scene
- render the story title text prominently at the top center, integrated into the artwork like a movie or game poster
- title must be bold, readable, cinematic typography with dramatic lighting or texture
- no speech bubbles, no subtitles, no caption text, no watermark, no UI elements
- emotionally clear storytelling`;

function characterChatVisualStyle(styleType, mood = "") {
  const m = String(mood || "").trim() || "cinematic dramatic";
  if (String(styleType || "").trim().toLowerCase() === "photo") {
    return (
      "photorealistic portrait photography for mobile chat background, upper-body portrait, " +
      "realistic skin texture, natural lighting, soft cinematic color grading, shallow depth of field, " +
      "no illustration, no anime, no watercolor, no painting. Mood: " +
      m
    );
  }
  return (
    "high-quality character portrait illustration for mobile chat background, upper-body portrait, " +
    "expressive illustrated rendering, soft atmospheric background, cinematic lighting, " +
    "no text, no UI, no watermark. Mood: " +
    m
  );
}

function characterChatVisualFocus(styleType, referenceMode = "") {
  const mode = String(referenceMode || "").trim().toLowerCase();
  if (mode === "style") {
    return (
      "Focus: Single character portrait for vertical mobile chat wallpaper. " +
      "Match the visual style and rendering quality from the style reference image. " +
      "Create a new original character per the prompt — do not copy the reference person's identity."
    );
  }
  if (String(styleType || "").trim().toLowerCase() === "photo") {
    return (
      "Focus: Single photorealistic character portrait for vertical mobile chat wallpaper. " +
      "Center face and upper body, match character appearance from reference if provided, " +
      "keep background atmospheric but non-distracting."
    );
  }
  return (
    "Focus: Single illustrated character portrait for vertical mobile chat wallpaper. " +
    "Center face and upper body, match reference character appearance if provided, " +
    "keep background atmospheric but non-distracting."
  );
}

function buildStoryImagePrompt({
  programType,
  title = "",
  opening = "",
  partner = "",
  mood = "",
  recentTurns = "",
  sceneSummary = "",
  characters = "",
  emotion = "",
  referenceCharacterNames = [],
  isCover = false,
  renderTitleInImage = false,
  styleType = "",
  referenceMode = "",
}) {
  const program = normalizeStoryProgramType(programType);
  let style = STORY_CATEGORY_STYLES[program] || STORY_CATEGORY_STYLES.fantasy;
  let focus = STORY_CATEGORY_FOCUS[program] || STORY_CATEGORY_FOCUS.fantasy;
  if (program === "character_chat") {
    style = characterChatVisualStyle(styleType, mood);
    focus = characterChatVisualFocus(styleType, referenceMode);
  }
  const t = String(title || "").trim().slice(0, 200);
  const op = String(opening || "").trim().slice(0, 600);
  const p = String(partner || "").trim().slice(0, 80);
  const m = String(mood || "cinematic dramatic").trim().slice(0, 120);
  const turns = String(recentTurns || "").trim().slice(0, 2000);
  const scene = String(sceneSummary || "").trim().slice(0, 400);
  const chars = String(characters || "").trim().slice(0, 300);
  const emo = String(emotion || "").trim().slice(0, 120);
  const refNames = Array.isArray(referenceCharacterNames)
    ? referenceCharacterNames.map((n) => String(n || "").trim()).filter(Boolean)
    : [];

  const kind = isCover
    ? renderTitleInImage
      ? "Create one high-quality horizontal story banner cover with the title text rendered inside the image."
      : "Create one high-quality vertical story cover background."
    : "Create one high-quality vertical story scene background.";

  const visualRules = isCover && renderTitleInImage
    ? `${STORY_BANNER_TITLE_RULES}
- only text allowed in the image is the story title shown below`
    : STORY_IMAGE_COMMON_RULES;

  const titleBlock =
    isCover && renderTitleInImage && t
      ? `\nTitle text to render in the image (Korean, exact spelling): 「${t}」`
      : "";

  const refBlock =
    refNames.length > 0
      ? `\nReference characters (uploaded images in order):\n${refNames.map((n, i) => `image${i + 1}: ${n}`).join("\n")}`
      : "";

  const refMode = String(referenceMode || "").trim().toLowerCase();
  const refRules =
    refNames.length > 0
      ? refMode === "style"
        ? STORY_STYLE_REFERENCE_RULES
        : STORY_IMAGE_REFERENCE_RULES
      : "";

  return `${refRules}
${refBlock}

${kind}

Category style:
${style}

${focus}

${visualRules}${titleBlock}

Program: ${program}
Title: ${t}
Opening: ${op}
Partner: ${p}
Mood: ${m}
${turns ? `\nRecent Story (last user turns):\n${turns}` : ""}
${scene ? `\nScene Summary:\n${scene}` : ""}
${chars ? `\nCharacters:\n${chars}` : ""}
${emo ? `\nEmotion:\n${emo}` : ""}`.trim();
}

function sanitizeStoryImagePathSegment(raw, maxLen = 80) {
  return String(raw || "scene")
    .replace(/[^a-zA-Z0-9._\u3131-\uD79D-]/g, "_")
    .slice(0, maxLen) || "scene";
}

async function uploadStoryImageToSupabase(sessionKey, subfolder, fileStem, pngBuffer) {
  const supabase = getSupabase();
  if (!supabase || !sessionKey || !pngBuffer?.length) return null;

  const safeKey = sanitizeStoryImagePathSegment(sessionKey, 120);
  const safeStem = sanitizeStoryImagePathSegment(fileStem, 80);
  const path = `${subfolder}/${safeKey}_${safeStem}.png`;

  const { error } = await supabase.storage.from("story-covers").upload(path, pngBuffer, {
    contentType: "image/png",
    upsert: true,
  });

  if (error) {
    console.error("[story-image upload error]", error.message);
    return null;
  }

  const { data } = supabase.storage.from("story-covers").getPublicUrl(path);
  return data?.publicUrl || null;
}

const STORY_REF_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

function filterStoryReferenceImagesForApi(referenceImages) {
  const out = [];
  for (const ref of referenceImages) {
    if (out.length >= 4) break;
    let buf;
    try {
      buf = Buffer.from(ref.data, "base64");
    } catch (_e) {
      continue;
    }
    if (!buf?.length || buf.length > STORY_REF_IMAGE_MAX_BYTES) {
      console.warn(
        "[story-image] skip ref",
        ref.name,
        buf?.length ? `too large (${buf.length})` : "invalid",
      );
      continue;
    }
    out.push({ name: ref.name, buf });
  }
  return out;
}

async function requestOpenAiStoryImageGeneration(prompt, imageSize = STORY_IMAGE_SIZE_PORTRAIT) {
  return fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size: imageSize,
      quality: OPENAI_IMAGE_QUALITY,
      n: 1,
    }),
  });
}

function parseOpenAiImageError(raw, status = 0) {
  const body = String(raw || "").trim();
  if (!body) return `image generation failed (${status || "unknown"})`;
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error;
    if (err && typeof err === "object") {
      const msg = String(err.message || err.code || "").trim();
      if (msg) return msg;
    }
    const top = String(parsed?.message || parsed?.error || "").trim();
    if (top) return top;
  } catch (_e) {
    // keep raw fallback below
  }
  return body.length > 320 ? `${body.slice(0, 320)}…` : body;
}

async function readOpenAiStoryImageResponse(res, label) {
  const raw = await res.text();
  console.log(`[story-image openai ${label}] status=${res.status}`);
  console.log(`[story-image openai ${label}] body=${raw}`);
  return {
    ok: res.ok,
    status: res.status,
    raw,
    errorMessage: res.ok ? "" : parseOpenAiImageError(raw, res.status),
  };
}

async function requestOpenAiStoryImageEdits(
  prompt,
  referenceImages,
  imageSize = STORY_IMAGE_SIZE_PORTRAIT,
) {
  const refs = filterStoryReferenceImagesForApi(referenceImages);
  if (!refs.length) return null;

  const form = new FormData();
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("size", imageSize);
  form.append("n", "1");
  form.append("input_fidelity", "high");
  for (const ref of refs) {
    form.append("image[]", ref.buf, {
      filename: `${sanitizeStoryImagePathSegment(ref.name, 40)}.png`,
      contentType: "image/png",
    });
  }

  console.log(
    "[story-image edits request]",
    `refs=${refs.length}`,
    `names=${refs.map((r) => r.name).join(",")}`,
  );

  return fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
    duplex: "half",
  });
}

async function generateStoryImageFromPrompt(
  prompt,
  sessionKey,
  fileStem,
  referenceImages = [],
  imageSize = STORY_IMAGE_SIZE_PORTRAIT,
) {
  if (!OPENAI_API_KEY) {
    throw new Error("no OPENAI_API_KEY");
  }

  const parsedReferenceCount = Array.isArray(referenceImages) ? referenceImages.length : 0;
  let generationMode = "generations";
  let referenceApplied = false;
  const fallbackUsed = false;
  let result;

  if (parsedReferenceCount > 0) {
    const editsRes = await requestOpenAiStoryImageEdits(prompt, referenceImages, imageSize);
    if (!editsRes) {
      throw new Error("reference images provided but edits request could not be built");
    }
    result = await readOpenAiStoryImageResponse(editsRes, "edits");
    console.log(
      "[imageGen]",
      `parsedReferenceCount=${parsedReferenceCount}`,
      `refSizes=${referenceImages
        .map((r) => {
          if (r.buf?.length) return r.buf.length;
          try {
            return Buffer.from(r.data || "", "base64").length;
          } catch (_e) {
            return 0;
          }
        })
        .join(",")}`,
      `editsStatus=${result.status}`,
      "generationMode=edits",
      "fallbackUsed=false",
    );
    if (!result.ok) {
      throw new Error(result.errorMessage || `image edits failed (${result.status})`);
    }
    generationMode = "edits";
    referenceApplied = true;
  } else {
    const genRes = await requestOpenAiStoryImageGeneration(prompt, imageSize);
    result = await readOpenAiStoryImageResponse(genRes, "generations");
    console.log(
      "[imageGen]",
      "parsedReferenceCount=0",
      `generationsStatus=${result.status}`,
      "generationMode=generations",
      "fallbackUsed=false",
    );
  }

  const raw = result.raw;
  if (!result.ok) {
    throw new Error(result.errorMessage || `image generation failed (${result.status})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    throw new Error("invalid openai response");
  }

  const item = parsed?.data?.[0];
  let imageUrl = item?.url || "";
  const b64 = item?.b64_json;

  if (!imageUrl && b64) {
    const pngBuffer = Buffer.from(b64, "base64");
    const uploaded = await uploadStoryImageToSupabase(
      sessionKey,
      "covers",
      fileStem,
      pngBuffer,
    );
    imageUrl = uploaded || `data:image/png;base64,${b64}`;
  }

  if (!imageUrl) {
    throw new Error("no image in response");
  }

  return {
    imageUrl,
    generationMode,
    referenceApplied,
    fallbackUsed,
  };
}

app.post("/api/story-cover-image", async (req, res) => {
  try {
    if (!storyImageGenerationEnabled()) {
      return res.status(503).json({ ok: false, error: "story image generation disabled" });
    }

    const {
      program_type = "fantasy",
      title = "",
      opening = "",
      partner = "",
      persona = "",
      mood = "",
      session_key = "",
      recent_turns = "",
      scene_summary = "",
      characters = "",
      reference_images = [],
      render_title_in_image = false,
      style_type = "",
      reference_mode = "",
    } = req.body || {};

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "no OPENAI_API_KEY" });
    }

    const refs = parseStoryReferenceImages(reference_images);
    const refNames = refs.map((r) => r.name);
    console.log(
      "[imageGen] story-cover-image",
      `styleType=${String(style_type || "").trim() || "(default)"}`,
      `referenceMode=${String(reference_mode || "").trim() || "(default)"}`,
      `parsedReferenceCount=${refs.length}`,
    );

    const promptUsed = buildStoryImagePrompt({
      programType: program_type,
      title,
      opening,
      partner: partner || persona,
      mood,
      recentTurns: recent_turns || opening,
      sceneSummary: scene_summary,
      characters: characters || refNames.join(", "),
      referenceCharacterNames: refNames,
      isCover: true,
      renderTitleInImage: !!render_title_in_image,
      styleType: style_type,
      referenceMode: reference_mode,
    });

    const imageSize = storyImageApiSize({ landscape: !!render_title_in_image });
    const genResult = await generateStoryImageFromPrompt(
      promptUsed,
      session_key || "cover",
      "cover",
      refs,
      imageSize,
    );

    return res.json({
      ok: true,
      image_url: genResult.imageUrl,
      prompt_used: promptUsed,
      image_size: imageSize,
      image_quality: OPENAI_IMAGE_QUALITY,
      generation_mode: genResult.generationMode,
      reference_applied: genResult.referenceApplied,
      fallback_used: genResult.fallbackUsed,
    });
  } catch (e) {
    console.error("[story-cover server error]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/story-scene-image", async (req, res) => {
  try {
    if (!storyImageGenerationEnabled()) {
      return res.status(503).json({ ok: false, error: "story image generation disabled" });
    }

    const {
      program_type = "fantasy",
      title = "",
      session_key = "",
      scene_label = "",
      recent_turns = "",
      characters = "",
      emotion = "",
      narrator_hint = "",
      scene_summary = "",
      reference_images = [],
      mood = "",
    } = req.body || {};

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "no OPENAI_API_KEY" });
    }

    const refs = parseStoryReferenceImages(reference_images);
    const refNames = refs.map((r) => r.name);
    const sceneSummary =
      String(scene_summary || "").trim() ||
      [scene_label, narrator_hint, emotion ? `Emotion: ${emotion}` : ""]
        .filter(Boolean)
        .join("\n");

    const promptUsed = buildStoryImagePrompt({
      programType: program_type,
      title,
      recentTurns: recent_turns,
      sceneSummary,
      characters: characters || refNames.join(", "),
      emotion,
      referenceCharacterNames: refNames,
      isCover: false,
    });

    const fileStem = `scene_${sanitizeStoryImagePathSegment(scene_label || "scene", 48)}`;
    const imageSize = storyImageApiSize({ landscape: false });
    const genResult = await generateStoryImageFromPrompt(
      promptUsed,
      session_key || "scene",
      fileStem,
      refs,
      imageSize,
    );

    return res.json({
      ok: true,
      image_url: genResult.imageUrl,
      prompt_used: promptUsed,
      image_size: imageSize,
      image_quality: OPENAI_IMAGE_QUALITY,
      generation_mode: genResult.generationMode,
      reference_applied: genResult.referenceApplied,
      fallback_used: genResult.fallbackUsed,
    });
  } catch (e) {
    console.error("[story-scene server error]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// 유저 제작 스토리 — 앱 `POST/GET /api/user-stories`
async function handleUserStoriesPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const title = readString(req.body, "title");
    const summary = readString(req.body, "summary");
    const category = readString(req.body, "category") || "fantasy";
    const visibility = readString(req.body, "visibility") || "private";
    const cover_url = readString(req.body, "cover_url");
    const background_url = readString(req.body, "background_url");
    const draft_json = req.body && req.body.draft_json;
    const id = readString(req.body, "id");

    if (!user_id || !title) {
      return res.status(400).json({ ok: false, error: "user_id, title 필요" });
    }
    if (draft_json == null || typeof draft_json !== "object") {
      return res.status(400).json({ ok: false, error: "draft_json 필요" });
    }

    const now = new Date().toISOString();
    const row = {
      user_id,
      title,
      summary,
      category,
      visibility,
      cover_url,
      background_url,
      draft_json,
      updated_at: now,
    };
    if (id) row.id = id;

    let result;
    if (id) {
      result = await supabase
        .from("user_stories")
        .upsert(row, { onConflict: "id" })
        .select("id")
        .single();
    } else {
      row.created_at = now;
      result = await supabase.from("user_stories").insert([row]).select("id").single();
    }

    if (result.error) {
      logSupabaseErr("[user-stories] save failed", result.error);
      return res.status(500).json({ ok: false, error: result.error.message });
    }

    return res.json({ ok: true, id: result.data?.id || id || null });
  } catch (e) {
    console.error("[user-stories post]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleUserStoriesQueryGet(req, res) {
  try {
    const scopeRaw = req.query && req.query.scope;
    const scope =
      typeof scopeRaw === "string"
        ? decodeURIComponent(scopeRaw).trim().toLowerCase()
        : Array.isArray(scopeRaw) && typeof scopeRaw[0] === "string"
          ? decodeURIComponent(scopeRaw[0]).trim().toLowerCase()
          : "";

    const categoryRaw = req.query && req.query.category;
    const category =
      typeof categoryRaw === "string"
        ? decodeURIComponent(categoryRaw).trim()
        : Array.isArray(categoryRaw) && typeof categoryRaw[0] === "string"
          ? decodeURIComponent(categoryRaw[0]).trim()
          : "";

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    if (scope === "public") {
      const rawCreator = req.query && req.query.user_id;
      const creatorUserId =
        typeof rawCreator === "string"
          ? decodeURIComponent(rawCreator).trim()
          : Array.isArray(rawCreator) && typeof rawCreator[0] === "string"
            ? decodeURIComponent(rawCreator[0]).trim()
            : "";

      let query = supabase
        .from("user_stories")
        .select("*")
        .eq("visibility", "public")
        .order("updated_at", { ascending: false });
      if (category) {
        query = query.eq("category", category);
      }
      if (creatorUserId) {
        query = query.eq("user_id", creatorUserId);
      }
      const { data, error } = await query;
      if (error) {
        logSupabaseErr("[user-stories public list]", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
      return res.json({ ok: true, stories: data || [] });
    }

    const raw = req.query && req.query.user_id;
    const userId =
      typeof raw === "string"
        ? decodeURIComponent(raw).trim()
        : Array.isArray(raw) && typeof raw[0] === "string"
          ? decodeURIComponent(raw[0]).trim()
          : "";
    if (!userId) {
      return res.status(400).json({ ok: false, error: "user_id required" });
    }

    const { data, error } = await supabase
      .from("user_stories")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      logSupabaseErr("[user-stories list]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true, stories: data || [] });
  } catch (e) {
    console.error("[user-stories list]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleUserStoryByIdGet(req, res) {
  try {
    const storyId = decodeURIComponent(req.params.id || "").trim();
    if (!storyId) {
      return res.status(400).json({ ok: false, error: "id required" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const { data, error } = await supabase
      .from("user_stories")
      .select("*")
      .eq("id", storyId)
      .maybeSingle();

    if (error) {
      logSupabaseErr("[user-stories get]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    return res.json({ ok: true, story: data });
  } catch (e) {
    console.error("[user-stories get]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleUserStoryByIdDelete(req, res) {
  try {
    const storyId = decodeURIComponent(req.params.id || "").trim();
    if (!storyId) {
      return res.status(400).json({ ok: false, error: "id required" });
    }

    const raw = req.query && req.query.user_id;
    const userId =
      typeof raw === "string"
        ? decodeURIComponent(raw).trim()
        : Array.isArray(raw) && typeof raw[0] === "string"
          ? decodeURIComponent(raw[0]).trim()
          : "";
    if (!userId) {
      return res.status(400).json({ ok: false, error: "user_id required" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const { data: existing, error: fetchErr } = await supabase
      .from("user_stories")
      .select("user_id")
      .eq("id", storyId)
      .maybeSingle();

    if (fetchErr) {
      logSupabaseErr("[user-stories delete fetch]", fetchErr);
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }
    if (!existing) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    if ((existing.user_id || "").trim() !== userId) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const { error: deleteErr } = await supabase
      .from("user_stories")
      .delete()
      .eq("id", storyId);

    if (deleteErr) {
      logSupabaseErr("[user-stories delete]", deleteErr);
      return res.status(500).json({ ok: false, error: deleteErr.message });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[user-stories delete]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/api/user-stories", handleUserStoriesPost);
app.post("/user-stories", handleUserStoriesPost);
app.get("/api/user-stories", handleUserStoriesQueryGet);
app.get("/user-stories", handleUserStoriesQueryGet);
app.get("/api/user-stories/:id", handleUserStoryByIdGet);
app.get("/user-stories/:id", handleUserStoryByIdGet);
app.delete("/api/user-stories/:id", handleUserStoryByIdDelete);
app.delete("/user-stories/:id", handleUserStoryByIdDelete);

const PORT = Number(process.env.PORT) || 3000;

logSupabaseInit();
console.log(
  `[ai-server] storyProvider=deepseek storyModel=${DEEPSEEK_MODEL} deepseekConfigured=${!!DEEPSEEK_API_KEY} openaiConfigured=${!!OPENAI_API_KEY}`,
);

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
