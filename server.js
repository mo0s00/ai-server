"use strict";

import express from "express";
import FormData from "form-data";
import { PassThrough } from "node:stream";
import { createClient } from "@supabase/supabase-js";
import { handleIapCookieVerifyPost } from "./iap-cookie.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-5.4-nano").trim();

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const ANTHROPIC_MODEL = (
  process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"
).trim();
/** 스토리 본문 대사·나레이션 — Claude Haiku 4.5 */
const STORY_CHAT_ANTHROPIC_MODEL = (
  process.env.STORY_CHAT_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"
).trim();
/** 플레이어 추천문 2~3개 — Claude Haiku 4.5 */
const STORY_SUGGESTION_ANTHROPIC_MODEL = (
  process.env.STORY_SUGGESTION_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"
).trim();
/** 스토리 실시간 관중 댓글 — Claude Opus 5 */
const LIVE_COMMENT_ANTHROPIC_MODEL = (
  process.env.LIVE_COMMENT_ANTHROPIC_MODEL || "claude-opus-5"
).trim();
/** 스토리 제작·노드 설계·검수·DM `/comment` — Claude Opus 5 */
const STORY_CREATION_ANTHROPIC_MODEL = (
  process.env.STORY_CREATION_ANTHROPIC_MODEL || "claude-opus-5"
).trim();
/** story-chat 배경 scene 예측(부속) — Haiku */
const STORY_SCENE_ANTHROPIC_MODEL = (
  process.env.STORY_SCENE_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"
).trim();
const ANTHROPIC_VERSION = "2023-06-01";

/** 스토리 텍스트 LLM — Anthropic 전용. TTS·이미지는 OpenAI. DeepSeek 미사용. */
const DEEPSEEK_CHAT_URL = (
  process.env.DEEPSEEK_CHAT_URL || "https://api.deepseek.com/v1/chat/completions"
).trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || "").trim();
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();

/** @returns {{ provider: string, url: string, apiKey: string, model: string } | null} */
function resolveDeepSeekConfig() {
  if (!DEEPSEEK_API_KEY) return null;
  return {
    provider: "deepseek",
    url: DEEPSEEK_CHAT_URL,
    apiKey: DEEPSEEK_API_KEY,
    model: DEEPSEEK_MODEL,
  };
}

function isDeepSeekConfigured() {
  return !!DEEPSEEK_API_KEY;
}

function isAnthropicConfigured() {
  return !!ANTHROPIC_API_KEY;
}

function logDeepSeekNotConfigured(logTag) {
  console.error("[chatLlm] ERROR DeepSeek is not configured");
  if (logTag) {
    console.error(`[${logTag}] DeepSeek is not configured (set DEEPSEEK_API_KEY)`);
  }
}

/** Chat completion token limit — DeepSeek·대부분 모델은 max_tokens. */
function chatCompletionTokenLimit(maxTokens, modelStr) {
  const n =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : null;
  if (n == null) return {};
  const model = (modelStr || DEEPSEEK_MODEL).toLowerCase();
  if (/gpt-5|^o[0-9]/.test(model)) {
    return { max_completion_tokens: n };
  }
  return { max_tokens: n };
}

/** gpt-5·o 시리즈는 `max_tokens` 대신 `max_completion_tokens`만 허용한다. */
function openAiCompletionTokenLimit(maxTokens) {
  const n =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : null;
  if (n == null) return {};
  const model = OPENAI_MODEL.toLowerCase();
  if (/gpt-5|^o[0-9]/.test(model)) {
    return { max_completion_tokens: n };
  }
  return { max_tokens: n };
}

/** Non-chat OpenAI APIs — fixed in code (env: OPENAI_API_KEY + OPENAI_MODEL only). */
const OPENAI_TTS_MODEL = "tts-1";
const OPENAI_IMAGE_MODEL = "gpt-image-1";
const OPENAI_IMAGE_QUALITY = "high";
const STORY_IMAGE_SIZE_PORTRAIT = "1024x1536";
const STORY_IMAGE_SIZE_LANDSCAPE = "1536x1024";
const FETCH_TIMEOUT_MS = 25000;
const STORY_LLM_TIMEOUT_MS = 45000;
/** Bump when changing behavior (check with GET /health or GET /api/health). */
const SERVER_REV = "prompt-cache-v1";
const STORY_JSON_SYSTEM_PROMPT =
  "You are a story dialogue engine. Reply with ONE valid JSON object in the assistant message content field only. No markdown fences, no text outside JSON.";

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
  const storyChatProvider = isAnthropicConfigured() ? "anthropic" : "none";
  const storyChatModel = isAnthropicConfigured() ? STORY_CHAT_ANTHROPIC_MODEL : "";
  return {
    ok: true,
    openaiConfigured: !!OPENAI_API_KEY,
    anthropicConfigured: isAnthropicConfigured(),
    storyChatProvider,
    storyChatModel,
    storySuggestionProvider: isAnthropicConfigured() ? "anthropic" : "none",
    storySuggestionModel: isAnthropicConfigured()
      ? STORY_SUGGESTION_ANTHROPIC_MODEL
      : "",
    liveCommentProvider: isAnthropicConfigured() ? "anthropic" : "openai",
    liveCommentModel: isAnthropicConfigured()
      ? LIVE_COMMENT_ANTHROPIC_MODEL
      : OPENAI_MODEL,
    storyCreationProvider: isAnthropicConfigured() ? "anthropic" : "none",
    storyCreationModel: isAnthropicConfigured() ? STORY_CREATION_ANTHROPIC_MODEL : "",
    storySceneProvider: isAnthropicConfigured() ? "anthropic" : "none",
    storySceneModel: isAnthropicConfigured() ? STORY_SCENE_ANTHROPIC_MODEL : "",
    deepseekConfigured: isDeepSeekConfigured(),
    chatLlmProvider: isAnthropicConfigured() ? "anthropic" : "none",
    chatLlmModel: isAnthropicConfigured() ? STORY_CREATION_ANTHROPIC_MODEL : "",
    provider: storyChatProvider,
    model: storyChatModel,
    rev: SERVER_REV,
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

function parsePromptJsonIfString(prompt) {
  if (typeof prompt !== "string") return null;
  const t = prompt.trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function isTruthyPublicFlag(value) {
  if (value === true) return true;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    return t === "true" || t === "1" || t === "yes";
  }
  return false;
}

function isPublicVisibilityValue(value) {
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "public";
  }
  return false;
}

function computeCustomPromptIsPublic(body, parsedPrompt) {
  if (isTruthyPublicFlag(body && body.is_public)) return true;
  if (isTruthyPublicFlag(body && body.isPublic)) return true;
  if (isPublicVisibilityValue(body && body.visibility)) return true;
  if (parsedPrompt && typeof parsedPrompt === "object") {
    if (isTruthyPublicFlag(parsedPrompt.is_public)) return true;
    if (isTruthyPublicFlag(parsedPrompt.isPublic)) return true;
    if (isPublicVisibilityValue(parsedPrompt.visibility)) return true;
  }
  return false;
}

function isExplicitCustomPromptPrivate(body, parsedPrompt) {
  const vals = [
    body && body.is_public,
    body && body.isPublic,
    body && body.visibility,
    parsedPrompt && parsedPrompt.is_public,
    parsedPrompt && parsedPrompt.isPublic,
    parsedPrompt && parsedPrompt.visibility,
  ];
  for (const v of vals) {
    if (v === false) return true;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "false" || t === "0" || t === "private" || t === "no") return true;
    }
  }
  return false;
}

function extractCustomPromptColumnString(parsed, keys) {
  if (!parsed || typeof parsed !== "object") return "";
  for (const key of keys) {
    const v = parsed[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function readCustomPromptPayload(body) {
  const raw = body && body.prompt;
  if (typeof raw === "string") {
    const promptStr = raw.trim();
    return {
      promptStr,
      parsedPrompt: parsePromptJsonIfString(promptStr),
    };
  }
  if (raw && typeof raw === "object") {
    return {
      promptStr: JSON.stringify(raw),
      parsedPrompt: raw,
    };
  }
  return { promptStr: "", parsedPrompt: null };
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
function isReasoningHeavyDeepSeekModel(modelStr) {
  const model = (modelStr || DEEPSEEK_MODEL).toLowerCase();
  return /v4|reasoner|r1|think/.test(model);
}

/** Claude 5 — adaptive thinking이 max_tokens 예산을 잡아먹어 text block이 비는 경우 방지. */
function isAnthropicThinkingHeavyModel(modelStr) {
  const model = (modelStr || "").trim().toLowerCase();
  return /claude-(sonnet|opus)-5(?:$|[-_])/.test(model);
}

function resolveStoryLlmMaxTokens(requested, modelStr) {
  const n = Number(requested);
  const base = Number.isFinite(n) && n > 0 ? Math.floor(n) : 620;
  if (isReasoningHeavyDeepSeekModel(modelStr)) {
    return Math.min(4096, Math.max(base, 1200));
  }
  if (isAnthropicThinkingHeavyModel(modelStr)) {
    // Sonnet/Opus 5 — 앱 요청(800~1100)을 존중. 4096 floor는 생성 지연·비용만 키움.
    const cap = 1200;
    const floor = 600;
    return Math.min(cap, Math.max(base, floor));
  }
  return Math.min(4096, Math.max(base, 620));
}

/** Anthropic story-chat JSON이 파싱 가능한지 — 잘림 시에만 상한 재시도. */
function storyChatJsonLooksComplete(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;
  if (!t.startsWith("{")) return t.length >= 80;
  try {
    JSON.parse(t);
    return true;
  } catch (_) {
    return false;
  }
}

function anthropicRetryMaxTokens(currentMax, { empty = false, truncated = false } = {}) {
  const cur = Number.isFinite(currentMax) && currentMax > 0 ? Math.floor(currentMax) : 800;
  if (truncated || empty) {
    return Math.min(8192, Math.max(cur * 2, 2048));
  }
  return cur;
}

function logAnthropicUsage({ logTag, modelId, max_tokens, text, raw, attempt = 0 }) {
  const usage = raw?.usage || {};
  const thinkingTokens = usage?.output_tokens_details?.thinking_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  console.log(
    `[${logTag}] anthropic usage model=${modelId} attempt=${attempt} ` +
      `max_tokens=${max_tokens} ` +
      `input_tokens=${usage.input_tokens ?? "?"} ` +
      `output_tokens=${usage.output_tokens ?? "?"} ` +
      `thinking_tokens=${thinkingTokens ?? "?"} ` +
      `cache_read_input_tokens=${cacheRead} ` +
      `cache_creation_input_tokens=${cacheCreate} ` +
      `replyLen=${(text || "").length}`,
  );
}

/** reasoning·마크다운 본문에서 첫 JSON 객체를 추출한다. */
function extractJsonObjectFromText(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  if (!t) return "";
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1].trim() : t;
  const start = src.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1).trim();
    }
  }
  return "";
}

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
function assistantTextFromMessage(
  msgObj,
  { allowReasoning = true, preferJson = false } = {},
) {
  if (!msgObj || typeof msgObj !== "object") return "";
  let out = assistantTextFromContent(msgObj.content);
  if (out) return out;
  if (!allowReasoning) return "";
  if (typeof msgObj.reasoning_content === "string") {
    if (preferJson) {
      out = extractJsonObjectFromText(msgObj.reasoning_content);
      if (out) return out;
    }
    out = assistantTextFromReasoning(msgObj.reasoning_content);
    if (out) return out;
  }
  return "";
}

function storyChatReplyLooksEmpty(text) {
  if (typeof text !== "string") return true;
  const t = text.trim();
  if (!t) return true;
  if (t.length >= 80 && !t.startsWith("{")) return false;
  try {
    const o = JSON.parse(t);
    if (!o || typeof o !== "object") return t.length < 80;
    const nar = (o.narrator || o.narration || "").toString().trim();
    if (nar) return false;
    const lines = Array.isArray(o.lines) ? o.lines : [];
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const body = (line.text || line.line || "").toString().trim();
      const speaker = (line.speaker || line.name || "").toString().trim();
      if (body || speaker) return false;
    }
    for (const key of ["summon", "summons", "exit", "exits"]) {
      if (Array.isArray(o[key]) && o[key].length > 0) return false;
    }
    return true;
  } catch (_) {
    return t.length < 80;
  }
}

