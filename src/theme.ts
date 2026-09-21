import { LayerId } from "./model";

/**
 * One palette, deliberately muted.
 *
 * The first version used saturated primaries and read like a default chart
 * library. These are pulled toward each other in saturation and luminance so
 * that no single node shouts, and so the graph reads as one object rather than
 * a scatter of coloured dots. Distinguishability comes from hue separation, not
 * from intensity.
 */

export const LAYER_COLOURS: Record<LayerId, string> = {
  topics: "#6f93bd",
  source: "#77a583",
  hierarchy: "#c2a267",
  links: "#b07ba6",
  serves: "#5f9ea0",
  sessions: "#d08a5c",
  suggested: "#8f959b",
  bridges: "#9b7bc4",
  resonance: "#3fa3a0",
  echo: "#c2506b",
};

/** What each layer's edges actually mean, said in one line for the legend. */
export const LAYER_MEANING: Record<LayerId, string> = {
  topics: "is about",
  source: "came from",
  hierarchy: "sits under",
  links: "refers to",
  serves: "is for",
  sessions: "worked on",
  suggested: "could link to",
  bridges: "reaches across to",
  resonance: "rhymes with",
  echo: "says the same thing as",
};

/**
 * Muted, but not so muted that the distinction dies.
 *
 * The first pass pulled saturation down until five origins read as five shades
 * of grey at node size, which makes the legend a lie. These sit high enough to
 * separate at 10px and far enough apart in hue to survive being small.
 */
export const ORIGIN_COLOURS: Record<string, string> = {
  "my-thought": "#e05a33",
  "my-summary": "#d9a018",
  "ai-summary": "#6b6bd6",
  quote: "#1f9e8c",
  highlight: "#cd57a3",
};

export const ORIGIN_MEANING: Record<string, string> = {
  "my-thought": "your own idea",
  "my-summary": "you condensing a source",
  "ai-summary": "AI condensing something",
  quote: "verbatim from a source",
  highlight: "a passage you marked",
};

export const KIND_COLOURS: Record<string, string> = {
  note: "#d1714f",
  topic: "#6f93bd",
  source: "#77a583",
  session: "#d08a5c",
  other: "#8f959b",
};

export const HORIZON_COLOURS: Record<string, string> = {
  timeless: "#2f8fb5",
  situational: "#d98324",
};

/** A node kind, said the way the key says everything else — in words. */
export const KIND_LABEL: Record<string, string> = {
  note: "a note",
  topic: "a topic",
  source: "a source",
  session: "a session",
  other: "unfiled",
};

export const HORIZON_MEANING: Record<string, string> = {
  timeless: "still true in ten years",
  situational: "true of a moment",
};

export const NEUTRAL = "#8f959b";

/** Fresher is warmer, and everything past a year settles at the cold end. */
export function recencyColour(captured: string, now: number, dark = false): string {
  const at = Date.parse(captured || "");
  if (Number.isNaN(at)) return dark ? "#9aa0a6" : "#7a7f85";
  const months = (now - at) / (1000 * 60 * 60 * 24 * 30);
  const t = Math.max(0, Math.min(1, months / 12));
  return `hsl(${Math.round(18 + t * 190)}, ${dark ? 46 : 42}%, ${dark ? 66 : 58}%)`;
}

/**
 * The same hue, legible on either ground.
 *
 * These values were picked against a light background. Dropped onto a dark one
 * they sit too close to it — a mid-lightness colour that reads as "muted" on
 * white reads as "nearly invisible" on charcoal. Rather than keep two palettes
 * in sync, the hue is preserved and only lightness and saturation are moved,
 * so the meaning of a colour never depends on the theme.
 */
export function isDark(): boolean {
  return document.body.classList.contains("theme-dark");
}

function toHsl(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

export function tune(hex: string, dark: boolean): string {
  if (!dark) return hex;
  const hsl = toHsl(hex);
  if (!hsl) return hex;
  const [h, s, l] = hsl;
  // Lift toward the light end and take a little saturation off, so a dozen
  // colours stay distinguishable without any of them glowing.
  return `hsl(${Math.round(h)}, ${Math.round(Math.min(s * 0.9, 62))}%, ${Math.round(Math.min(l + 16, 74))}%)`;
}
