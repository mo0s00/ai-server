/** Sonnet acting direction → Eleven v3 whitelisted Audio Tags. */

import {
  normalizeVoiceEmotion,
  normalizeVoiceIntensity,
} from "./elevenlabs-emotion-presets.js";

const ALLOWED_TAG_CONTENT = new Set([
  "angry",
  "angrily, trying to stay calm",
  "angrily, fed up",
  "annoyed",
  "anxiously",
  "breathes",
  "chuckles",
  "coldly",
  "crying",
  "deliberate",
  "drawn out",
  "excited",
  "fearful",
  "frustrated",
  "furious",
  "gasps",
  "gulps",
  "happy",
  "harshly",
  "hesitant",
  "laughs softly",
  "menacingly",
  "menacingly, slow",
  "nervous",
  "nervously",
  "panicked",
  "panicking",
  "pause",
  "quietly",
  "quietly, fearful",
  "quietly, holding back anger",
  "quietly, sad",
  "rushed",
  "sad",
  "sarcastically",
  "shouting",
  "sighs",
  "softly, happy",
  "suspicious tone",
  "threatening",
  "tired",
  "timidly",
  "trying to stay calm",
  "under his breath",
  "whispers",
]);

/** @type {Record<string, Record<string, string>>} */
const EMOTION_INTENSITY = {
  calm: { low: "", medium: "", high: "" },
  happy: {
    low: "softly, happy",
    medium: "happy",
    high: "excited",
  },
  sad: {
    low: "quietly, sad",
    medium: "sad",
    high: "crying",
  },
  tense: {
    low: "quietly",
    medium: "nervously",
    high: "anxiously",
  },
  frightened: {
    low: "quietly, fearful",
    medium: "fearful",
    high: "panicked",
  },
  angry: {
    low: "quietly, holding back anger",
    medium: "angry",
    high: "furious",
  },
  irritated: {
    low: "annoyed",
    medium: "annoyed",
    high: "frustrated",
  },
  cold: {
    low: "coldly",
    medium: "coldly",
    high: "harshly",
  },
  threatening: {
    low: "menacingly",
    medium: "threatening",
    high: "menacingly, slow",
  },
  whisper: {
    low: "whispers",
    medium: "whispers",
    high: "whispers",
  },
  suspicious: {
    low: "suspicious tone",
    medium: "suspicious tone",
    high: "suspicious tone",
  },
};

/** @type {Record<string, string>} */
const DELIVERY = {
  none: "",
  neutral: "",
  under_breath: "quietly",
  restrained: "trying to stay calm",
  weary: "tired",
  sarcastic: "sarcastically",
  panicked: "panicking",
  cold: "coldly",
  hesitant: "hesitant",
  emphatic: "deliberate",
  timid: "timidly",
  menacing: "menacingly",
  flustered: "nervous",
};

/** @type {Record<string, string>} */
const PACE = {
  slow: "deliberate",
  normal: "",
  fast: "rushed",
  drawn_out: "drawn out",
};

/** @type {Record<string, string>} */
const REACTION = {
  none: "",
  sigh: "sighs",
  gasp: "gasps",
  gulp: "gulps",
  laugh: "laughs softly",
  chuckle: "chuckles",
  breath: "breathes",
  pause: "pause",
};

/** emotion+delivery 조합 — 한 bracket에 묶는다. */
const COMPOUND_EMOTION_DELIVERY = {
  "angry:restrained": "angrily, trying to stay calm",
  "angry:weary": "angrily, fed up",
  "irritated:sarcastic": "sarcastically",
};

const DELIVERY_ALIASES = {
  underbreath: "under_breath",
  under_breath: "under_breath",
  "under-his-breath": "under_breath",
  restrained: "restrained",
  weary: "weary",
  tired: "weary",
  sarcastic: "sarcastic",
  sarcastically: "sarcastic",
  panicked: "panicked",
  panicking: "panicked",
  cold: "cold",
  coldly: "cold",
  hesitant: "hesitant",
  emphatic: "emphatic",
  timid: "timid",
  timidly: "timid",
  menacing: "menacing",
  menacingly: "menacing",
  flustered: "flustered",
  neutral: "neutral",
  none: "none",
};

