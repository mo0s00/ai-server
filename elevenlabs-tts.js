/** ElevenLabs TTS — 품질 우선. 라이브러리 음성을 먼저 쓰고, 막히면 계정 목소리로 내린다. */

import { voiceSettingsFromEmotionPreset } from "./elevenlabs-emotion-presets.js";

const ELEVENLABS_API_KEY = (
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_API_KEY ||
  ""
).trim();

const ELEVENLABS_TTS_MODEL = (
  process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2"
).trim();

/** Starter 플랜은 192kbps 불가. 128은 전 플랜에서 됨. */
const ELEVENLABS_OUTPUT_FORMAT = (
  process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128"
).trim();

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v1/voices";

const ENV_DEFAULT_VOICE = (process.env.ELEVENLABS_DEFAULT_VOICE_ID || "").trim();
const ENV_FEMALE_VOICE = (process.env.ELEVENLABS_VOICE_FEMALE || "").trim();
const ENV_MALE_VOICE = (process.env.ELEVENLABS_VOICE_MALE || "").trim();

/** OpenAI 보이스 이름 → ElevenLabs premade. 한국어에 무난한 쪽을 고른다. */
const OPENAI_TO_ELEVENLABS_VOICE = {
  nova: "EXAVITQu4vr4xnSDxMaL", // Sarah
  shimmer: "pFZP5JQG7iQjIQuC4Bku", // Lily
  coral: "XB0fDUnXU5powFXDhCwa", // Charlotte
  sage: "XrExE9yKIg1WjnnlVkGX", // Matilda
  onyx: "pNInz6obpgDQGcFmaJgB", // Adam
  echo: "onwK4e9ZLuTAKqWW03F9", // Daniel
  fable: "JBFqnCBsd6RMkjVDRZzb", // George
  alloy: "21m00Tcm4TlvDq8ikWAM", // Rachel
  ash: "N2lVS1w4EtoT3xRj7jJY", // Callum
  ballad: "IKne3meq5aSn9XLyUdCD", // Charlie
  verse: "XB0fDUnXU5powFXDhCwa", // Charlotte
};

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.62,
  similarity_boost: 0.75,
  style: 0.08,
  speed: 0.98,
  use_speaker_boost: true,
};

let voicesCache = null;
let voicesCacheAt = 0;
const VOICES_TTL_MS = 10 * 60 * 1000;
let libraryVoicesBlocked = false;

export function isElevenLabsConfigured() {
  return !!ELEVENLABS_API_KEY;
}

export function elevenLabsTtsModel() {
  return ELEVENLABS_TTS_MODEL;
}

export function elevenLabsOutputFormat() {
  return ELEVENLABS_OUTPUT_FORMAT;
}

