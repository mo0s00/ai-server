/** Sonnet voiceEmotion + intensity → Eleven v3 inline audio tags. */

import {
  normalizeVoiceEmotion,
  normalizeVoiceIntensity,
} from "./elevenlabs-emotion-presets.js";

/** @type {Record<string, Record<string, string>>} */
const EMOTION_TAGS = {
  calm: { low: "", medium: "", high: "" },
  happy: {
    low: "[softly, happy]",
    medium: "[happy]",
    high: "[excited]",
  },
  sad: {
    low: "[quietly, sad]",
    medium: "[sad]",
    high: "[crying]",
  },
  tense: {
    low: "[quietly]",
    medium: "[nervously]",
    high: "[anxiously]",
  },
  frightened: {
    low: "[quietly, fearful]",
    medium: "[fearful]",
    high: "[panicked]",
  },
  angry: {
    low: "[quietly, holding back anger]",
    medium: "[angry]",
    high: "[shouting]",
  },
  irritated: {
    low: "[annoyed]",
    medium: "[annoyed]",
    high: "[frustrated]",
  },
  cold: {
    low: "[coldly]",
    medium: "[coldly]",
    high: "[harshly]",
  },
  threatening: {
    low: "[menacingly]",
    medium: "[threatening]",
    high: "[menacingly, slow]",
  },
  whisper: {
    low: "[whispers]",
    medium: "[whispers]",
    high: "[whispers]",
  },
};

export function isElevenV3Model(modelId) {
  return /eleven_v3/i.test(String(modelId || "").trim());
}

export function audioTagFromEmotion(voiceEmotion, voiceIntensity, voicePreset) {
  const emotion = normalizeVoiceEmotion(voiceEmotion || voicePreset);
  const intensity = normalizeVoiceIntensity(voiceIntensity);
  const table = EMOTION_TAGS[emotion];
  if (!table) return "";
  return table[intensity] || table.medium || "";
}

export function applyElevenV3AudioTags(
  text,
  { voiceEmotion, voiceIntensity, voicePreset } = {},
) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  if (/^\[[^\]]+\]/.test(trimmed)) return trimmed;

  const tag = audioTagFromEmotion(voiceEmotion, voiceIntensity, voicePreset);
  if (!tag) return trimmed;
  return `${tag}\n${trimmed}`;
}