const PACE_ALIASES = {
  slow: "slow",
  slowly: "slow",
  deliberate: "slow",
  normal: "normal",
  medium: "normal",
  fast: "fast",
  rushed: "fast",
  rapid: "fast",
  drawn_out: "drawn_out",
  "drawn-out": "drawn_out",
};

const REACTION_ALIASES = {
  none: "none",
  sigh: "sigh",
  sighs: "sigh",
  gasp: "gasp",
  gasps: "gasp",
  gulp: "gulp",
  gulps: "gulp",
  laugh: "laugh",
  laughs: "laugh",
  chuckle: "chuckle",
  chuckles: "chuckle",
  breath: "breath",
  breathes: "breath",
  pause: "pause",
};

export function isElevenV3Model(modelId) {
  return /eleven_v3/i.test(String(modelId || "").trim());
}

export function normalizeVoiceDelivery(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!v) return "none";
  return DELIVERY_ALIASES[v] || (Object.hasOwn(DELIVERY, v) ? v : "none");
}

export function normalizeVoicePace(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!v) return "normal";
  return PACE_ALIASES[v] || (Object.hasOwn(PACE, v) ? v : "normal");
}

export function normalizeVoiceReaction(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!v) return "none";
  return REACTION_ALIASES[v] || (Object.hasOwn(REACTION, v) ? v : "none");
}

function whitelistTag(content) {
  const t = String(content || "").trim();
  if (!t || !ALLOWED_TAG_CONTENT.has(t)) return "";
  return t;
}

function bracket(content) {
  const t = whitelistTag(content);
  return t ? `[${t}]` : "";
}

/**
 * @returns {{ tags: string[], tagString: string }}
 */
export function buildActingAudioTags({
  voiceEmotion,
  voiceIntensity,
  voiceDelivery,
  voicePace,
  voiceReaction,
  voicePreset,
} = {}) {
  const emotion = normalizeVoiceEmotion(voiceEmotion || voicePreset);
  const intensity = normalizeVoiceIntensity(voiceIntensity);
  const delivery = normalizeVoiceDelivery(voiceDelivery);
  const pace = normalizeVoicePace(voicePace);
  const reaction = normalizeVoiceReaction(voiceReaction);

  const tags = [];

  const reactionTag = REACTION[reaction];
  if (reactionTag) tags.push(reactionTag);

  const compound = COMPOUND_EMOTION_DELIVERY[`${emotion}:${delivery}`];
  if (compound) {
    tags.push(compound);
  } else {
    const emotionTag =
      EMOTION_INTENSITY[emotion]?.[intensity] ||
      EMOTION_INTENSITY[emotion]?.medium ||
      "";
    if (emotionTag) tags.push(emotionTag);
    const deliveryTag = DELIVERY[delivery];
    if (deliveryTag && deliveryTag !== emotionTag) tags.push(deliveryTag);
  }

  const paceTag = PACE[pace];
  if (paceTag) tags.push(paceTag);

  const whitelisted = tags.map(whitelistTag).filter(Boolean);
  return {
    tags: whitelisted,
    tagString: whitelisted.map((t) => `[${t}]`).join(""),
  };
}

export function applyElevenV3AudioTags(
  text,
  acting = {},
) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { text: trimmed, ...buildActingAudioTags(acting) };
  if (/^\[[^\]]+\]/.test(trimmed)) {
    return { text: trimmed, tags: [], tagString: "" };
  }

  const built = buildActingAudioTags(acting);
  if (!built.tagString) return { text: trimmed, ...built };
  return {
    text: `${built.tagString}\n${trimmed}`,
    ...built,
  };
}