/** Chat Completions — `/comment`(제작·DM·상담), story-chat scene prediction (DeepSeek). */
async function callOpenAiCompletion({
  userPrompt,
  temperature,
  max_tokens,
  logTag,
  systemPrompt,
  jsonMode = false,
  allowReasoning = true,
  preferJson = false,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  _attempt = 0,
}) {
  const llm = resolveDeepSeekConfig();
  if (!llm) {
    logDeepSeekNotConfigured(logTag);
    return {
      ok: false,
      provider: "deepseek",
      status: 503,
      errorText: "DeepSeek is not configured",
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
      model: llm.model,
      temperature,
      ...chatCompletionTokenLimit(max_tokens, llm.model),
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
  } catch (stringifyErr) {
    console.error(`[${logTag}] JSON.stringify(chat payload) failed:`, stringifyErr);
    return {
      ok: false,
      provider: llm.provider,
      status: 400,
      errorText: "프롬프트 인코딩에 실패했습니다.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

  let oaiRes;
  try {
    oaiRes = await fetch(llm.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: payload,
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    const msg = fetchErr?.message || String(fetchErr);
    console.error(`[${logTag}] ${llm.provider} fetch error:`, msg);
    return {
      ok: false,
      provider: llm.provider,
      status: fetchErr?.name === "AbortError" ? 504 : 502,
      errorText:
        fetchErr?.name === "AbortError"
          ? "요청 시간이 초과되었습니다."
          : "AI 서버 연결이 불안정합니다. 잠시 후 다시 시도해 주세요.",
    };
  } finally {
    clearTimeout(timer);
  }

  const rawText = await oaiRes.text();
  const safeRaw = typeof rawText === "string" ? rawText : String(rawText ?? "");
  let json = {};
  if (safeRaw) {
    try {
      json = JSON.parse(safeRaw);
    } catch (parseErr) {
      console.log(`[${logTag}] ${llm.provider} JSON parse`, parseErr.message);
      return {
        ok: false,
        provider: llm.provider,
        status: 502,
        errorText: "응답을 해석할 수 없습니다.",
      };
    }
  }

  if (!oaiRes.ok) {
    const apiMsg = openAiErrorMessage(json) || "LLM 요청에 실패했습니다.";
    const statusOut = oaiRes.status >= 500 ? 502 : oaiRes.status;
    console.log(
      `[${logTag}] ${llm.provider} HTTP ${oaiRes.status} model=${llm.model}`,
    );
    return {
      ok: false,
      provider: llm.provider,
      status: statusOut,
      errorText: apiMsg,
    };
  }

  const choices = Array.isArray(json?.choices) ? json.choices : [];
  const first = choices[0];
  const msgObj = first && first.message;
  let text = assistantTextFromMessage(msgObj, { allowReasoning, preferJson });
  if (!text && first && typeof first.text === "string") {
    text = first.text.trim();
  }

  if (!text) {
    const finishReason = first?.finish_reason || "unknown";
    const reasoningLength =
      typeof msgObj?.reasoning_content === "string"
        ? msgObj.reasoning_content.length
        : 0;
    console.log(
      `[${logTag}] No assistant content provider=${llm.provider} model=${llm.model} ` +
        `attempt=${_attempt} finish_reason=${finishReason} reasoningLen=${reasoningLength}`,
    );
    if (_attempt === 0) {
      // v4/reasoning 모델은 추론 토큰만 먼저 소진해 content가 비는 경우가 있다.
      const retryFloor = isReasoningHeavyDeepSeekModel(llm.model) ? 4096 : 2048;
      const retryMaxTokens = Math.max(max_tokens, retryFloor);
      if (jsonMode) {
        console.log(
          `[${logTag}] retry without json_mode max_tokens=${retryMaxTokens} allowReasoning=true`,
        );
        return callOpenAiCompletion({
          userPrompt,
          temperature,
          max_tokens: retryMaxTokens,
          logTag,
          systemPrompt,
          jsonMode: false,
          allowReasoning: true,
          preferJson,
          fetchTimeoutMs,
          _attempt: 1,
        });
      }
      console.log(
        `[${logTag}] retry same mode max_tokens=${retryMaxTokens} allowReasoning=true`,
      );
      return callOpenAiCompletion({
        userPrompt,
        temperature,
        max_tokens: retryMaxTokens,
        logTag,
        systemPrompt,
        jsonMode,
        allowReasoning: true,
        preferJson,
        fetchTimeoutMs,
        _attempt: 1,
      });
    }
    return {
      ok: false,
      provider: llm.provider,
      status: 502,
      errorText:
        logTag === "story-chat"
          ? "스토리 대화 생성 실패"
          : logTag === "story-suggestions"
            ? "추천문 생성 실패"
            : "AI 응답 생성 실패",
    };
  }

  console.log(`[${logTag}] provider=${llm.provider} model=${llm.model}`);
  return {
    ok: true,
    provider: llm.provider,
    model: llm.model,
    text,
    raw: json,
  };
}

function anthropicTextFromResponse(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) return t;
    }
  }
  return "";
}

function anthropicErrorMessage(json) {
  if (!json || typeof json !== "object") return "";
  const err = json.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err.message === "string" && err.message.trim()) {
    return err.message.trim();
  }
  return "";
}

function anthropicSupportsTemperature(modelStr) {
  const model = (modelStr || "").trim().toLowerCase();
  // Opus 4.7+, Sonnet/Opus 5 — Messages API에서 temperature deprecated.
  if (/claude-opus-4-7(?:$|[-_])/.test(model)) return false;
  if (/claude-(sonnet|opus)-5(?:$|[-_])/.test(model)) return false;
  return true;
}

/** story-chat Prompt Caching — Anthropic ephemeral prefix (2048+ tok). */
const STORY_CHAT_PROMPT_CACHE_ENABLED = process.env.STORY_CHAT_PROMPT_CACHE !== "false";

function readStoryChatPromptSegments(body) {
  const raw =
    (body && body.prompt_segments) || (body && body.prompt_token_audit);
  if (!raw || typeof raw !== "object") return null;
  const staticEngine = readString(raw, "static_engine");
  const nodeStatic = readString(raw, "node_static");
  const dynamicContext = readString(raw, "dynamic_context");
  const nodeId = readString(raw, "node_id");
  if (!staticEngine && !nodeStatic && !dynamicContext) return null;
  return { staticEngine, nodeStatic, dynamicContext, nodeId };
}

