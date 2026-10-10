// Distinct ink-and-paint directions shared by story covers, scenes and character cuts.
// Keep this independent of Express so it can be checked without API credentials.
export const STORY_ART_PRESETS = Object.freeze({
  bold_comic:
    "Bold hand-inked comics: heavy expressive black outer contours, confident uneven brush pressure, intentionally simplified shapes, flat saturated colors, two-tone cel shadows, bold eyes and readable acting.",
  classic_webtoon:
    "Traditional hand-drawn Korean webtoon: clearly defined varied-width ink contours, confident face construction, clean flat color regions, two or three distinct shadow values, restrained hand-painted highlights and readable character acting.",
  detailed_webtoon:
    "Delicate hand-illustrated webtoon: tapered precise ink lines, selectively detailed hair and cloth folds, subtle cross-hatching, layered but restrained comic-color shading, crisp facial features and expressive eyes.",
  gekiga:
    "Gekiga graphic-novel ink art: striking black brush strokes, textured hatching, solid deep shadow shapes, angular expressive faces, intentionally gritty drawing marks, muted flat colors and dramatic 2D contrast.",
});

const ALIASES = Object.freeze({
  webluna: "classic_webtoon",
  comic: "bold_comic",
  toonelle: "bold_comic",
  webtoon: "classic_webtoon",
  ink_comic: "bold_comic",
  dramatic_gekiga: "gekiga",
});

export function resolveStoryArtPreset(styleType = "", stylePreset = "") {
  if (String(styleType).trim().toLowerCase() === "photo") return null;
  const id = String(stylePreset || "").trim().toLowerCase();
  const key = ALIASES[id] || id;
  return Object.prototype.hasOwnProperty.call(STORY_ART_PRESETS, key)
    ? key
    : "classic_webtoon";
}

export function buildStoryArtDirection(styleType = "", stylePreset = "") {
  const key = resolveStoryArtPreset(styleType, stylePreset);
  if (!key) return "";
  return `MANDATORY HAND-DRAWN ART DIRECTION (highest priority over genre/cinematic descriptions):
${STORY_ART_PRESETS[key]}
Render unmistakably as a 2D manually inked and colored comic panel. Outer contour and inner detail lines must be visible, with varied human pen pressure. Show intentional artist decisions rather than polished digital rendering.
Avoid photorealistic skin, photo textures, 3D rendering, glossy CGI, luminous bloom, lens effects, cinematic color grading, overly smooth airbrushed gradients, plastic faces, and generic AI-art sheen.
Keep the same character identity and proportions from registered references, translating the rendering to this selected comic medium. Preserve original clothing and identifiable silhouette. Do not draw speech balloons, text or UI in the generated image.
Art-style ID: ${key}.`;
}
