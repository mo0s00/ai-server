/** ElevenLabs Sound Effects — 환경음·효과음. TTS와 별도. */

const ELEVENLABS_API_KEY = (
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_API_KEY ||
  ""
).trim();

const ELEVENLABS_SFX_URL = "https://api.elevenlabs.io/v1/sound-generation";
const ELEVENLABS_SFX_MODEL = "eleven_text_to_sound_v2";

export function isElevenLabsSfxConfigured() {
  return !!ELEVENLABS_API_KEY;
}

export function elevenLabsSfxModel() {
  return ELEVENLABS_SFX_MODEL;
}

/**
 * @param {{ text: string, loop?: boolean, durationSeconds?: number }} opts
 * @returns {Promise<{ buffer: Buffer, model: string, loop: boolean }>}
 */
export async function synthesizeElevenLabsSfxMp3({
  text,
  loop = false,
  durationSeconds,
}) {
  const prompt = String(text || "").trim();
  if (!prompt) {
    const err = new Error("no sound prompt");
    err.status = 400;
    throw err;
  }
  if (!ELEVENLABS_API_KEY) {
    const err = new Error("no ELEVENLABS_API_KEY");
    err.status = 500;
    throw err;
  }

  const body = {
    text: prompt.slice(0, 450),
    model_id: ELEVENLABS_SFX_MODEL,
    loop: !!loop,
  };
  const dur = Number(durationSeconds);
  if (Number.isFinite(dur)) {
    body.duration_seconds = Math.min(30, Math.max(0.5, dur));
  }

  const res = await fetch(ELEVENLABS_SFX_URL, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const raw = await res.text();
    const err = new Error(raw.slice(0, 240) || "sound generation failed");
    err.status = res.status;
    err.upstream = raw.slice(0, 400);
    throw err;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, model: ELEVENLABS_SFX_MODEL, loop: !!loop };
}
