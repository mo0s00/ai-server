import assert from "node:assert/strict";
import test from "node:test";
import { buildStoryArtDirection, resolveStoryArtPreset, STORY_ART_PRESETS } from "../story-image-art-style.js";

test("all four styles are distinct and illustrated", () => {
  assert.equal(Object.keys(STORY_ART_PRESETS).length, 4);
  assert.equal(new Set(Object.values(STORY_ART_PRESETS)).size, 4);
  for (const id of Object.keys(STORY_ART_PRESETS)) {
    assert.equal(resolveStoryArtPreset("illustration", id), id);
    assert.match(buildStoryArtDirection("illustration", id), /MANDATORY HAND-DRAWN/);
  }
});

test("default, legacy IDs and unknown IDs use coherent hand-drawn art", () => {
  assert.equal(resolveStoryArtPreset(), "classic_webtoon");
  assert.equal(resolveStoryArtPreset("illustration", "webluna"), "classic_webtoon");
  assert.equal(resolveStoryArtPreset("illustration", "comic"), "bold_comic");
  assert.equal(resolveStoryArtPreset("illustration", "unexpected"), "classic_webtoon");
});

test("intentional photo selections are not silently overridden", () => {
  assert.equal(resolveStoryArtPreset("photo", "classic_webtoon"), null);
  assert.equal(buildStoryArtDirection("photo", "classic_webtoon"), "");
});
