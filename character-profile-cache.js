/** 등장인물 원본·런타임 요약 — 마지막 접근 기준 1시간 sliding TTL.
 *  Anthropic Prompt Cache(LLM 입력 접두어)와는 별개다.
 */
const TTL_MS = 60 * 60 * 1000;

const cache = new Map();

function keyFor(storyId, characterId) {
  return `${String(storyId || "").trim()}::${String(characterId || "").trim()}`;
}

function evictExpired(now = Date.now()) {
  for (const [key, hit] of cache.entries()) {
    if (now - hit.lastAccessMs >= TTL_MS) cache.delete(key);
  }
}

export function primeCharacterProfile({
  storyId,
  characterId,
  runtimeProfile = "",
  fullProfile = null,
}) {
  const sid = String(storyId || "").trim();
  const cid = String(characterId || "").trim();
  if (!sid || !cid) return;
  const runtime = String(runtimeProfile || "").trim();
  cache.set(keyFor(sid, cid), {
    storyId: sid,
    characterId: cid,
    runtimeProfile: runtime,
    fullProfile: fullProfile && typeof fullProfile === "object" ? fullProfile : {},
    lastAccessMs: Date.now(),
  });
}

export function peekCharacterRuntime(storyId, characterId) {
  evictExpired();
  const hit = cache.get(keyFor(storyId, characterId));
  if (!hit) return null;
  hit.lastAccessMs = Date.now();
  return hit.runtimeProfile;
}

export function invalidateCharacterProfile(characterId) {
  const cid = String(characterId || "").trim();
  if (!cid) return;
  for (const [key, hit] of cache.entries()) {
    if (hit.characterId === cid) cache.delete(key);
  }
}

export function primeCharacterProfilesFromBody(body) {
  const storyId = String(body?.story_id || body?.storyId || "").trim();
  const list = body?.character_profiles || body?.characterProfiles;
  if (!storyId || !Array.isArray(list)) return 0;
  let n = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const characterId = String(item.characterId || item.name || "").trim();
    if (!characterId) continue;
    primeCharacterProfile({
      storyId,
      characterId,
      runtimeProfile: item.runtimeProfile || item.runtime_profile || "",
      fullProfile: item.fullProfile || item.full_profile || null,
    });
    n += 1;
  }
  return n;
}