function clamp(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

function isElevenLabsVoiceId(raw) {
  return /^[A-Za-z0-9]{16,}$/.test(String(raw || "").trim());
}

function isFemaleHint(gender) {
  const g = String(gender || "").toLowerCase();
  return (
    g.includes("여") ||
    g.includes("female") ||
    g.includes("woman") ||
    g.includes("girl")
  );
}

function isMaleHint(gender) {
  const g = String(gender || "").toLowerCase();
  return (
    g.includes("남") ||
    g.includes("male") ||
    g.includes("man") ||
    g.includes("boy")
  );
}

function voiceGender(voice) {
  const labels = voice && voice.labels && typeof voice.labels === "object"
    ? voice.labels
    : {};
  const blob = [
    labels.gender,
    labels.sex,
    voice.name,
    voice.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    blob.includes("female") ||
    blob.includes("woman") ||
    blob.includes("girl") ||
    blob.includes("여")
  ) {
    return "female";
  }
  if (
    blob.includes("male") ||
    blob.includes("man") ||
    blob.includes("boy") ||
    blob.includes("남")
  ) {
    return "male";
  }
  return "";
}

function voiceAgeHint(voice) {
  const labels = voice && voice.labels && typeof voice.labels === "object"
    ? voice.labels
    : {};
  const blob = [labels.age, voice.name, voice.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    blob.includes("child") ||
    blob.includes("kid") ||
    blob.includes("young") ||
    blob.includes("아이") ||
    blob.includes("소년") ||
    blob.includes("소녀")
  ) {
    return "child";
  }
  if (
    blob.includes("old") ||
    blob.includes("elder") ||
    blob.includes("senior") ||
    blob.includes("노인")
  ) {
    return "elderly";
  }
  return "adult";
}

function categoryOf(voice) {
  return String((voice && voice.category) || "").toLowerCase();
}

function isOwnedVoice(voice) {
  const cat = categoryOf(voice);
  return cat === "cloned" || cat === "generated" || cat === "professional";
}

function categoryRank(voice, { allowPremade }) {
  const cat = categoryOf(voice);
  if (allowPremade) {
    if (cat === "premade") return 0;
    if (cat === "cloned" || cat === "professional") return 1;
    if (cat === "generated") return 2;
    return 3;
  }
  if (cat === "cloned" || cat === "professional") return 0;
  if (cat === "generated") return 1;
  return 9;
}

async function fetchAccountVoices() {
  if (voicesCache && Date.now() - voicesCacheAt < VOICES_TTL_MS) {
    return voicesCache;
  }
  const res = await fetch(ELEVENLABS_VOICES_URL, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    const raw = await res.text();
    console.error("[story-tts] voices list failed", res.status, raw.slice(0, 200));
    return voicesCache || [];
  }
  const data = await res.json();
  const voices = Array.isArray(data.voices) ? data.voices : [];
  voicesCache = voices;
  voicesCacheAt = Date.now();
  const summary = {};
  for (const v of voices) {
    const cat = String(v.category || "unknown");
    summary[cat] = (summary[cat] || 0) + 1;
  }
  console.log(
    `[story-tts] elevenlabs voices=${voices.length} ` +
      Object.entries(summary)
        .map(([k, n]) => `${k}:${n}`)
        .join(" "),
  );
  return voices;
}

function voiceNameById(voices, voiceId) {
  const found = voices.find((v) => v.voice_id === voiceId);
  return found && found.name ? String(found.name) : "";
}

function mappedPremadeId(voiceRaw) {
  const key = String(voiceRaw || "").trim().toLowerCase();
  return OPENAI_TO_ELEVENLABS_VOICE[key] || "";
}

function pickAccountVoiceId({ voices, gender, ageStyle, voiceRaw, allowPremade }) {
  if (!voices.length) return "";
  const female = isFemaleHint(gender);
  const male = isMaleHint(gender);
  const wantAge = String(ageStyle || "").trim().toLowerCase();
  const raw = String(voiceRaw || "").trim();

  if (isElevenLabsVoiceId(raw) && voices.some((v) => v.voice_id === raw)) {
    return raw;
  }

  const envHint = female
    ? ENV_FEMALE_VOICE
    : male
      ? ENV_MALE_VOICE
      : ENV_DEFAULT_VOICE;
  if (envHint && voices.some((v) => v.voice_id === envHint)) return envHint;
  if (ENV_DEFAULT_VOICE && voices.some((v) => v.voice_id === ENV_DEFAULT_VOICE)) {
    return ENV_DEFAULT_VOICE;
  }

  const pool = allowPremade ? voices : voices.filter(isOwnedVoice);
  const ranked = [...(pool.length ? pool : voices)].sort((a, b) => {
    const cat = categoryRank(a, { allowPremade }) - categoryRank(b, { allowPremade });
    if (cat !== 0) return cat;
    const ageA = voiceAgeHint(a) === wantAge ? 0 : 1;
    const ageB = voiceAgeHint(b) === wantAge ? 0 : 1;
    if (ageA !== ageB) return ageA - ageB;
    const gA = voiceGender(a);
    const gB = voiceGender(b);
    const want = female ? "female" : male ? "male" : "";
    const matchA = want && gA === want ? 0 : 1;
    const matchB = want && gB === want ? 0 : 1;
    return matchA - matchB;
  });
  return String((ranked[0] && ranked[0].voice_id) || "");
}

function fallbackOwnedVoiceId(voices, failedId) {
  const owned = voices.filter(isOwnedVoice);
  const pool = owned.length ? owned : voices;
  const next = pool.find((v) => v.voice_id && v.voice_id !== failedId);
  return next ? String(next.voice_id) : "";
}

function isLibraryVoiceBlocked(status, raw) {
  const text = String(raw || "").toLowerCase();
  return (
    status === 402 ||
    text.includes("paid_plan_required") ||
    text.includes("library voices") ||
    text.includes("payment_required")
  );
}

export function normalizeElevenLabsVoiceSettings(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    stability: clamp(src.stability, 0, 1, DEFAULT_VOICE_SETTINGS.stability),
    similarity_boost: clamp(
      src.similarity_boost ?? src.similarity,
      0,
      0.85,
      DEFAULT_VOICE_SETTINGS.similarity_boost,
    ),
    style: clamp(src.style, 0, 0.28, DEFAULT_VOICE_SETTINGS.style),
    speed: clamp(src.speed, 0.85, 1.08, DEFAULT_VOICE_SETTINGS.speed),
    use_speaker_boost: src.use_speaker_boost !== false,
  };
}

