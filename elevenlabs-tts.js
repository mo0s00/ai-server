/** ElevenLabs TTS — 계정에서 쓸 수 있는 목소리만 고른다. */

const ELEVENLABS_API_KEY = (
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_API_KEY ||
  ""
).trim();

const ELEVENLABS_TTS_MODEL = (
  process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5"
).trim();

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v1/voices";

const ENV_DEFAULT_VOICE = (process.env.ELEVENLABS_DEFAULT_VOICE_ID || "").trim();
const ENV_FEMALE_VOICE = (process.env.ELEVENLABS_VOICE_FEMALE || "").trim();
const ENV_MALE_VOICE = (process.env.ELEVENLABS_VOICE_MALE || "").trim();

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.68,
  similarity_boost: 0.8,
  style: 0.08,
  speed: 0.95,
  use_speaker_boost: true,
};

const CATEGORY_RANK = {
  generated: 0,
  cloned: 1,
  premade: 2,
};

let voicesCache = null;
let voicesCacheAt = 0;
const VOICES_TTL_MS = 10 * 60 * 1000;

export function isElevenLabsConfigured() {
  return !!ELEVENLABS_API_KEY;
}

export function elevenLabsTtsModel() {
  return ELEVENLABS_TTS_MODEL;
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

function categoryRank(voice) {
  const cat = String((voice && voice.category) || "").toLowerCase();
  return CATEGORY_RANK[cat] ?? 9;
}

function isPreferredApiVoice(voice) {
  const cat = String((voice && voice.category) || "").toLowerCase();
  return cat === "generated" || cat === "cloned";
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

function pickAccountVoiceId({ voices, gender, ageStyle, voiceRaw }) {
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

  const ranked = [...voices].sort((a, b) => {
    const own = Number(isPreferredApiVoice(a)) - Number(isPreferredApiVoice(b));
    if (own !== 0) return own > 0 ? -1 : 1;
    const cat = categoryRank(a) - categoryRank(b);
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
  return String(ranked[0].voice_id || "");
}

function fallbackOwnedVoiceId(voices, failedId) {
  const owned = voices.filter(isPreferredApiVoice);
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
      1,
      DEFAULT_VOICE_SETTINGS.similarity_boost,
    ),
    style: clamp(src.style, 0, 1, DEFAULT_VOICE_SETTINGS.style),
    speed: clamp(src.speed, 0.7, 1.2, DEFAULT_VOICE_SETTINGS.speed),
    use_speaker_boost: src.use_speaker_boost !== false,
  };
}

async function postSpeech({ voiceId, body }) {
  const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
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

export async function synthesizeElevenLabsMp3({
  text,
  voiceRaw,
  voicePreset,
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
  let voiceId =
    pickAccountVoiceId({ voices, gender, ageStyle, voiceRaw }) ||
    ENV_DEFAULT_VOICE;
  if (!voiceId) {
    const err = new Error("no usable elevenlabs voice on this account");
    err.status = 502;
    throw err;
  }

  const settings = normalizeElevenLabsVoiceSettings(voiceSettings);
  const lang = String(language || "ko").trim().toLowerCase() || "ko";
  const body = {
    text: input.length > 4096 ? input.slice(0, 4096) : input,
    model_id: ELEVENLABS_TTS_MODEL,
    voice_settings: settings,
  };
  if (lang && lang !== "auto" && /flash|turbo/i.test(ELEVENLABS_TTS_MODEL)) {
    body.language_code = lang.slice(0, 8);
  }

  console.log(
    `[story-tts] elevenlabs preset=${voicePreset || "calm"} voice=${voiceId} ` +
      `model=${ELEVENLABS_TTS_MODEL} speed=${settings.speed} ` +
      `stability=${settings.stability} style=${settings.style} ` +
      `similarity=${settings.similarity_boost} ageStyle=${ageStyle || ""}`,
  );

  try {
    return await postSpeech({ voiceId, body });
  } catch (e) {
    if (!isLibraryVoiceBlocked(e.httpStatus, e.upstream || e.message)) {
      throw e;
    }
    const retryId = fallbackOwnedVoiceId(voices, voiceId);
    if (!retryId) throw e;
    console.warn(
      `[story-tts] elevenlabs library voice blocked → retry owned voice=${retryId}`,
    );
    return postSpeech({ voiceId: retryId, body });
  }
}