function buildStoryChatAnthropicUserContent({
  staticEngine,
  nodeStatic,
  dynamicContext,
  fullUserPrompt,
}) {
  const prefix = buildStoryChatCacheablePrefix(staticEngine, nodeStatic);
  if (!STORY_CHAT_PROMPT_CACHE_ENABLED || !prefix.trim()) {
    return { content: fullUserPrompt, cached: false };
  }
  const dynamicBlock = buildStoryChatDynamicContextBlock(dynamicContext);
  const blocks = [
    { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
  ];
  if (dynamicBlock.trim()) {
    blocks.push({ type: "text", text: `\n\n${dynamicBlock}` });
  }
  return { content: blocks, cached: true };
}

function buildAnthropicMessagesBody({
  model,
  userPrompt,
  systemPrompt,
  temperature,
  max_tokens,
  stream = false,
  disableThinking = false,
  promptSegments = null,
}) {
  let messageContent = userPrompt;
  if (promptSegments) {
    const built = buildStoryChatAnthropicUserContent({
      staticEngine: promptSegments.staticEngine,
      nodeStatic: promptSegments.nodeStatic,
      dynamicContext: promptSegments.dynamicContext,
      fullUserPrompt: userPrompt,
    });
    messageContent = built.content;
    if (built.cached) {
      console.log("[story-chat] prompt_cache prefix=ephemeral");
    }
  }
  const body = {
    model: (model || ANTHROPIC_MODEL).trim(),
    max_tokens,
    messages: [{ role: "user", content: messageContent }],
  };
  if (typeof systemPrompt === "string" && systemPrompt.trim()) {
    body.system = systemPrompt.trim();
  }
  if (
    typeof temperature === "number" &&
    Number.isFinite(temperature) &&
    anthropicSupportsTemperature(body.model)
  ) {
    body.temperature = temperature;
  }
  if (disableThinking && isAnthropicThinkingHeavyModel(body.model)) {
    body.thinking = { type: "disabled" };
  }
  if (stream) body.stream = true;
  return body;
}

/** story-chat Prompt Caching 사전 실측 — Anthropic count_tokens (cache_control 없음). */
const _promptAuditPrevByNode = new Map();

async function countAnthropicInputTokens({ model, system, userContent }) {
  if (!ANTHROPIC_API_KEY) return null;
  const userText =
    typeof userContent === "string" && userContent.trim()
      ? userContent.trim()
      : ".";
  const body = {
    model: (model || STORY_CHAT_ANTHROPIC_MODEL).trim(),
    messages: [{ role: "user", content: userText }],
  };
  if (typeof system === "string" && system.trim()) {
    body.system = system.trim();
  }
  try {
    const response = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch (_) {
      console.error("[promptTokenAudit] count_tokens parse failed");
      return null;
    }
    if (!response.ok) {
      console.error(
        "[promptTokenAudit] count_tokens http",
        response.status,
        json?.error?.message || raw.slice(0, 200),
      );
      return null;
    }
    return typeof json.input_tokens === "number" ? json.input_tokens : null;
  } catch (e) {
    console.error("[promptTokenAudit] count_tokens error", e?.message || e);
    return null;
  }
}

function buildStoryChatCacheablePrefix(staticEngine, nodeStatic) {
  const a = (staticEngine || "").trim();
  const b = (nodeStatic || "").trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}

function buildStoryChatDynamicContextBlock(dynamicContext) {
  const d = (dynamicContext || "").trim();
  if (!d) return "";
  return `[엔진 story_context]\n${d}`;
}

async function auditStoryChatPromptTokens({
  model,
  anthropicSystem,
  staticEngine,
  nodeStatic,
  dynamicContext,
  fullUserPrompt,
  nodeId,
  storyId,
}) {
  const cacheablePrefix = buildStoryChatCacheablePrefix(staticEngine, nodeStatic);
  const dynamicBlock = buildStoryChatDynamicContextBlock(dynamicContext);

  const [
    anthropicSystemTokens,
    staticEngineTokens,
    nodeStaticTokens,
    dynamicContextTokens,
    fullInputTokens,
    cacheablePrefixTokens,
  ] = await Promise.all([
    countAnthropicInputTokens({
      model,
      system: anthropicSystem,
      userContent: "",
    }),
    countAnthropicInputTokens({ model, userContent: (staticEngine || "").trim() }),
    countAnthropicInputTokens({ model, userContent: (nodeStatic || "").trim() }),
    countAnthropicInputTokens({ model, userContent: dynamicBlock }),
    countAnthropicInputTokens({
      model,
      system: anthropicSystem,
      userContent: (fullUserPrompt || "").trim(),
    }),
    countAnthropicInputTokens({ model, userContent: cacheablePrefix }),
  ]);

  const auditKey = `${storyId || "(none)"}|${nodeId || "(none)"}`;
  const prev = _promptAuditPrevByNode.get(auditKey);
  const cacheablePrefixSame =
    prev != null && prev.cacheablePrefix === cacheablePrefix;
  _promptAuditPrevByNode.set(auditKey, {
    cacheablePrefix,
    at: Date.now(),
  });

  const result = {
    anthropicSystemTokens,
    staticEngineTokens,
    nodeStaticTokens,
    dynamicContextTokens,
    fullInputTokens,
    cacheablePrefixTokens,
    cacheablePrefixSame,
    nodeId: nodeId || "",
  };

  console.log("[promptTokenAudit]");
  console.log(`anthropicSystemTokens=${anthropicSystemTokens ?? "?"}`);
  console.log(`staticEngineTokens=${staticEngineTokens ?? "?"}`);
  console.log(`nodeStaticTokens=${nodeStaticTokens ?? "?"}`);
  console.log(`dynamicContextTokens=${dynamicContextTokens ?? "?"}`);
  console.log(`fullInputTokens=${fullInputTokens ?? "?"}`);
  console.log(`cacheablePrefixTokens=${cacheablePrefixTokens ?? "?"}`);
  console.log(`cacheablePrefixSame=${cacheablePrefixSame}`);
  if (nodeId) {
    console.log(`nodeId=${nodeId}`);
  }
  return result;
}

function normalizeAnthropicStoryReply(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  const extracted = extractJsonObjectFromText(trimmed);
  return extracted || trimmed;
}

/** Claude Messages API — story-chat·추천·실시간 댓글 공통. */
async function callAnthropicCompletion({
  model,
  userPrompt,
  systemPrompt,
  temperature,
  max_tokens,
  logTag,
  fetchTimeoutMs = STORY_LLM_TIMEOUT_MS,
  _attempt = 0,
  disableThinking = false,
  promptSegments = null,
}) {
  const modelId = (model || ANTHROPIC_MODEL).trim();
  if (!ANTHROPIC_API_KEY) {
    return {
      ok: false,
      provider: "anthropic",
      status: 503,
      errorText: "Anthropic is not configured",
      skipped: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const body = buildAnthropicMessagesBody({
    model: modelId,
    userPrompt,
    systemPrompt,
    temperature,
    max_tokens,
    disableThinking,
    promptSegments,
  });

  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {
        ok: false,
        provider: "anthropic",
        status: 502,
        errorText: "Anthropic 응답 해석 실패",
      };
    }
    if (!response.ok) {
      const errMsg = anthropicErrorMessage(json) || "Anthropic 요청 실패";
      console.log(
        `[${logTag}] Anthropic HTTP ${response.status} model=${modelId} attempt=${_attempt} err=${errMsg.slice(0, 200)}`,
      );
      if (
        _attempt === 0 &&
        (response.status === 529 || response.status >= 500)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return callAnthropicCompletion({
          model,
          userPrompt,
          systemPrompt,
          temperature,
          max_tokens,
          logTag,
          fetchTimeoutMs,
          _attempt: 1,
          disableThinking,
          promptSegments,
        });
      }
      return {
        ok: false,
        provider: "anthropic",
        status: response.status >= 500 ? 502 : response.status,
        errorText: errMsg,
      };
    }
    let text = anthropicTextFromResponse(json);
    if (logTag === "story-chat" || logTag === "story-chat-stream") {
      text = normalizeAnthropicStoryReply(text);
    }
    if (!text) {
      const stopReason = json?.stop_reason || "";
      const usage = json?.usage || {};
      const thinkingTokens = usage?.output_tokens_details?.thinking_tokens;
      console.warn(
        `[${logTag}] Anthropic empty text model=${modelId} attempt=${_attempt} ` +
          `stop_reason=${stopReason} max_tokens=${max_tokens} ` +
          `output_tokens=${usage?.output_tokens ?? "?"} thinking_tokens=${thinkingTokens ?? "?"}`,
      );
      const retryMax = anthropicRetryMaxTokens(max_tokens, {
        empty: true,
        truncated: stopReason === "max_tokens",
      });
      if (_attempt === 0 && (stopReason === "max_tokens" || retryMax > max_tokens)) {
        return callAnthropicCompletion({
          model,
          userPrompt,
          systemPrompt,
          temperature,
          max_tokens: retryMax,
          logTag,
          fetchTimeoutMs,
          _attempt: 1,
          disableThinking,
          promptSegments,
        });
      }
      return {
        ok: false,
        provider: "anthropic",
        status: 502,
        errorText:
          logTag === "story-chat"
            ? "스토리 대화 생성 실패"
            : logTag === "story-suggestions"
              ? "추천문 생성 실패"
              : "Anthropic 빈 응답",
      };
    }
    console.log(`[${logTag}] provider=anthropic model=${modelId}`);
    logAnthropicUsage({
      logTag,
      modelId,
      max_tokens,
      text,
      raw: json,
      attempt: _attempt,
    });
    return {
      ok: true,
      provider: "anthropic",
      model: modelId,
      text,
      raw: json,
    };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    console.error(`[${logTag}] Anthropic error:`, error?.message || error);
    return {
      ok: false,
      provider: "anthropic",
      status: timeout ? 504 : 502,
      errorText: timeout ? "Anthropic 요청 시간 초과" : "Anthropic 연결 실패",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Claude Messages API streaming — story-chat 전용. */
async function callAnthropicCompletionStream({
  model,
  userPrompt,
  systemPrompt,
  temperature,
  max_tokens,
  logTag,
  onDelta,
  onFirstToken,
  fetchTimeoutMs = STORY_LLM_TIMEOUT_MS,
  disableThinking = false,
  promptSegments = null,
  _attempt = 0,
}) {
  const modelId = (model || STORY_CHAT_ANTHROPIC_MODEL).trim();
  if (!ANTHROPIC_API_KEY) {
    return {
      ok: false,
      status: 503,
      errorText: "Anthropic is not configured",
    };
  }

  const body = buildAnthropicMessagesBody({
    model: modelId,
    userPrompt,
    systemPrompt,
    temperature,
    max_tokens,
    stream: true,
    disableThinking,
    promptSegments,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

  let response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timeout = error?.name === "AbortError";
    return {
      ok: false,
      status: timeout ? 504 : 502,
      errorText: timeout ? "Anthropic 요청 시간 초과" : "Anthropic 연결 실패",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch (_) {}
    return {
      ok: false,
      status: response.status >= 500 ? 502 : response.status,
      errorText: anthropicErrorMessage(json) || "Anthropic 요청 실패",
    };
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    return { ok: false, status: 502, errorText: "스트림을 열 수 없습니다." };
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let firstTokenSent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch (_) {
        continue;
      }
      const piece =
        chunk?.delta?.text ||
        chunk?.delta?.partial_json ||
        (chunk?.type === "content_block_delta" &&
        chunk?.delta?.type === "text_delta"
          ? chunk.delta.text
          : "");
      if (!piece || typeof piece !== "string") continue;
      fullText += piece;
      if (!firstTokenSent) {
        firstTokenSent = true;
        if (typeof onFirstToken === "function") onFirstToken();
      }
      if (typeof onDelta === "function") onDelta(piece);
    }
  }

  fullText = fullText.trim();
  if (logTag === "story-chat" || logTag === "story-chat-stream") {
    fullText = normalizeAnthropicStoryReply(fullText);
  }
  if (!fullText) {
    if (_attempt === 0) {
      const retryMax = anthropicRetryMaxTokens(max_tokens, { empty: true });
      console.log(
        `[${logTag}] anthropic stream empty — retry once max_tokens=${retryMax}`,
      );
      return callAnthropicCompletionStream({
        model: modelId,
        userPrompt,
        systemPrompt,
        temperature,
        max_tokens: retryMax,
        logTag,
        onDelta,
        onFirstToken,
        fetchTimeoutMs,
        disableThinking,
        promptSegments,
        _attempt: 1,
      });
    }
    return { ok: false, status: 502, errorText: "empty reply" };
  }

  console.log(`[${logTag}] stream complete provider=anthropic model=${modelId}`);
  return {
    ok: true,
    provider: "anthropic",
    model: modelId,
    text: fullText,
    raw: { stream: true, model: modelId },
  };
}

/** 실시간 댓글 — Claude Opus 5. DeepSeek·스토리 대사 큐와 분리. */
async function callAnthropicLiveCommentCompletion({
  userPrompt,
  temperature,
  max_tokens,
  logTag,
}) {
  return callAnthropicCompletion({
    model: LIVE_COMMENT_ANTHROPIC_MODEL,
    userPrompt,
    systemPrompt:
      "Reply with ONE valid JSON object only. No markdown fences or extra text.",
    temperature,
    max_tokens,
    logTag,
    fetchTimeoutMs: 12000,
    disableThinking: true,
  });
}

/** Anthropic 미설정 시 로컬/Render dev용 OpenAI fallback. */
async function callOpenAiLiveCommentCompletion({
  userPrompt,
  temperature,
  max_tokens,
  logTag,
}) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      status: 503,
      errorText: "OpenAI is not configured",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature,
        ...openAiCompletionTokenLimit(max_tokens),
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch (_) {
      return { ok: false, status: 502, errorText: "OpenAI 응답 해석 실패" };
    }
    if (!response.ok) {
      console.log(`[${logTag}] OpenAI HTTP ${response.status} model=${OPENAI_MODEL}`);
      return {
        ok: false,
        status: response.status >= 500 ? 502 : response.status,
        errorText: openAiErrorMessage(json) || "OpenAI 요청 실패",
      };
    }
    const first = Array.isArray(json.choices) ? json.choices[0] : null;
    const text = assistantTextFromContent(first?.message?.content);
    if (!text) {
      return { ok: false, status: 502, errorText: "OpenAI 빈 응답" };
    }
    console.log(`[${logTag}] provider=openai model=${OPENAI_MODEL}`);
    return { ok: true, model: OPENAI_MODEL, text };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    console.error(`[${logTag}] OpenAI error:`, error?.message || error);
    return {
      ok: false,
      status: timeout ? 504 : 502,
      errorText: timeout ? "OpenAI 요청 시간 초과" : "OpenAI 연결 실패",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat Completions streaming — DeepSeek only.
 * @returns {{ ok: boolean, text?: string, raw?: object, errorText?: string, status?: number }}
 */
async function callOpenAiCompletionStream({
  userPrompt,
  temperature,
  max_tokens,
  logTag,
  systemPrompt,
  onDelta,
  onFirstToken,
  jsonMode = false,
  allowReasoning = true,
  _attempt = 0,
}) {
  const llm = resolveDeepSeekConfig();
  if (!llm) {
    logDeepSeekNotConfigured(logTag);
    return {
      ok: false,
      status: 503,
      errorText: "DeepSeek is not configured",
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
      model: llm.model,
      temperature,
      ...chatCompletionTokenLimit(max_tokens, llm.model),
      stream: true,
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
  } catch (stringifyErr) {
    console.error(`[${logTag}] stream payload failed:`, stringifyErr);
    return { ok: false, status: 400, errorText: "프롬프트 인코딩에 실패했습니다." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let oaiRes;
  try {
    oaiRes = await fetch(llm.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: payload,
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    const msg = fetchErr?.message || String(fetchErr);
    console.error(`[${logTag}] ${llm.provider} stream fetch error:`, msg);
    return {
      ok: false,
      status: fetchErr?.name === "AbortError" ? 504 : 502,
      errorText:
        fetchErr?.name === "AbortError"
          ? "요청 시간이 초과되었습니다."
          : "AI 서버 연결이 불안정합니다. 잠시 후 다시 시도해 주세요.",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!oaiRes.ok) {
    const rawText = await oaiRes.text().catch(() => "");
    let json = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (_) {}
    const apiMsg = openAiErrorMessage(json) || "LLM 요청에 실패했습니다.";
    return {
      ok: false,
      status: oaiRes.status >= 500 ? 502 : oaiRes.status,
      errorText: apiMsg,
    };
  }

  const reader = oaiRes.body?.getReader?.();
  if (!reader) {
    return { ok: false, status: 502, errorText: "스트림을 열 수 없습니다." };
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let firstTokenSent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch (_) {
        continue;
      }
      const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
      const delta = choices[0]?.delta;
      let piece = "";
      if (delta && typeof delta.content === "string") {
        piece = delta.content;
      } else if (
        allowReasoning &&
        delta &&
        typeof delta.reasoning_content === "string"
      ) {
        piece = delta.reasoning_content;
      } else if (choices[0]?.text) {
        piece = String(choices[0].text);
      }
      if (!piece) continue;
      fullText += piece;
      if (!firstTokenSent) {
        firstTokenSent = true;
        if (typeof onFirstToken === "function") onFirstToken();
      }
      if (typeof onDelta === "function") onDelta(piece);
    }
  }

  fullText = fullText.trim();
  if (!fullText) {
    if (_attempt === 0) {
      console.log(
        `[${logTag}] stream empty — retry once jsonMode=${jsonMode} max_tokens=${Math.max(max_tokens, 1200)}`,
      );
      return callOpenAiCompletionStream({
        userPrompt,
        temperature,
        max_tokens: Math.max(max_tokens, 1200),
        logTag,
        systemPrompt,
        onDelta,
        onFirstToken,
        jsonMode: false,
        allowReasoning: false,
        _attempt: 1,
      });
    }
    return { ok: false, status: 502, errorText: "empty reply" };
  }

  console.log(`[${logTag}] stream complete provider=${llm.provider} model=${llm.model}`);
  return {
    ok: true,
    provider: llm.provider,
    model: llm.model,
    text: fullText,
    raw: { stream: true, model: llm.model },
  };
}

function writeSse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** 모델명만 던지는 쓰레기 응답(동형 문자·ZWSP 등) 거르기. */
function isGarbageModelLine(s, modelStr) {
  const chatLlm = resolveDeepSeekConfig();
  const model =
    typeof modelStr === "string" && modelStr.trim()
      ? modelStr.trim()
      : chatLlm?.model || DEEPSEEK_MODEL;
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

    if (!isAnthropicConfigured()) {
      console.error("[comment] Anthropic is not configured (set ANTHROPIC_API_KEY)");
      return res.status(503).json({ text: "Anthropic is not configured" });
    }
    console.log(
      `[comment] provider=anthropic model=${STORY_CREATION_ANTHROPIC_MODEL}`,
    );

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

    const jsonMode = /\bjson\b/i.test(cleanedPrompt);
    const effectiveMaxTokens = jsonMode ? Math.max(max_tokens, 1200) : max_tokens;

    const llmResult = await callAnthropicCompletion({
      model: STORY_CREATION_ANTHROPIC_MODEL,
      userPrompt: cleanedPrompt,
      systemPrompt: jsonMode ? STORY_JSON_SYSTEM_PROMPT : undefined,
      temperature,
      max_tokens: effectiveMaxTokens,
      logTag: "comment",
      fetchTimeoutMs: STORY_LLM_TIMEOUT_MS,
      disableThinking: true,
    });

    if (!llmResult.ok) {
      const statusOut = llmResult.status || 502;
      return res.status(statusOut).json({
        text: llmResult.errorText || "Anthropic request failed",
      });
    }

    const text = llmResult.text;

    if (isGarbageModelLine(text, llmResult.model || STORY_CREATION_ANTHROPIC_MODEL)) {
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

/** 스토리·채팅의 관중 댓글 전용 — Claude(우선) 또는 OpenAI fallback. */
async function handleLiveCommentsPost(req, res) {
  res.setHeader("X-AI-Server-Rev", SERVER_REV);
  const prompt = readString(req.body, "prompt");
  if (!prompt) {
    return res.status(400).json({ text: "prompt 필드가 필요합니다." });
  }
  const liveCommentArgs = {
    userPrompt: prompt.slice(0, MAX_PROMPT_CHARS),
    temperature: 1,
    max_tokens: 240,
    logTag: "live-comments",
  };
  const result = isAnthropicConfigured()
    ? await callAnthropicLiveCommentCompletion(liveCommentArgs)
    : await callOpenAiLiveCommentCompletion(liveCommentArgs);
  if (!result.ok) {
    return res
      .status(result.status || 502)
      .json({ text: result.errorText || "댓글 생성 실패" });
  }
  return res.json({ text: result.text });
}

function resolveStorySuggestionMaxTokens(requested) {
  const model = isAnthropicConfigured()
    ? STORY_SUGGESTION_ANTHROPIC_MODEL
    : DEEPSEEK_MODEL;
  return resolveStoryLlmMaxTokens(requested, model);
}

/** 스토리 beat 추천 재작성 — Claude Opus 4.6 (Anthropic 필수). */
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

    if (!isAnthropicConfigured()) {
      console.error(
        "[story-suggestions] Anthropic is not configured (set ANTHROPIC_API_KEY)",
      );
      return res.status(503).json({ text: "Anthropic is not configured" });
    }
    console.log(
      `[story-suggestions] provider=anthropic model=${STORY_SUGGESTION_ANTHROPIC_MODEL}`,
    );

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
        `slotCount=${slotCount} promptLen=${cleanedPrompt.length} maxTokens=${max_tokens}`,
    );

    const llmResult = await callAnthropicCompletion({
      model: STORY_SUGGESTION_ANTHROPIC_MODEL,
      userPrompt: cleanedPrompt,
      systemPrompt: STORY_JSON_SYSTEM_PROMPT,
      temperature,
      max_tokens,
      logTag: "story-suggestions",
      fetchTimeoutMs: STORY_LLM_TIMEOUT_MS,
    });

    if (!llmResult.ok) {
      const statusOut = llmResult.status || 502;
      const errorText = llmResult.errorText || "Anthropic request failed";
      return res.status(statusOut).json({ text: errorText });
    }

    const text = llmResult.text;
    const modelForGarbageCheck = llmResult.model || STORY_SUGGESTION_ANTHROPIC_MODEL;
    if (isGarbageModelLine(text, modelForGarbageCheck)) {
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
app.post("/api/live-comments", handleLiveCommentsPost);
app.post("/live-comments", handleLiveCommentsPost);

app.post("/api/story-suggestions", handleStorySuggestionsPost);
app.post("/story-suggestions", handleStorySuggestionsPost);

app.post("/api/comment-save", handleCommentSave);
app.post("/comment-save", handleCommentSave);

app.post("/api/commenter-state", handleCommenterStatePost);
app.post("/commenter-state", handleCommenterStatePost);

const ADMIN_PRESENCE_PASSWORD = process.env.ADMIN_PASSWORD || "333";

function isAdminPresenceAuthorized(req) {
  const header = (req.headers["x-admin-password"] || "").toString().trim();
  const query = readString(req.query || {}, "admin_password");
  return header === ADMIN_PRESENCE_PASSWORD || query === ADMIN_PRESENCE_PASSWORD;
}

// 가상 스토리 제작자 — 앱 전역(모든 사용자 동일 표시) · 관리자 POST만
const VIRTUAL_STORY_CREATOR_GLOBAL_USER_ID = "__global__";

async function readVirtualStoryCreatorRow(supabase, userId) {
  return supabase
    .from("virtual_story_creator_prefs")
    .select("profiles, assignments, updated_at_ms")
    .eq("user_id", userId)
    .maybeSingle();
}

function jsonVirtualStoryCreatorPrefs(data) {
  if (!data) {
    return {
      ok: true,
      profiles: [],
      assignments: {},
      updated_at_ms: 0,
    };
  }
  return {
    ok: true,
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
    assignments:
      data.assignments && typeof data.assignments === "object"
        ? data.assignments
        : {},
    updated_at_ms: Number(data.updated_at_ms) || 0,
  };
}

async function handleVirtualStoryCreatorsPublicGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const { data, error } = await readVirtualStoryCreatorRow(
      supabase,
      VIRTUAL_STORY_CREATOR_GLOBAL_USER_ID,
    );

    if (error) {
      logSupabaseErr("[virtual-story-creators public]", error);
      return res.status(500).json({ ok: false, error: "조회 실패" });
    }

    return res.json(jsonVirtualStoryCreatorPrefs(data));
  } catch (e) {
    console.log("[virtual-story-creators public]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

app.get("/api/virtual-story-creators/public", handleVirtualStoryCreatorsPublicGet);
app.get("/virtual-story-creators/public", handleVirtualStoryCreatorsPublicGet);

async function handleVirtualStoryCreatorsGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const userId = decodeURIComponent(req.params.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId 필요" });
    }

    const { data, error } = await readVirtualStoryCreatorRow(supabase, userId);

    if (error) {
      logSupabaseErr("[virtual-story-creators] get", error);
      return res.status(500).json({ ok: false, error: "조회 실패" });
    }

    return res.json(jsonVirtualStoryCreatorPrefs(data));
  } catch (e) {
    console.log("[virtual-story-creators get]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

app.get("/api/virtual-story-creators/:userId", handleVirtualStoryCreatorsGet);
app.get("/virtual-story-creators/:userId", handleVirtualStoryCreatorsGet);

async function handleVirtualStoryCreatorsPost(req, res) {
  try {
    if (!isAdminPresenceAuthorized(req)) {
      return res.status(403).json({ ok: false, error: "관리자 권한 필요" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const profilesRaw = req.body.profiles;
    const assignmentsRaw = req.body.assignments;
    if (!Array.isArray(profilesRaw)) {
      return res.status(400).json({ ok: false, error: "profiles 배열 필요" });
    }
    if (
      assignmentsRaw != null &&
      (typeof assignmentsRaw !== "object" || Array.isArray(assignmentsRaw))
    ) {
      return res.status(400).json({ ok: false, error: "assignments 객체 필요" });
    }

    const updated_at_ms = readInt(req.body, "updated_at_ms", Date.now());
    const row = {
      user_id: VIRTUAL_STORY_CREATOR_GLOBAL_USER_ID,
      profiles: profilesRaw,
      assignments: assignmentsRaw && typeof assignmentsRaw === "object" ? assignmentsRaw : {},
      updated_at_ms,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("virtual_story_creator_prefs")
      .upsert(row, { onConflict: "user_id" });

    if (error) {
      logSupabaseErr("[virtual-story-creators] upsert", error);
      return res.status(500).json({ ok: false, error: "저장 실패" });
    }

    console.log("✅ [virtual-story-creators] global upsert", updated_at_ms);
    return res.json({ ok: true, updated_at_ms });
  } catch (e) {
    console.log("[virtual-story-creators post]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

app.post("/api/virtual-story-creators", handleVirtualStoryCreatorsPost);
app.post("/virtual-story-creators", handleVirtualStoryCreatorsPost);

// 스토리 좋아요·즐겨찾기 — 전역 표시 · 관리자 POST(333)
const STORY_SOCIAL_STATS_GLOBAL_USER_ID = "__global__";

async function readStorySocialStatsRow(supabase, userId) {
  return supabase
    .from("story_social_stats_prefs")
    .select("stats, updated_at_ms")
    .eq("user_id", userId)
    .maybeSingle();
}

function jsonStorySocialStatsPrefs(data) {
  const statsRaw = data?.stats;
  const stats =
    statsRaw && typeof statsRaw === "object" && !Array.isArray(statsRaw)
      ? statsRaw
      : {};
  return {
    ok: true,
    stats,
    updated_at_ms: Number(data?.updated_at_ms) || 0,
  };
}

async function handleStorySocialStatsPublicGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const { data, error } = await readStorySocialStatsRow(
      supabase,
      STORY_SOCIAL_STATS_GLOBAL_USER_ID,
    );
    if (error) {
      logSupabaseErr("[story-social-stats public]", error);
      return res.status(500).json({ ok: false, error: "조회 실패" });
    }
    return res.json(jsonStorySocialStatsPrefs(data));
  } catch (e) {
    console.log("[story-social-stats public]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

app.get("/api/story-social-stats/public", handleStorySocialStatsPublicGet);
app.get("/story-social-stats/public", handleStorySocialStatsPublicGet);

async function handleStorySocialStatsPost(req, res) {
  try {
    if (!isAdminPresenceAuthorized(req)) {
      return res.status(403).json({ ok: false, error: "관리자 권한 필요" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const statsRaw = req.body.stats;
    if (statsRaw != null && (typeof statsRaw !== "object" || Array.isArray(statsRaw))) {
      return res.status(400).json({ ok: false, error: "stats 객체 필요" });
    }

    const updated_at_ms = readInt(req.body, "updated_at_ms", Date.now());
    const row = {
      user_id: STORY_SOCIAL_STATS_GLOBAL_USER_ID,
      stats: statsRaw && typeof statsRaw === "object" ? statsRaw : {},
      updated_at_ms,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("story_social_stats_prefs")
      .upsert(row, { onConflict: "user_id" });

    if (error) {
      logSupabaseErr("[story-social-stats] upsert", error);
      return res.status(500).json({ ok: false, error: "저장 실패" });
    }

    return res.json({ ok: true, updated_at_ms });
  } catch (e) {
    console.log("[story-social-stats post]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

app.post("/api/story-social-stats", handleStorySocialStatsPost);
app.post("/story-social-stats", handleStorySocialStatsPost);

function kstStartOfTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return new Date(`${y}-${m}-${d}T00:00:00+09:00`).toISOString();
}

async function handleUserPresencePost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "user_id 필요" });
    }

    const nowIso = new Date().toISOString();
    const row = {
      user_id,
      last_seen_at: nowIso,
      updated_at: nowIso,
      current_screen: readString(req.body, "current_screen") || null,
      app_version: readString(req.body, "app_version") || null,
      platform: readString(req.body, "platform") || null,
      last_event: readString(req.body, "last_event") || null,
    };

    const { error } = await supabase.from("user_presence").upsert([row], {
      onConflict: "user_id",
    });

    if (error) {
      logSupabaseErr("[user-presence] upsert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.log("[user-presence]", e);
    return res.status(500).json({ ok: false });
  }
}

async function handleAdminPresenceStatsGet(req, res) {
  try {
    if (!isAdminPresenceAuthorized(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const now = Date.now();
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const todayStart = kstStartOfTodayIso();

    const [active5m, lastHour, today] = await Promise.all([
      supabase
        .from("user_presence")
        .select("*", { count: "exact", head: true })
        .gte("last_seen_at", fiveMinAgo),
      supabase
        .from("user_presence")
        .select("*", { count: "exact", head: true })
        .gte("last_seen_at", oneHourAgo),
      supabase
        .from("user_presence")
        .select("*", { count: "exact", head: true })
        .gte("last_seen_at", todayStart),
    ]);

    if (active5m.error || lastHour.error || today.error) {
      const err = active5m.error || lastHour.error || today.error;
      logSupabaseErr("[admin/presence-stats]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }

    return res.json({
      ok: true,
      active_5m: active5m.count ?? 0,
      last_hour: lastHour.count ?? 0,
      today: today.count ?? 0,
    });
  } catch (e) {
    console.log("[admin/presence-stats]", e);
    return res.status(500).json({ ok: false });
  }
}

app.post("/api/user-presence", handleUserPresencePost);
app.post("/user-presence", handleUserPresencePost);
app.get("/api/admin/presence-stats", handleAdminPresenceStatsGet);
app.get("/admin/presence-stats", handleAdminPresenceStatsGet);

const HOME_ANNOUNCEMENT_TITLE_MAX = 120;
const HOME_ANNOUNCEMENT_BODY_MAX = 8000;

function jsonHomeAnnouncementRow(row) {
  return {
    id: String(row.id || ""),
    title: String(row.title || "").trim(),
    body: String(row.body || ""),
    created_at_ms: Number(row.created_at_ms) || 0,
  };
}

async function handleHomeAnnouncementsPublicGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const { data, error } = await supabase
      .from("home_announcements")
      .select("id, title, body, created_at_ms")
      .order("created_at_ms", { ascending: false })
      .limit(32);

    if (error) {
      logSupabaseErr("[home-announcements public]", error);
      return res.status(500).json({
        ok: false,
        error: error.message || "조회 실패",
      });
    }

    const items = (Array.isArray(data) ? data : [])
      .map(jsonHomeAnnouncementRow)
      .filter((row) => row.id && row.title);
    return res.json({ ok: true, items });
  } catch (e) {
    console.log("[home-announcements public]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

async function handleHomeAnnouncementsPost(req, res) {
  try {
    if (!isAdminPresenceAuthorized(req)) {
      return res.status(403).json({ ok: false, error: "관리자 권한 필요" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const title = readString(req.body, "title").trim();
    const body = readString(req.body, "body");
    if (!title) {
      return res.status(400).json({ ok: false, error: "title 필요" });
    }
    if (title.length > HOME_ANNOUNCEMENT_TITLE_MAX) {
      return res.status(400).json({ ok: false, error: "title 너무 김" });
    }
    if (body.length > HOME_ANNOUNCEMENT_BODY_MAX) {
      return res.status(400).json({ ok: false, error: "body 너무 김" });
    }

    const created_at_ms = Date.now();
    const row = {
      title,
      body,
      created_at_ms,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("home_announcements")
      .insert(row)
      .select("id, title, body, created_at_ms")
      .single();

    if (error) {
      logSupabaseErr("[home-announcements] insert", error);
      return res.status(500).json({
        ok: false,
        error: error.message || "저장 실패",
      });
    }

    console.log("✅ [home-announcements] insert", data?.id);
    return res.json({ ok: true, item: jsonHomeAnnouncementRow(data) });
  } catch (e) {
    console.log("[home-announcements post]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

async function handleHomeAnnouncementsPatch(req, res) {
  try {
    if (!isAdminPresenceAuthorized(req)) {
      return res.status(403).json({ ok: false, error: "관리자 권한 필요" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const id = decodeURIComponent(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "id 필요" });
    }

    const title = readString(req.body, "title").trim();
    const body = readString(req.body, "body");
    if (!title) {
      return res.status(400).json({ ok: false, error: "title 필요" });
    }
    if (title.length > HOME_ANNOUNCEMENT_TITLE_MAX) {
      return res.status(400).json({ ok: false, error: "title 너무 김" });
    }
    if (body.length > HOME_ANNOUNCEMENT_BODY_MAX) {
      return res.status(400).json({ ok: false, error: "body 너무 김" });
    }

    const { data, error } = await supabase
      .from("home_announcements")
      .update({ title, body })
      .eq("id", id)
      .select("id, title, body, created_at_ms")
      .single();

    if (error) {
      logSupabaseErr("[home-announcements] update", error);
      return res.status(500).json({
        ok: false,
        error: error.message || "수정 실패",
      });
    }

    if (!data) {
      return res.status(404).json({ ok: false, error: "공지 없음" });
    }

    console.log("✅ [home-announcements] update", id);
    return res.json({ ok: true, item: jsonHomeAnnouncementRow(data) });
  } catch (e) {
    console.log("[home-announcements patch]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

async function handleHomeAnnouncementsDelete(req, res) {
  try {
    if (!isAdminPresenceAuthorized(req)) {
      return res.status(403).json({ ok: false, error: "관리자 권한 필요" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const id = decodeURIComponent(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "id 필요" });
    }

    const { error } = await supabase.from("home_announcements").delete().eq("id", id);

    if (error) {
      logSupabaseErr("[home-announcements] delete", error);
      return res.status(500).json({ ok: false, error: "삭제 실패" });
    }

    console.log("✅ [home-announcements] delete", id);
    return res.json({ ok: true });
  } catch (e) {
    console.log("[home-announcements delete]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

app.get("/api/home-announcements/public", handleHomeAnnouncementsPublicGet);
app.get("/home-announcements/public", handleHomeAnnouncementsPublicGet);
app.post("/api/home-announcements", handleHomeAnnouncementsPost);
app.post("/home-announcements", handleHomeAnnouncementsPost);
app.patch("/api/home-announcements/:id", handleHomeAnnouncementsPatch);
app.patch("/home-announcements/:id", handleHomeAnnouncementsPatch);
app.delete("/api/home-announcements/:id", handleHomeAnnouncementsDelete);
app.delete("/home-announcements/:id", handleHomeAnnouncementsDelete);

// 커스텀 댓글러 프롬프트 — 앱 `POST /api/custom-prompt` · 배포별칭 `POST /api/custom-prompts`
async function handleCustomPromptPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const { promptStr, parsedPrompt } = readCustomPromptPayload(req.body);
    if (!user_id || !commenter_id || !promptStr) {
      return res.status(400).json({ ok: false, error: "user_id, commenter_id, prompt 필요" });
    }

    let finalIsPublic = computeCustomPromptIsPublic(req.body, parsedPrompt);

    const { data: existingRow } = await supabase
      .from("custom_prompts")
      .select("is_public")
      .eq("user_id", user_id)
      .eq("commenter_id", commenter_id)
      .maybeSingle();

    if (
      !finalIsPublic &&
      existingRow &&
      existingRow.is_public === true &&
      !isExplicitCustomPromptPrivate(req.body, parsedPrompt)
    ) {
      finalIsPublic = true;
    }

    const name = extractCustomPromptColumnString(parsedPrompt, ["name"]);
    const description = extractCustomPromptColumnString(parsedPrompt, [
      "description",
      "intro",
      "summonWizardTaglinePure",
    ]);
    const imageUrl = extractCustomPromptColumnString(parsedPrompt, [
      "image_url",
      "profileImagePath",
      "imageUrl",
    ]);
    const promptVisibility =
      parsedPrompt && typeof parsedPrompt.visibility === "string"
        ? parsedPrompt.visibility.trim()
        : "";

    const row = {
      user_id,
      commenter_id,
      prompt: promptStr,
      is_public: finalIsPublic,
      updated_at: new Date().toISOString(),
    };
    if (name) row.name = name;
    if (description) row.description = description;
    if (imageUrl) row.image_url = imageUrl;

    console.log(
      "[custom-prompt-save]",
      "commenterId=" + commenter_id,
      "promptVisibility=" + promptVisibility,
      "finalIsPublic=" + finalIsPublic,
      "imageUrl=" + (imageUrl || ""),
    );

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

// 구버전 `GET /api/custom-prompts?user_id=` · `?scope=public` — `:userId` 라우트보다 먼저 등록
async function handleCustomPromptsQueryGet(req, res) {
  try {
    const scopeRaw = req.query && req.query.scope;
    const scope =
      typeof scopeRaw === "string"
        ? decodeURIComponent(scopeRaw).trim().toLowerCase()
        : Array.isArray(scopeRaw) && typeof scopeRaw[0] === "string"
          ? decodeURIComponent(scopeRaw[0]).trim().toLowerCase()
          : "";

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    if (scope === "public") {
      const { data, error } = await supabase
        .from("custom_prompts")
        .select("*")
        .eq("is_public", true)
        .order("updated_at", { ascending: false });
      if (error) {
        console.log("❌ [custom-prompts public]", error?.message || error);
        return res.json({ ok: false, prompts: [] });
      }
      return res.json({ ok: true, prompts: data || [] });
    }

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

// 앱 `DELETE /api/custom-prompts/:commenterId?user_id=` — 본인 제작 케릭터 삭제
async function handleCustomPromptDelete(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const commenterId = decodeURIComponent(req.params.userId || "").trim();
    if (!commenterId) {
      return res.status(400).json({ ok: false, error: "commenter_id required" });
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

    const { data: existing, error: fetchErr } = await supabase
      .from("custom_prompts")
      .select("user_id")
      .eq("user_id", userId)
      .eq("commenter_id", commenterId)
      .maybeSingle();

    if (fetchErr) {
      logSupabaseErr("[custom-prompt delete fetch]", fetchErr);
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }
    if (!existing) {
      return res.status(404).json({ ok: false, error: "not found" });
    }

    const { error: deleteErr } = await supabase
      .from("custom_prompts")
      .delete()
      .eq("user_id", userId)
      .eq("commenter_id", commenterId);

    if (deleteErr) {
      logSupabaseErr("[custom-prompt delete]", deleteErr);
      return res.status(500).json({ ok: false, error: deleteErr.message });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.log("[custom-prompt delete]", e);
    return res.status(500).json({ ok: false });
  }
}

app.delete("/api/custom-prompts/:userId", handleCustomPromptDelete);
app.delete("/custom-prompts/:userId", handleCustomPromptDelete);

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
// STORY CHAT (DeepSeek reply + DeepSeek scene prediction)
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

function storyChatSkipsScenePrediction(storyId, programId, beatScene) {
  const sid = String(storyId || "").trim();
  const pid = String(programId || "").trim();
  const beat = String(beatScene || "").trim();
  if (pid === "movie_story") return true;
  if (beat.length > 0) return true;
  return sid === "movie_alien_x" || sid.startsWith("movie_");
}

async function predictStoryScene(contextText) {
  if (!isAnthropicConfigured()) {
    console.error(
      "[story-chat-scene] Anthropic is not configured (set ANTHROPIC_API_KEY)",
    );
    return {
      scene: "default",
      preload: [],
      source: "fallback_anthropic_not_configured",
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

  const llmResult = await callAnthropicCompletion({
    model: STORY_SCENE_ANTHROPIC_MODEL,
    userPrompt: safeContext,
    systemPrompt: sceneSystemPrompt,
    temperature: 0.25,
    max_tokens: 220,
    logTag: "story-chat-scene",
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    disableThinking: true,
  });

  if (!llmResult.ok) {
    console.error(
      "[story-chat scene error]",
      llmResult.status,
      llmResult.errorText || "",
    );
    return {
      scene: "default",
      preload: [],
      source: "fallback_anthropic_error",
    };
  }

  try {
    const parsed = safeJsonObjectFromText(llmResult.text);
    const scene = normalizeStorySceneKey(parsed?.scene);

    return {
      scene,
      preload: normalizeStoryScenePreload(parsed?.preload, scene),
      source: "anthropic",
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

  const t0 = Date.now();
  const logTiming = (label) => {
    console.log(`[story-chat timing] ${label} +${Date.now() - t0}ms`);
  };
  logTiming("request_received");

  try {
    const promptRaw = req.body && req.body.prompt;
    const storyContext = readString(req.body, "story_context");
    const requestedTemperature = Number(req.body && req.body.temperature);
    const requestedMaxTokens = Number(req.body && req.body.maxTokens);
    const wantStream = req.body && req.body.stream === true;
    const temperature =
      Number.isFinite(requestedTemperature) && requestedTemperature >= 0 && requestedTemperature <= 2
        ? requestedTemperature
        : 0.82;

    if (typeof promptRaw !== "string" || !promptRaw.trim()) {
      return res.status(400).json({ ok: false, error: "no prompt" });
    }

    if (!isAnthropicConfigured()) {
      console.error("[story-chat] Anthropic is not configured (set ANTHROPIC_API_KEY)");
      return res.status(503).json({ ok: false, error: "Anthropic is not configured" });
    }

    const max_tokens = resolveStoryLlmMaxTokens(
      requestedMaxTokens,
      STORY_CHAT_ANTHROPIC_MODEL,
    );
    if (Number.isFinite(requestedMaxTokens)) {
      console.log(
        `[story-chat] maxTokens requested=${requestedMaxTokens} ` +
          `effective=${max_tokens} model=${STORY_CHAT_ANTHROPIC_MODEL}`,
      );
    }
    console.log(
      `[story-chat] provider=anthropic model=${STORY_CHAT_ANTHROPIC_MODEL}`,
    );

    const cleanedPrompt = sanitizePromptForApi(promptRaw);
    if (!cleanedPrompt) {
      return res.status(400).json({ ok: false, error: "no prompt" });
    }
    logTiming("prompt_ready");

    const promptSegments = readStoryChatPromptSegments(req.body);
    const auditRaw = req.body && req.body.prompt_token_audit;
    const storyId = readString(req.body, "story_id");
    let promptTokenAuditResult = null;
    if (auditRaw && typeof auditRaw === "object") {
      const auditStaticEngine =
        readString(auditRaw, "static_engine") ||
        (promptSegments ? promptSegments.staticEngine : "");
      const auditNodeStatic =
        readString(auditRaw, "node_static") ||
        (promptSegments ? promptSegments.nodeStatic : "");
      const auditDynamicContext =
        readString(auditRaw, "dynamic_context") ||
        (promptSegments ? promptSegments.dynamicContext : "");
      const auditNodeId =
        readString(auditRaw, "node_id") ||
        (promptSegments ? promptSegments.nodeId : "");
      if (auditStaticEngine || auditNodeStatic || auditDynamicContext) {
        logTiming("token_audit_start");
        promptTokenAuditResult = await auditStoryChatPromptTokens({
          model: STORY_CHAT_ANTHROPIC_MODEL,
          anthropicSystem: STORY_JSON_SYSTEM_PROMPT,
          staticEngine: auditStaticEngine,
          nodeStatic: auditNodeStatic,
          dynamicContext: auditDynamicContext,
          fullUserPrompt: cleanedPrompt,
          nodeId: auditNodeId,
          storyId,
        });
        logTiming("token_audit_done");
      }
    }

    const sceneContext = storyContext || cleanedPrompt;
    const programId = readString(req.body, "program_id");
    const beatScene = readString(req.body, "beat_scene");

    if (process.env.STORY_PROMPT_DUMP === "1") {
      console.log("[storyPromptDump] === SERVER START ===");
      console.log(
        `[storyPromptDump] provider=anthropic model=${STORY_CHAT_ANTHROPIC_MODEL}`,
      );
      console.log(`[storyPromptDump] storyId=${storyId || "(none)"} programId=${programId || "(none)"}`);
      console.log(`[storyPromptDump] --- combinedPrompt (${cleanedPrompt.length} chars) ---`);
      console.log(cleanedPrompt);
      if (storyContext && storyContext !== cleanedPrompt) {
        console.log(`[storyPromptDump] --- story_context (${storyContext.length} chars) ---`);
        console.log(storyContext);
      }
      console.log("[storyPromptDump] === SERVER END ===");
    }

    const skipScenePrediction =
      (req.body && req.body.skip_scene_prediction === true) ||
      storyChatSkipsScenePrediction(storyId, programId, beatScene);

    const scenePromise = skipScenePrediction
      ? Promise.resolve({
          scene: "default",
          preload: [],
          source: "beat_scene_only",
        })
      : predictStoryScene(sceneContext);

    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let sceneData = {
        scene: "default",
        preload: [],
        source: skipScenePrediction ? "beat_scene_only" : "pending",
      };

      scenePromise
        .then((data) => {
          sceneData = data;
          writeSse(res, {
            type: "scene",
            scene: data.scene,
            preload: data.preload,
            scene_source: data.source,
          });
        })
        .catch((e) => {
          console.error("[story-chat stream scene error]", e?.message || e);
        });

      logTiming("provider_started");
      const llmResult = await callAnthropicCompletionStream({
        model: STORY_CHAT_ANTHROPIC_MODEL,
        userPrompt: cleanedPrompt,
        temperature,
        max_tokens,
        logTag: "story-chat-stream",
        systemPrompt: STORY_JSON_SYSTEM_PROMPT,
        promptSegments,
        onFirstToken: () => logTiming("first_token"),
        onDelta: (piece) => {
          writeSse(res, { type: "delta", text: piece });
        },
        fetchTimeoutMs: STORY_LLM_TIMEOUT_MS,
        disableThinking: true,
      });

      if (!llmResult.ok) {
        writeSse(res, {
          type: "error",
          error: llmResult.errorText || "Anthropic request failed",
        });
        res.end();
        return;
      }

      const reply = llmResult.text;
      logTiming("completed");

      console.log(
        `[story-chat stream] storyId=${storyId || "(none)"} programId=${programId || "(none)"} ` +
          `scene=${sceneData.scene} preload=${JSON.stringify(sceneData.preload)}`,
      );

      writeSse(res, {
        type: "done",
        reply,
        scene: sceneData.scene,
        preload: sceneData.preload,
        scene_source: sceneData.source,
        raw: llmResult.raw,
        ...(promptTokenAuditResult ? { prompt_token_audit: promptTokenAuditResult } : {}),
      });
      res.end();
      return;
    }

    const llmResult = await callAnthropicCompletion({
      model: STORY_CHAT_ANTHROPIC_MODEL,
      userPrompt: cleanedPrompt,
      systemPrompt: STORY_JSON_SYSTEM_PROMPT,
      temperature,
      max_tokens,
      logTag: "story-chat",
      fetchTimeoutMs: STORY_LLM_TIMEOUT_MS,
      disableThinking: true,
      promptSegments,
    });
    logTiming("provider_completed");

    let finalLlm = llmResult;
    if (
      finalLlm.ok &&
      finalLlm.text &&
      !storyChatJsonLooksComplete(finalLlm.text)
    ) {
      const retryMax = anthropicRetryMaxTokens(max_tokens, { truncated: true });
      console.log(
        `[story-chat] incomplete JSON len=${finalLlm.text.length} — retry max_tokens=${retryMax}`,
      );
      finalLlm = await callAnthropicCompletion({
        model: STORY_CHAT_ANTHROPIC_MODEL,
        userPrompt: cleanedPrompt,
        systemPrompt: STORY_JSON_SYSTEM_PROMPT,
        temperature,
        max_tokens: retryMax,
        logTag: "story-chat",
        fetchTimeoutMs: STORY_LLM_TIMEOUT_MS,
        _attempt: 1,
        disableThinking: true,
        promptSegments,
      });
      logTiming("provider_json_retry_completed");
    }

    if (!finalLlm.ok) {
      const statusOut = finalLlm.status || 502;
      const errMsg = finalLlm.errorText || "Anthropic request failed";
      console.error(
        "[story-chat llm error]",
        `provider=anthropic model=${STORY_CHAT_ANTHROPIC_MODEL}`,
        statusOut,
        errMsg,
      );
      return res.status(statusOut).json({ ok: false, error: errMsg });
    }

    const reply = finalLlm.text;
    if (!reply) {
      return res.status(502).json({ ok: false, error: "empty reply" });
    }
    if (storyChatReplyLooksEmpty(reply)) {
      console.warn(
        `[story-chat] still empty after retry len=${reply.length} head=${reply.slice(0, 120)}`,
      );
    }

    let sceneData = {
      scene: "default",
      preload: [],
      source: skipScenePrediction ? "beat_scene_only" : "default_fallback",
    };
    try {
      sceneData = await Promise.race([
        scenePromise,
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                scene: "default",
                preload: [],
                source: "scene_timeout",
              }),
            1200,
          ),
        ),
      ]);
    } catch (e) {
      console.error("[story-chat scene wait error]", e?.message || e);
    }
    logTiming("completed");

    const upstreamRaw = finalLlm.raw;
    const usage = upstreamRaw?.usage || {};
    const elapsedMs = Date.now() - t0;

    console.log(
      `[story-chat] storyId=${storyId || "(none)"} programId=${programId || "(none)"} ` +
        `currentBeat.scene=${beatScene || "(none)"} appliedScenePreset=${sceneData.scene} ` +
        `preload=${JSON.stringify(sceneData.preload)} source=${sceneData.source} ` +
        `provider=anthropic ` +
        `model=${STORY_CHAT_ANTHROPIC_MODEL} ` +
        `requestedMax=${Number.isFinite(requestedMaxTokens) ? requestedMaxTokens : "(default)"} ` +
        `effectiveMax=${max_tokens} ` +
        `inputTokens=${usage.input_tokens ?? "?"} ` +
        `outputTokens=${usage.output_tokens ?? "?"} ` +
        `replyLen=${reply.length} elapsedMs=${elapsedMs}`,
    );

    return res.json({
      ok: true,
      reply,
      scene: sceneData.scene,
      preload: sceneData.preload,
      scene_source: sceneData.source,
      raw: upstreamRaw,
      ...(promptTokenAuditResult ? { prompt_token_audit: promptTokenAuditResult } : {}),
    });
  } catch (e) {
    console.error("[story-chat server error]", e);
    if (req.body && req.body.stream === true && !res.headersSent) {
      res.status(500);
    }
    if (req.body && req.body.stream === true && res.headersSent) {
      writeSse(res, { type: "error", error: e.message });
      res.end();
      return;
    }
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
- horizontal 16:9 composition (landscape banner card, exact widescreen crop)
- cinematic lighting, full background scene
- render the story title text prominently at the top center, integrated into the artwork like a movie or game poster
- title must be bold, readable, cinematic typography with dramatic lighting or texture
- no speech bubbles, no subtitles, no caption text, no watermark, no UI elements
- emotionally clear storytelling`;

const STORY_BANNER_NO_TITLE_RULES = `Visual rules for story banner card:
- horizontal 16:9 composition (landscape banner card, exact widescreen crop)
- cinematic lighting, full background scene
- absolutely no text, no letters, no words, no title, no typography, no captions in the image
- no speech bubbles, no subtitles, no watermark, no UI elements
- leave subtle darker atmospheric space at the top center for app title overlay
- emotionally clear storytelling`;

const STORY_BANNER_REFERENCE_RULES = `IMPORTANT:

Use the provided reference images as style and composition references for the banner.

Match the visual style, color palette, lighting mood, rendering quality, and compositional feel.

Do NOT copy exact characters, logos, or specific copyrighted elements.

Create an original scene for this story while preserving the reference banner's aesthetic feel.`;

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

function bannerVisualFocus(referenceMode = "") {
  const mode = String(referenceMode || "").trim().toLowerCase();
  if (mode === "banner" || mode === "style") {
    return (
      "Focus: Horizontal 16:9 story banner background. " +
      "Match composition style, color palette, and visual quality from the reference banner image. " +
      "Create an original scene for this story opening. No text in the image."
    );
  }
  return (
    "Focus: Horizontal 16:9 story banner background. " +
    "Cinematic landscape scene for the story opening. " +
    "Title is shown in app UI overlay — no text in the image."
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
  } else if (isCover) {
    focus = bannerVisualFocus(referenceMode);
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
      : "Create one high-quality horizontal story banner background (16:9 landscape). No text in the image."
    : "Create one high-quality vertical story scene background.";

  const visualRules = isCover
    ? renderTitleInImage
      ? `${STORY_BANNER_TITLE_RULES}
- only text allowed in the image is the story title shown below`
      : STORY_BANNER_NO_TITLE_RULES
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
    refMode === "banner" || (isCover && refNames.length > 0)
      ? STORY_BANNER_REFERENCE_RULES
      : STORY_IMAGE_REFERENCE_RULES;

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

const USER_ASSET_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

function isJpegBuffer(buf) {
  return buf?.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isWebpBuffer(buf) {
  return (
    buf?.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  );
}

function detectUserAssetImage(buf) {
  if (!buf?.length || buf.length > USER_ASSET_IMAGE_MAX_BYTES) return null;
  if (isPngBuffer(buf)) return { contentType: "image/png", ext: "png" };
  if (isJpegBuffer(buf)) return { contentType: "image/jpeg", ext: "jpg" };
  if (isWebpBuffer(buf)) return { contentType: "image/webp", ext: "webp" };
  return null;
}

function decodeUserAssetImageBase64(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const comma = s.indexOf(",");
  const payload = s.startsWith("data:") && comma >= 0 ? s.slice(comma + 1) : s;
  try {
    const buf = Buffer.from(payload, "base64");
    return detectUserAssetImage(buf) ? buf : null;
  } catch (_e) {
    return null;
  }
}

async function uploadUserAssetImage(bucket, storagePath, buf, contentType) {
  const supabase = getSupabase();
  if (!supabase || !buf?.length) return null;
  const { error } = await supabase.storage.from(bucket).upload(storagePath, buf, {
    contentType,
    upsert: true,
  });
  if (error) {
    console.error("[user-asset-image upload]", storagePath, error.message);
    return null;
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

async function handleCharacterImagePost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const commenter_id = readString(req.body, "commenter_id");
    const kind = sanitizeStoryImagePathSegment(readString(req.body, "kind") || "profile", 40);
    const buf = decodeUserAssetImageBase64(req.body && req.body.image_base64);

    if (!user_id || !commenter_id || !buf) {
      return res.status(400).json({ ok: false, error: "user_id, commenter_id, image_base64 필요" });
    }

    const detected = detectUserAssetImage(buf);
    if (!detected) {
      return res.status(400).json({ ok: false, error: "invalid image" });
    }

    const safeUser = sanitizeStoryImagePathSegment(user_id, 120);
    const safeId = sanitizeStoryImagePathSegment(commenter_id, 120);
    const path = `commenters/${safeUser}/${safeId}/${kind}.${detected.ext}`;
    const url = await uploadUserAssetImage("story-covers", path, buf, detected.contentType);
    if (!url) return res.status(500).json({ ok: false, error: "upload failed" });
    return res.json({ ok: true, image_url: url });
  } catch (e) {
    console.error("[character-image]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleUserStoryImagePost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const story_id = readString(req.body, "story_id");
    const kind = sanitizeStoryImagePathSegment(readString(req.body, "kind") || "cover", 40);
    const buf = decodeUserAssetImageBase64(req.body && req.body.image_base64);

    if (!user_id || !story_id || !buf) {
      return res.status(400).json({ ok: false, error: "user_id, story_id, image_base64 필요" });
    }

    const detected = detectUserAssetImage(buf);
    if (!detected) {
      return res.status(400).json({ ok: false, error: "invalid image" });
    }

    const safeUser = sanitizeStoryImagePathSegment(user_id, 120);
    const safeStory = sanitizeStoryImagePathSegment(story_id, 120);
    const path = `user-stories/${safeUser}/${safeStory}/${kind}.${detected.ext}`;
    const url = await uploadUserAssetImage("story-covers", path, buf, detected.contentType);
    if (!url) return res.status(500).json({ ok: false, error: "upload failed" });
    return res.json({ ok: true, image_url: url });
  } catch (e) {
    console.error("[user-story-image]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

const STORY_REF_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

function isPngBuffer(buf) {
  return (
    buf?.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

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
    if (!isPngBuffer(buf)) {
      console.warn("[story-image] skip ref", ref.name, "not png");
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
  if (!res.ok) {
    console.error(
      `[story-image openai ${label}] failed status=${res.status} body=${raw}`,
    );
  }
  return {
    ok: res.ok,
    status: res.status,
    raw,
    errorMessage: res.ok ? "" : parseOpenAiImageError(raw, res.status),
  };
}

async function readFormDataPackageAsBuffer(form) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new PassThrough();
    sink.on("data", (chunk) => chunks.push(chunk));
    sink.on("end", () => resolve(Buffer.concat(chunks)));
    sink.on("error", reject);
    form.on("error", reject);
    form.pipe(sink);
  });
}

async function postOpenAiMultipartForm(form, label) {
  const body = await readFormDataPackageAsBuffer(form);
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...form.getHeaders(),
    "Content-Length": String(body.length),
  };

  console.log(
    `[story-image ${label}] multipart bytes=${body.length} content-type=${headers["content-type"] || ""}`,
  );

  return fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers,
    body,
  });
}

async function requestOpenAiStoryImageEdits(
  prompt,
  referenceImages,
  imageSize = STORY_IMAGE_SIZE_PORTRAIT,
) {
  const refs = filterStoryReferenceImagesForApi(referenceImages);
  if (!refs.length) return null;

  const form = new FormData();
  refs.forEach((ref, index) => {
    form.append("image", ref.buf, {
      filename: `reference_${index + 1}.png`,
      contentType: "image/png",
    });
  });
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("size", imageSize);
  form.append("quality", OPENAI_IMAGE_QUALITY);
  form.append("output_format", "png");

  console.log(
    "[story-image edits request]",
    `refs=${refs.length}`,
    `bytes=${refs.map((r) => r.buf.length).join(",")}`,
  );

  return postOpenAiMultipartForm(form, "edits");
}

async function generateStoryImageFromPrompt(
  prompt,
  sessionKey,
  fileStem,
  referenceImages = [],
  imageSize = STORY_IMAGE_SIZE_PORTRAIT,
  { referenceMode = "" } = {},
) {
  if (!OPENAI_API_KEY) {
    throw new Error("no OPENAI_API_KEY");
  }

  const parsedReferenceCount = Array.isArray(referenceImages) ? referenceImages.length : 0;
  const refMode = String(referenceMode || "").trim().toLowerCase();
  let generationMode = "generations";
  let referenceApplied = false;
  let fallbackUsed = false;
  let result;

  if (parsedReferenceCount > 0) {
    let editsFailed = false;
    const editsRes = await requestOpenAiStoryImageEdits(prompt, referenceImages, imageSize);
    if (!editsRes) {
      editsFailed = true;
      console.warn(
        "[imageGen]",
        "edits request could not be built",
        `parsedReferenceCount=${parsedReferenceCount}`,
        `referenceMode=${refMode || "(default)"}`,
      );
    } else {
      result = await readOpenAiStoryImageResponse(editsRes, "edits");
      console.log(
        "[imageGen]",
        `parsedReferenceCount=${parsedReferenceCount}`,
        `referenceMode=${refMode || "(default)"}`,
        `editsStatus=${result.status}`,
        "generationMode=edits",
      );
      if (!result.ok) {
        editsFailed = true;
        console.warn("[imageGen] edits failed:", result.errorMessage);
      } else {
        generationMode = "edits";
        referenceApplied = true;
      }
    }

    if (editsFailed) {
      console.warn(
        "[imageGen]",
        "edits failed; falling back to text-only generations",
        `referenceMode=${refMode || "(default)"}`,
        result?.errorMessage || "",
      );
      fallbackUsed = true;
      generationMode = "generations-fallback";
      const genRes = await requestOpenAiStoryImageGeneration(prompt, imageSize);
      result = await readOpenAiStoryImageResponse(genRes, "generations-fallback");
      console.log(
        "[imageGen]",
        `generationsStatus=${result.status}`,
        "generationMode=generations-fallback",
        "fallbackUsed=true",
      );
    }
  } else {
    const genRes = await requestOpenAiStoryImageGeneration(prompt, imageSize);
    result = await readOpenAiStoryImageResponse(genRes, "generations");
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

    const imageSize = storyImageApiSize({ landscape: true });
    const genResult = await generateStoryImageFromPrompt(
      promptUsed,
      session_key || "cover",
      "cover",
      refs,
      imageSize,
      { referenceMode: reference_mode },
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
      const { data: existing, error: fetchErr } = await supabase
        .from("user_stories")
        .select("user_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchErr) {
        logSupabaseErr("[user-stories] update fetch failed", fetchErr);
        return res.status(500).json({ ok: false, error: fetchErr.message });
      }
      if (!existing) {
        row.created_at = now;
        result = await supabase
          .from("user_stories")
          .insert([row])
          .select("id")
          .single();
      } else if ((existing.user_id || "").trim() !== user_id) {
        return res.status(403).json({ ok: false, error: "forbidden" });
      } else {
        result = await supabase
          .from("user_stories")
          .update(row)
          .eq("id", id)
          .eq("user_id", user_id)
          .select("id")
          .single();
      }
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

    const liteRaw = req.query && req.query.lite;
    const lite =
      liteRaw === "1" ||
      liteRaw === "true" ||
      liteRaw === true ||
      (typeof liteRaw === "string" && decodeURIComponent(liteRaw).trim() === "1");

    const listSelect = lite
      ? "id,user_id,title,summary,category,visibility,cover_url,background_url,created_at,updated_at"
      : "*";

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
        .select(listSelect)
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
      .select(listSelect)
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

app.post("/api/character-image", handleCharacterImagePost);
app.post("/character-image", handleCharacterImagePost);
app.post("/api/user-story-image", handleUserStoryImagePost);
app.post("/user-story-image", handleUserStoryImagePost);

app.post("/api/user-stories", handleUserStoriesPost);
app.post("/user-stories", handleUserStoriesPost);
app.get("/api/user-stories", handleUserStoriesQueryGet);
app.get("/user-stories", handleUserStoriesQueryGet);
app.get("/api/user-stories/:id", handleUserStoryByIdGet);
app.get("/user-stories/:id", handleUserStoryByIdGet);
app.delete("/api/user-stories/:id", handleUserStoryByIdDelete);
app.delete("/user-stories/:id", handleUserStoryByIdDelete);

// 스토리 라이브러리 댓글 — 앱 `GET/POST/PATCH/DELETE /api/story-comments`
async function fetchStoryCommentsWithMeta(supabase, storyId, viewerUserId) {
  const { data: rows, error } = await supabase
    .from("story_comments")
    .select("id, story_id, user_id, author_name, author_image_path, text, parent_id, created_at, updated_at")
    .eq("story_id", storyId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const comments = rows || [];
  if (!comments.length) return [];

  const ids = comments.map((c) => c.id);
  const { data: likes, error: likesErr } = await supabase
    .from("story_comment_likes")
    .select("comment_id, user_id")
    .in("comment_id", ids);

  if (likesErr) throw likesErr;

  const likeCountById = new Map();
  const likedByViewer = new Set();
  for (const row of likes || []) {
    const cid = row.comment_id;
    likeCountById.set(cid, (likeCountById.get(cid) || 0) + 1);
    if (viewerUserId && row.user_id === viewerUserId) {
      likedByViewer.add(cid);
    }
  }

  return comments.map((c) => ({
    id: c.id,
    story_id: c.story_id,
    user_id: c.user_id,
    author_name: c.author_name || "",
    author_image_path: c.author_image_path || "",
    text: c.text || "",
    parent_id: c.parent_id || null,
    created_at: c.created_at,
    updated_at: c.updated_at,
    like_count: likeCountById.get(c.id) || 0,
    liked_by_me: likedByViewer.has(c.id),
  }));
}

async function handleStoryCommentsListGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const storyId = decodeURIComponent(req.params.storyId || "").trim();
    if (!storyId) return res.status(400).json({ ok: false, error: "story_id required" });

    const rawViewer = req.query && req.query.user_id;
    const viewerUserId =
      typeof rawViewer === "string"
        ? decodeURIComponent(rawViewer).trim()
        : Array.isArray(rawViewer) && typeof rawViewer[0] === "string"
          ? decodeURIComponent(rawViewer[0]).trim()
          : "";

    const comments = await fetchStoryCommentsWithMeta(
      supabase,
      storyId,
      viewerUserId || null,
    );
    return res.json({ ok: true, comments });
  } catch (e) {
    console.log("[story-comments list]", e);
    return res.status(500).json({ ok: false, error: e.message || "failed" });
  }
}

async function handleStoryCommentsPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const story_id = readString(req.body, "story_id");
    const author_name = readString(req.body, "author_name") || "게스트";
    const author_image_path = readString(req.body, "author_image_path");
    const text = readString(req.body, "text");
    const parent_id = readString(req.body, "parent_id");

    if (!user_id || !story_id || !text) {
      return res.status(400).json({ ok: false, error: "user_id, story_id, text 필요" });
    }

    if (parent_id) {
      const { data: parent, error: parentErr } = await supabase
        .from("story_comments")
        .select("id, story_id")
        .eq("id", parent_id)
        .maybeSingle();
      if (parentErr) {
        logSupabaseErr("[story-comments post] parent lookup", parentErr);
        return res.status(500).json({ ok: false, error: parentErr.message });
      }
      if (!parent || parent.story_id !== story_id) {
        return res.status(400).json({ ok: false, error: "invalid parent_id" });
      }
    }

    const now = new Date().toISOString();
    const row = {
      story_id,
      user_id,
      author_name,
      author_image_path: author_image_path || null,
      text,
      parent_id: parent_id || null,
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await supabase
      .from("story_comments")
      .insert([row])
      .select("id, story_id, user_id, author_name, author_image_path, text, parent_id, created_at, updated_at")
      .single();

    if (error) {
      logSupabaseErr("[story-comments post]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(201).json({
      ok: true,
      comment: {
        ...data,
        like_count: 0,
        liked_by_me: false,
      },
    });
  } catch (e) {
    console.log("[story-comments post]", e);
    return res.status(500).json({ ok: false, error: e.message || "failed" });
  }
}

async function handleStoryCommentsPatch(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const commentId = decodeURIComponent(req.params.id || "").trim();
    const user_id = readString(req.body, "user_id");
    const text = readString(req.body, "text");

    if (!commentId || !user_id || !text) {
      return res.status(400).json({ ok: false, error: "id, user_id, text 필요" });
    }

    const { data: existing, error: findErr } = await supabase
      .from("story_comments")
      .select("id, user_id")
      .eq("id", commentId)
      .maybeSingle();

    if (findErr) {
      logSupabaseErr("[story-comments patch] lookup", findErr);
      return res.status(500).json({ ok: false, error: findErr.message });
    }
    if (!existing) return res.status(404).json({ ok: false, error: "not found" });
    if (existing.user_id !== user_id) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("story_comments")
      .update({ text, updated_at: now })
      .eq("id", commentId)
      .select("id, story_id, user_id, author_name, author_image_path, text, parent_id, created_at, updated_at")
      .single();

    if (error) {
      logSupabaseErr("[story-comments patch]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const { count } = await supabase
      .from("story_comment_likes")
      .select("*", { count: "exact", head: true })
      .eq("comment_id", commentId);

    const { data: myLike } = await supabase
      .from("story_comment_likes")
      .select("comment_id")
      .eq("comment_id", commentId)
      .eq("user_id", user_id)
      .maybeSingle();

    return res.json({
      ok: true,
      comment: {
        ...data,
        like_count: count || 0,
        liked_by_me: !!myLike,
      },
    });
  } catch (e) {
    console.log("[story-comments patch]", e);
    return res.status(500).json({ ok: false, error: e.message || "failed" });
  }
}

async function handleStoryCommentsDelete(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const commentId = decodeURIComponent(req.params.id || "").trim();
    const raw = req.query && req.query.user_id;
    const user_id =
      typeof raw === "string"
        ? decodeURIComponent(raw).trim()
        : Array.isArray(raw) && typeof raw[0] === "string"
          ? decodeURIComponent(raw[0]).trim()
          : readString(req.body, "user_id");

    if (!commentId || !user_id) {
      return res.status(400).json({ ok: false, error: "id, user_id 필요" });
    }

    const { data: existing, error: findErr } = await supabase
      .from("story_comments")
      .select("id, user_id")
      .eq("id", commentId)
      .maybeSingle();

    if (findErr) {
      logSupabaseErr("[story-comments delete] lookup", findErr);
      return res.status(500).json({ ok: false, error: findErr.message });
    }
    if (!existing) return res.status(404).json({ ok: false, error: "not found" });
    if (existing.user_id !== user_id) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const { error } = await supabase.from("story_comments").delete().eq("id", commentId);
    if (error) {
      logSupabaseErr("[story-comments delete]", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.log("[story-comments delete]", e);
    return res.status(500).json({ ok: false, error: e.message || "failed" });
  }
}

async function handleStoryCommentLikePost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const user_id = readString(req.body, "user_id");
    const comment_id = readString(req.body, "comment_id");

    if (!user_id || !comment_id) {
      return res.status(400).json({ ok: false, error: "user_id, comment_id 필요" });
    }

    const { data: existing, error: findErr } = await supabase
      .from("story_comment_likes")
      .select("comment_id")
      .eq("comment_id", comment_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (findErr) {
      logSupabaseErr("[story-comment-like] lookup", findErr);
      return res.status(500).json({ ok: false, error: findErr.message });
    }

    let liked = false;
    if (existing) {
      const { error } = await supabase
        .from("story_comment_likes")
        .delete()
        .eq("comment_id", comment_id)
        .eq("user_id", user_id);
      if (error) {
        logSupabaseErr("[story-comment-like] delete", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
      liked = false;
    } else {
      const { error } = await supabase
        .from("story_comment_likes")
        .insert([{ comment_id, user_id }]);
      if (error) {
        logSupabaseErr("[story-comment-like] insert", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
      liked = true;
    }

    const { count } = await supabase
      .from("story_comment_likes")
      .select("*", { count: "exact", head: true })
      .eq("comment_id", comment_id);

    return res.json({ ok: true, liked, like_count: count || 0 });
  } catch (e) {
    console.log("[story-comment-like]", e);
    return res.status(500).json({ ok: false, error: e.message || "failed" });
  }
}

app.get("/api/story-comments/:storyId", handleStoryCommentsListGet);
app.get("/story-comments/:storyId", handleStoryCommentsListGet);
app.post("/api/story-comments", handleStoryCommentsPost);
app.post("/story-comments", handleStoryCommentsPost);
app.patch("/api/story-comments/:id", handleStoryCommentsPatch);
app.patch("/story-comments/:id", handleStoryCommentsPatch);
app.delete("/api/story-comments/:id", handleStoryCommentsDelete);
app.delete("/story-comments/:id", handleStoryCommentsDelete);
app.post("/api/story-comment-like", handleStoryCommentLikePost);
app.post("/story-comment-like", handleStoryCommentLikePost);

// ─── 제작자 순위 · 캔디 귀속 · 하트 ─────────────────────────────────────────

const CREATOR_TIER_VALUES = new Set(["sprout", "pick", "partner", "ambassador"]);
const CREATOR_RANKING_ADMIN_PASSWORD = "333";

function readOptionalNonNegativeInt(obj, key) {
  if (obj == null || typeof obj !== "object") return null;
  const v = obj[key];
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function effectiveRankingHearts(tierRec, countedHearts) {
  const o = tierRec?.ranking_hearts_override;
  if (o !== null && o !== undefined && Number.isFinite(Number(o))) {
    return Math.max(0, Number(o));
  }
  return countedHearts;
}

function effectiveRankingCandyWindow(tierRec, countedCandy) {
  const o = tierRec?.ranking_candy_override;
  if (o !== null && o !== undefined && Number.isFinite(Number(o))) {
    return Math.max(0, Number(o));
  }
  return countedCandy;
}

function effectiveRankingFavorites(tierRec, countedFavorites) {
  const o = tierRec?.ranking_favorites_override;
  if (o !== null && o !== undefined && Number.isFinite(Number(o))) {
    return Math.max(0, Number(o));
  }
  return countedFavorites;
}

function creatorRankingWindowStart(windowRaw) {
  const w = (windowRaw || "7d").trim().toLowerCase();
  const now = Date.now();
  if (w === "all" || w === "lifetime") return null;
  const days = w === "30d" ? 30 : 7;
  return new Date(now - days * 86400000).toISOString();
}

function rankingRowFromVirtualCreatorProfile(p, windowStart) {
  const id = (p.id || "").trim();
  if (!id) return null;
  const creatorUserId = `virtual_${id}`;
  const displayName = (p.displayName || "").trim() || "제작자";
  const followers = Math.max(0, Number(p.followers) || 0);
  const hearts = Math.max(0, Number(p.hearts ?? p.heartsTotal) || followers);
  const favorites = Math.max(0, Number(p.favorites) || 0);
  const pointsLifetime = Math.max(
    0,
    Number(p.rankingPoints ?? p.pointsLifetime) || followers,
  );
  const seededCandy = Math.max(0, Number(p.rankingCandyWindow) || 0);
  const tierRaw = (p.tier || "sprout").trim().toLowerCase();
  const tier = CREATOR_TIER_VALUES.has(tierRaw) ? tierRaw : "sprout";
  const profileImagePath = (p.profileImagePath || "").trim();
  const featuredStoryTitle = (
    p.featuredStoryTitle ||
    p.representativeStoryTitle ||
    p.headlineStory ||
    ""
  ).trim();
  const worksCount = Math.max(0, Number(p.worksCount) || 0);
  const candyWindow = windowStart ? seededCandy : pointsLifetime;
  const score = candyWindow + hearts * 5 + favorites * 3;
  return {
    creatorUserId,
    displayName,
    tier,
    heartsTotal: hearts,
    candyWindow,
    pointsLifetime,
    score,
    isVirtual: true,
    profileImagePath,
    favoritesTotal: favorites,
    followersCount: followers,
    worksCount,
    featuredStoryTitle: featuredStoryTitle || undefined,
  };
}

async function mergeVirtualCreatorsIntoRanking(supabase, scored, windowStart) {
  const { data, error } = await readVirtualStoryCreatorRow(
    supabase,
    VIRTUAL_STORY_CREATOR_GLOBAL_USER_ID,
  );
  if (error) {
    logSupabaseErr("[creator-ranking] virtual profiles", error);
    return;
  }
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const byId = new Map(scored.map((r) => [r.creatorUserId, r]));
  for (const p of profiles) {
    const row = rankingRowFromVirtualCreatorProfile(p, windowStart);
    if (!row) continue;
    const existing = byId.get(row.creatorUserId);
    if (existing) {
      existing.heartsTotal = Math.max(existing.heartsTotal, row.heartsTotal);
      existing.pointsLifetime = Math.max(existing.pointsLifetime, row.pointsLifetime);
      existing.candyWindow = Math.max(existing.candyWindow, row.candyWindow);
      if (row.tier && row.tier !== "sprout") existing.tier = row.tier;
      if (!existing.displayName && row.displayName) {
        existing.displayName = row.displayName;
      }
      existing.favoritesTotal = Math.max(
        existing.favoritesTotal || 0,
        row.favoritesTotal || 0,
      );
      existing.score =
        existing.candyWindow +
        existing.heartsTotal * 5 +
        (existing.favoritesTotal || 0) * 3;
      existing.isVirtual = true;
      if (row.profileImagePath) existing.profileImagePath = row.profileImagePath;
      if (row.featuredStoryTitle) {
        existing.featuredStoryTitle = row.featuredStoryTitle;
      }
      if (row.followersCount) {
        existing.followersCount = Math.max(
          existing.followersCount || 0,
          row.followersCount,
        );
      }
      if (row.worksCount) {
        existing.worksCount = Math.max(existing.worksCount || 0, row.worksCount);
      }
    } else {
      scored.push(row);
      byId.set(row.creatorUserId, row);
    }
  }
}

async function handleCreatorCandyEventPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const spender_user_id = readString(req.body, "user_id");
    const creator_user_id = readString(req.body, "creator_user_id");
    const candies = readInt(req.body, "candies", 0);
    if (!spender_user_id || !creator_user_id) {
      return res.status(400).json({ ok: false, error: "user_id, creator_user_id 필요" });
    }
    if (creator_user_id === spender_user_id) {
      return res.status(200).json({ ok: true, skipped: "self_spend" });
    }
    if (!Number.isFinite(candies) || candies <= 0) {
      return res.status(400).json({ ok: false, error: "candies 필요(양수)" });
    }

    const content_type = readString(req.body, "content_type") || "";
    const content_id = readString(req.body, "content_id") || "";
    const reason = readString(req.body, "reason") || "spend";
    const display_name = readString(req.body, "creator_display_name") || "";

    const { error: insErr } = await supabase.from("creator_candy_events").insert([
      {
        creator_user_id,
        spender_user_id,
        content_type,
        content_id,
        candies,
        reason,
      },
    ]);
    if (insErr) {
      logSupabaseErr("[creator-candy-event] insert", insErr);
      return res.status(500).json({ ok: false, error: insErr.message });
    }

    const tierRow = {
      creator_user_id,
      updated_at: new Date().toISOString(),
    };
    if (display_name) tierRow.display_name = display_name;

    const { data: prevTier } = await supabase
      .from("creator_tiers")
      .select("points_lifetime, display_name, tier")
      .eq("creator_user_id", creator_user_id)
      .maybeSingle();

    const prevPts = Number(prevTier?.points_lifetime) || 0;
    tierRow.points_lifetime = prevPts + candies;
    if (!display_name && prevTier?.display_name) {
      tierRow.display_name = prevTier.display_name;
    }
    if (!tierRow.display_name) tierRow.display_name = "";
    tierRow.tier = (prevTier?.tier || "sprout").trim().toLowerCase();
    if (!CREATOR_TIER_VALUES.has(tierRow.tier)) tierRow.tier = "sprout";

    const { error: tierErr } = await supabase
      .from("creator_tiers")
      .upsert([tierRow], { onConflict: "creator_user_id" });
    if (tierErr) logSupabaseErr("[creator-candy-event] tier upsert", tierErr);

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[creator-candy-event]", e);
    return res.status(500).json({ ok: false });
  }
}

async function handleCreatorHeartPost(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const giver_user_id = readString(req.body, "user_id");
    const creator_user_id = readString(req.body, "creator_user_id");
    const liked = readBool(req.body, "liked");
    if (!giver_user_id || !creator_user_id) {
      return res.status(400).json({ ok: false, error: "user_id, creator_user_id 필요" });
    }
    if (giver_user_id === creator_user_id) {
      return res.status(200).json({ ok: true, skipped: "self" });
    }

    const display_name = readString(req.body, "creator_display_name") || "";

    if (liked) {
      const { error } = await supabase.from("creator_hearts").upsert(
        [{ creator_user_id, giver_user_id }],
        { onConflict: "creator_user_id,giver_user_id" },
      );
      if (error) {
        logSupabaseErr("[creator-heart] upsert", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
    } else {
      const { error } = await supabase
        .from("creator_hearts")
        .delete()
        .eq("creator_user_id", creator_user_id)
        .eq("giver_user_id", giver_user_id);
      if (error) {
        logSupabaseErr("[creator-heart] delete", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
    }

    if (display_name) {
      const { data: existing } = await supabase
        .from("creator_tiers")
        .select("creator_user_id")
        .eq("creator_user_id", creator_user_id)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("creator_tiers")
          .update({ display_name, updated_at: new Date().toISOString() })
          .eq("creator_user_id", creator_user_id);
      } else {
        await supabase.from("creator_tiers").insert([
          {
            creator_user_id,
            display_name,
            tier: "sprout",
            points_lifetime: 0,
          },
        ]);
      }
    }

    const { count } = await supabase
      .from("creator_hearts")
      .select("*", { count: "exact", head: true })
      .eq("creator_user_id", creator_user_id);

    return res.json({ ok: true, heartCount: count ?? 0 });
  } catch (e) {
    console.log("[creator-heart]", e);
    return res.status(500).json({ ok: false });
  }
}

async function handleCreatorRankingGet(req, res) {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "supabase 없음" });

    const windowStart = creatorRankingWindowStart(req.query?.window);
    const limitRaw = parseInt(String(req.query?.limit || "80"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 80;

    let candyQuery = supabase
      .from("creator_candy_events")
      .select("creator_user_id, candies");
    if (windowStart) {
      candyQuery = candyQuery.gte("created_at", windowStart);
    }
    const { data: candyRows, error: candyErr } = await candyQuery;
    if (candyErr) {
      logSupabaseErr("[creator-ranking] candy", candyErr);
      return res.status(500).json({ error: candyErr.message });
    }

    const candyByCreator = new Map();
    for (const r of candyRows || []) {
      const id = (r.creator_user_id || "").trim();
      if (!id) continue;
      const n = Number(r.candies) || 0;
      candyByCreator.set(id, (candyByCreator.get(id) || 0) + n);
    }

    const { data: heartRows, error: heartErr } = await supabase
      .from("creator_hearts")
      .select("creator_user_id");
    if (heartErr) {
      logSupabaseErr("[creator-ranking] hearts", heartErr);
      return res.status(500).json({ error: heartErr.message });
    }

    const heartsByCreator = new Map();
    for (const r of heartRows || []) {
      const id = (r.creator_user_id || "").trim();
      if (!id) continue;
      heartsByCreator.set(id, (heartsByCreator.get(id) || 0) + 1);
    }

    const creatorIds = new Set([...candyByCreator.keys(), ...heartsByCreator.keys()]);

    const { data: tierRows } = await supabase.from("creator_tiers").select("*");
    const tierById = new Map();
    for (const t of tierRows || []) {
      const id = (t.creator_user_id || "").trim();
      if (id) tierById.set(id, t);
    }

    for (const id of tierById.keys()) creatorIds.add(id);

    const scored = [];
    for (const creatorUserId of creatorIds) {
      const tierRec = tierById.get(creatorUserId);
      const countedCandy = candyByCreator.get(creatorUserId) || 0;
      const countedHearts = heartsByCreator.get(creatorUserId) || 0;
      const windowCandy = effectiveRankingCandyWindow(tierRec, countedCandy);
      const hearts = effectiveRankingHearts(tierRec, countedHearts);
      const lifetimePoints = Number(tierRec?.points_lifetime) || 0;
      const tierRaw = (tierRec?.tier || "sprout").trim().toLowerCase();
      const tier = CREATOR_TIER_VALUES.has(tierRaw) ? tierRaw : "sprout";
      const displayName = (tierRec?.display_name || "").trim();
      const favorites = effectiveRankingFavorites(tierRec, 0);
      const score = windowCandy + hearts * 5 + favorites * 3;
      scored.push({
        creatorUserId,
        displayName,
        tier,
        heartsTotal: hearts,
        favoritesTotal: favorites,
        candyWindow: windowCandy,
        pointsLifetime: lifetimePoints,
        score,
        followersCount: 0,
        worksCount: 0,
      });
    }

    await mergeVirtualCreatorsIntoRanking(supabase, scored, windowStart);

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.pointsLifetime !== a.pointsLifetime) return b.pointsLifetime - a.pointsLifetime;
      return a.creatorUserId.localeCompare(b.creatorUserId);
    });

    res.json({ ok: true, window: windowStart ? (req.query?.window || "7d") : "all", rows: scored.slice(0, limit) });
  } catch (e) {
    console.log("[creator-ranking]", e);
    res.status(500).json({ error: "server error" });
  }
}

app.post("/api/creator-candy-event", handleCreatorCandyEventPost);
app.post("/creator-candy-event", handleCreatorCandyEventPost);
app.post("/api/creator-heart", handleCreatorHeartPost);
app.post("/creator-heart", handleCreatorHeartPost);
app.get("/api/creator-ranking", handleCreatorRankingGet);
app.get("/creator-ranking", handleCreatorRankingGet);

async function handleCreatorTierGet(req, res) {
  try {
    const creator_user_id = (req.params?.creatorUserId || "").trim();
    if (!creator_user_id) {
      return res.status(400).json({ ok: false, error: "creatorUserId 필요" });
    }
    if (creator_user_id.startsWith("virtual_")) {
      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });
      const { data, error } = await readVirtualStoryCreatorRow(
        supabase,
        VIRTUAL_STORY_CREATOR_GLOBAL_USER_ID,
      );
      if (error) {
        logSupabaseErr("[creator-tier] virtual", error);
        return res.status(500).json({ ok: false, error: error.message });
      }
      const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
      const vid = creator_user_id.substring("virtual_".length);
      const p = profiles.find((x) => (x.id || "").trim() === vid);
      const tierRaw = (p?.tier || "sprout").trim().toLowerCase();
      const tier = CREATOR_TIER_VALUES.has(tierRaw) ? tierRaw : "sprout";
      const pointsLifetime = Math.max(
        0,
        Number(p?.rankingPoints ?? p?.pointsLifetime) ||
          Number(p?.followers) ||
          0,
      );
      return res.json({ ok: true, tier, pointsLifetime });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });
    const { data, error } = await supabase
      .from("creator_tiers")
      .select("tier, points_lifetime")
      .eq("creator_user_id", creator_user_id)
      .maybeSingle();
    if (error) {
      logSupabaseErr("[creator-tier] get", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    const tierRaw = (data?.tier || "sprout").trim().toLowerCase();
    const tier = CREATOR_TIER_VALUES.has(tierRaw) ? tierRaw : "sprout";
    return res.json({
      ok: true,
      tier,
      pointsLifetime: Number(data?.points_lifetime) || 0,
    });
  } catch (e) {
    console.log("[creator-tier]", e);
    return res.status(500).json({ ok: false });
  }
}

async function handleCreatorRankingAdminPost(req, res) {
  try {
    const admin_password = readString(req.body, "admin_password");
    if (admin_password !== CREATOR_RANKING_ADMIN_PASSWORD) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const creator_user_id = readString(req.body, "creator_user_id");
    if (!creator_user_id || creator_user_id.startsWith("virtual_")) {
      return res.status(400).json({ ok: false, error: "creator_user_id 필요" });
    }
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase 없음" });

    const tierRaw = readString(req.body, "tier").trim().toLowerCase() || "sprout";
    const tier = CREATOR_TIER_VALUES.has(tierRaw) ? tierRaw : "sprout";
    const display_name =
      readString(req.body, "creator_display_name") ||
      readString(req.body, "display_name") ||
      "";
    const points_lifetime = readInt(req.body, "points_lifetime", 0);
    const ranking_hearts_override = readOptionalNonNegativeInt(
      req.body,
      "ranking_hearts_override",
    );
    const ranking_candy_override = readOptionalNonNegativeInt(
      req.body,
      "ranking_candy_override",
    );
    const ranking_favorites_override = readOptionalNonNegativeInt(
      req.body,
      "ranking_favorites_override",
    );

    const row = {
      creator_user_id,
      tier,
      points_lifetime: Math.max(0, points_lifetime),
      updated_at: new Date().toISOString(),
    };
    if (display_name) row.display_name = display_name;
    if (ranking_hearts_override !== null) {
      row.ranking_hearts_override = ranking_hearts_override;
    }
    if (ranking_candy_override !== null) {
      row.ranking_candy_override = ranking_candy_override;
    }
    if (ranking_favorites_override !== null) {
      row.ranking_favorites_override = ranking_favorites_override;
    }

    const { error } = await supabase
      .from("creator_tiers")
      .upsert([row], { onConflict: "creator_user_id" });
    if (error) {
      logSupabaseErr("[creator-ranking-admin] upsert", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.log("[creator-ranking-admin]", e);
    return res.status(500).json({ ok: false });
  }
}

app.get("/api/creator-tier/:creatorUserId", handleCreatorTierGet);
app.get("/creator-tier/:creatorUserId", handleCreatorTierGet);
app.post("/api/creator-ranking-admin", handleCreatorRankingAdminPost);
app.post("/creator-ranking-admin", handleCreatorRankingAdminPost);

const PORT = Number(process.env.PORT) || 3000;

logSupabaseInit();
if (isAnthropicConfigured()) {
  console.log(
    `[story-chat] provider=anthropic model=${STORY_CHAT_ANTHROPIC_MODEL}`,
  );
  console.log(
    `[story-suggestions] provider=anthropic model=${STORY_SUGGESTION_ANTHROPIC_MODEL}`,
  );
  console.log(
    `[live-comments] provider=anthropic model=${LIVE_COMMENT_ANTHROPIC_MODEL}`,
  );
  console.log(
    `[comment] provider=anthropic model=${STORY_CREATION_ANTHROPIC_MODEL}`,
  );
  console.log(
    `[story-chat-scene] provider=anthropic model=${STORY_SCENE_ANTHROPIC_MODEL}`,
  );
} else {
  console.error("[story-chat] ERROR Anthropic is not configured (set ANTHROPIC_API_KEY)");
}
console.log(
  `[ai-server] openaiConfigured=${!!OPENAI_API_KEY} (TTS/image only)`,
);
if (!isAnthropicConfigured()) {
  console.log(
    `[live-comments] provider=openai model=${OPENAI_MODEL} (set ANTHROPIC_API_KEY to use Claude)`,
  );
}

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