async function postSpeech({ voiceId, body }) {
  const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
  const ttsRes = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });
  if (!ttsRes.ok) {
    const raw = await ttsRes.text();
    const err = new Error(raw.slice(0, 200) || "elevenlabs tts failed");
    err.status = ttsRes.status === 402 ? 502 : ttsRes.status >= 400 ? 502 : 502;
    err.httpStatus = ttsRes.status;
    err.upstream = raw.slice(0, 400);
    throw err;
  }
  return Buffer.from(await ttsRes.arrayBuffer());
}

function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const v = String(id || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export async function synthesizeElevenLabsMp3({
  text,
  voiceRaw,
  voicePreset,
  voiceEmotion,
  voiceIntensity,
  voiceSettings,
  ageStyle,
  gender,
  language,
}) {
  if (!ELEVENLABS_API_KEY) {
    const err = new Error("no ELEVENLABS_API_KEY");
    err.status = 500;
    throw err;
  }
  const input = String(text || "").trim();
  if (!input) {
    const err = new Error("no text");
    err.status = 400;
    throw err;
  }

  const voices = await fetchAccountVoices();
  const requested = String(voiceRaw || "").trim();
  const locked = isElevenLabsVoiceId(requested);
  let candidates;
  if (locked) {
    candidates = [requested];
  } else {
    const mapped = mappedPremadeId(requested);
    const picked = pickAccountVoiceId({
      voices,
      gender,
      ageStyle,
      voiceRaw: requested,
      allowPremade: !libraryVoicesBlocked,
    });
    candidates = uniqueIds([
      libraryVoicesBlocked ? "" : mapped,
      picked,
      ENV_DEFAULT_VOICE,
      fallbackOwnedVoiceId(voices, picked),
    ]);
  }
  if (!candidates.length) {
    const err = new Error("no usable elevenlabs voice on this account");
    err.status = 502;
    throw err;
  }

  const emotionPreset =
    String(voiceEmotion || "").trim().length > 0
      ? voiceSettingsFromEmotionPreset(voiceEmotion, voiceIntensity)
      : null;
  const settings = emotionPreset
    ? {
        stability: emotionPreset.stability,
        similarity_boost: emotionPreset.similarity_boost,
        style: emotionPreset.style,
        speed: emotionPreset.speed,
        use_speaker_boost: emotionPreset.use_speaker_boost,
      }
    : normalizeElevenLabsVoiceSettings(voiceSettings);
  const effectivePreset = emotionPreset?.presetId || voicePreset || "calm";
  const lang = String(language || "ko").trim().toLowerCase() || "ko";
  const isLowLatency = /flash|turbo/i.test(ELEVENLABS_TTS_MODEL);
  const body = {
    text: input.length > 4096 ? input.slice(0, 4096) : input,
    model_id: ELEVENLABS_TTS_MODEL,
    voice_settings: {
      stability: settings.stability,
      similarity_boost: settings.similarity_boost,
      style: settings.style,
      speed: settings.speed,
      use_speaker_boost: settings.use_speaker_boost,
    },
    apply_text_normalization: "auto",
  };
  if (lang && lang !== "auto" && isLowLatency) {
    body.language_code = lang.slice(0, 8);
  }

  let lastErr = null;
  for (const voiceId of candidates) {
    const voiceName = voiceNameById(voices, voiceId);
    console.log(
      `[story-tts] elevenlabs requested=${requested || "(empty)"} ` +
        `locked=${locked ? 1 : 0} preset=${effectivePreset} ` +
        `emotion=${String(voiceEmotion || "").trim() || "-"} ` +
        `intensity=${String(voiceIntensity || "").trim() || "-"} ` +
        `voice=${voiceId} name=${voiceName || "?"} model=${ELEVENLABS_TTS_MODEL} ` +
        `output=${ELEVENLABS_OUTPUT_FORMAT} ` +
        `speed=${settings.speed} stability=${settings.stability} ` +
        `style=${settings.style} similarity=${settings.similarity_boost} ` +
        `ageStyle=${ageStyle || ""}`,
    );
    try {
      const buffer = await postSpeech({ voiceId, body });
      return {
        buffer,
        voiceId,
        voiceName,
        model: ELEVENLABS_TTS_MODEL,
        output: ELEVENLABS_OUTPUT_FORMAT,
        locked,
      };
    } catch (e) {
      lastErr = e;
      if (locked) {
        console.error(
          `[story-tts] locked voice failed voice=${voiceId} — no substitute`,
        );
        throw e;
      }
      if (!isLibraryVoiceBlocked(e.httpStatus, e.upstream || e.message)) {
        throw e;
      }
      libraryVoicesBlocked = true;
      console.warn(
        `[story-tts] elevenlabs library voice blocked voice=${voiceId} → try owned`,
      );
    }
  }
  throw lastErr || new Error("elevenlabs tts failed");
}
