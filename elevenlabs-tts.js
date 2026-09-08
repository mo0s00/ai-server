/** ElevenLabs TTS — 한편 대사 전용. 숫자는 앱이 고른 preset만 받는다. */

const ELEVENLABS_API_KEY = (
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_API_KEY ||
  ""
).trim();

const ELEVENLABS_TTS_MODEL = (
  process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5"
).trim();

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** OpenAI 보이스 이름 → ElevenLabs premade voice id */
const OPENAI_TO_ELEVENLABS_VOICE = {
  nova: "EXAVITQu4vr4xnSDxMaL", // Sarah
  shimmer: "pFZP5JQG7iQjIQuC4Bku", // Lily
  coral: "XB0fDUnXU5powFXDhCwa", // Charlotte
  sage: "XrExE9yKIg1WjnnlVkGX", // Matilda
  onyx: "pNInz6obpgDQGcFmaJgB", // Adam
  echo: "onwK4e9ZLuTAKqWW03F9", // Daniel
  fable: "JBFqnCBsd6RMkjVDRZzb", // George
  alloy: "21m00Tcm4TlvDq8ikWAM", // Rachel
  ash: "N2lVS1w4EtoT3dr4eOWO", // Callum
  ballad: "IKne3meq5aSn9XLyUdCD", // Charlie
  verse: "cgSgspJ2msm6clMCkdW9", // Jessica
};

const ELEVENLABS_VOICE_BY_AGE = {
  child_female: "jBpfuIE2acCO8z3wKNLl", // Gigi
  child_male: "SOYHLrjzK2X1ezoPC6cr", // Harry
  elderly_female: "ThT5KcBeYPX3keUQqHPh", // Dorothy
  elderly_male: "JBFqnCBsd6RMkjVDRZzb", // George
  adult_female: "EXAVITQu4vr4xnSDxMaL", // Sarah
  adult_male: "pNInz6obpgDQGcFmaJgB", // Adam
};

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.68,
  similarity_boost: 0.8,
  style: 0.08,
  speed: 0.95,
  use_speaker_boost: true,
};

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
  return g.includes("여") || g.includes("female") || g.includes("woman") || g.includes("girl");
}

function isMaleHint(gender) {
  const g = String(gender || "").toLowerCase();
  return g.includes("남") || g.includes("male") || g.includes("man") || g.includes("boy");
}

export function resolveElevenLabsVoiceId({
  voiceRaw,
  ageStyle,
  gender,
} = {}) {
  const raw = String(voiceRaw || "").trim();
  if (isElevenLabsVoiceId(raw) && !OPENAI_TO_ELEVENLABS_VOICE[raw.toLowerCase()]) {
    return raw;
  }

  const age = String(ageStyle || "").trim().toLowerCase();
  const female = isFemaleHint(gender) || (!isMaleHint(gender) && !raw);
  if (age === "child") {
    return female ? ELEVENLABS_VOICE_BY_AGE.child_female : ELEVENLABS_VOICE_BY_AGE.child_male;
  }
  if (age === "elderly") {
    return female ? ELEVENLABS_VOICE_BY_AGE.elderly_female : ELEVENLABS_VOICE_BY_AGE.elderly_male;
  }

  const mapped = OPENAI_TO_ELEVENLABS_VOICE[raw.toLowerCase()];
  if (mapped) return mapped;
  return female ? ELEVENLABS_VOICE_BY_AGE.adult_female : ELEVENLABS_VOICE_BY_AGE.adult_male;
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
  const voiceId = resolveElevenLabsVoiceId({
    voiceRaw,
    ageStyle,
    gender,
  });
  const settings = normalizeElevenLabsVoiceSettings(voiceSettings);
  const lang = String(language || "ko").trim().toLowerCase() || "ko";
  const body = {
    text: input.length > 4096 ? input.slice(0, 4096) : input,
    model_id: ELEVENLABS_TTS_MODEL,
    voice_settings: settings,
  };
  if (
    lang &&
    lang !== "auto" &&
    /flash|turbo/i.test(ELEVENLABS_TTS_MODEL)
  ) {
    body.language_code = lang.slice(0, 8);
  }

  console.log(
    `[story-tts] elevenlabs preset=${voicePreset || "calm"} voice=${voiceId} ` +
      `model=${ELEVENLABS_TTS_MODEL} speed=${settings.speed} ` +
      `stability=${settings.stability} style=${settings.style} ` +
      `similarity=${settings.similarity_boost} ageStyle=${ageStyle || ""}`,
  );

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
    err.status = 502;
    err.upstream = raw.slice(0, 400);
    throw err;
  }
  return Buffer.from(await ttsRes.arrayBuffer());
}
