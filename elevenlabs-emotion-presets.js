/** Sonnet categorical emotion + intensity → ElevenLabs voice_settings. */

const BASE = {
  calm: { speed: 0.95, stability: 0.68, style: 0.08, similarity: 0.8 },
  happy: { speed: 1.0, stability: 0.58, style: 0.18, similarity: 0.78 },
  sad: { speed: 0.9, stability: 0.72, style: 0.1, similarity: 0.82 },
  tense: { speed: 1.02, stability: 0.52, style: 0.18, similarity: 0.78 },
  frightened: { speed: 1.06, stability: 0.38, style: 0.32, similarity: 0.75 },
  angry: { speed: 1.08, stability: 0.45, style: 0.35, similarity: 0.78 },
  irritated: { speed: 0.98, stability: 0.55, style: 0.15, similarity: 0.76 },
  cold: { speed: 0.93, stability: 0.62, style: 0.1, similarity: 0.8 },
  threatening: { speed: 0.94, stability: 0.48, style: 0.25, similarity: 0.78 },
  whisper: { speed: 0.82, stability: 0.7, style: 0.12, similarity: 0.85 },
};

const INTENSITY = {
  low: { speed: -0.03, stability: 0.06, style: -0.04 },
  medium: { speed: 0, stability: 0, style: 0 },
  high: { speed: 0.04, stability: -0.08, style: 0.06 },
};

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function normalizeVoiceEmotion(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "calm";
  if (v === "fear") return "frightened";
  if (v === "anger") return "angry";
  if (v === "cheerful") return "happy";
  if (Object.prototype.hasOwnProperty.call(BASE, v)) return v;
  return "calm";
}

export function normalizeVoiceIntensity(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  return "medium";
}

export function voiceSettingsFromEmotionPreset(voiceEmotion, voiceIntensity) {
  const emotion = normalizeVoiceEmotion(voiceEmotion);
  const intensity = normalizeVoiceIntensity(voiceIntensity);
  const base = BASE[emotion] || BASE.calm;
  const delta = INTENSITY[intensity] || INTENSITY.medium;
  return {
    speed: clamp(base.speed + delta.speed, 0.85, 1.08),
    stability: clamp(base.stability + delta.stability, 0.28, 0.85),
    style: clamp(base.style + delta.style, 0, 0.35),
    similarity_boost: clamp(base.similarity, 0.65, 0.85),
    use_speaker_boost: true,
    presetId: `${emotion}_${intensity}`,
  };
}
