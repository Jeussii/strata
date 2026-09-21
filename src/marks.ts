import { Provider } from "./sessions";

/**
 * Provider marks.
 *
 * A session node needs to say which assistant it was without a label, because
 * labels are earned here and a diamond alone says nothing. These are simple
 * geometric glyphs drawn inline as data URIs — no network, no bundled assets,
 * and they inherit the node's own colour behind them.
 */

/**
 * Claude's mark is a sunburst: many slim rays with blunt ends, radiating from a
 * small hub, alternating slightly in length.
 *
 * The first attempt at this used eight fat rays that came to a point, and that
 * is a *star* — which is precisely the shape that made a session node look like
 * a flag rather than a logo. Twelve thin rays with squared-off tips read as a
 * burst instead, and hold up at 12px where a star just becomes a blob.
 *
 * A family resemblance drawn from primitives, not a copy of the trademark file.
 *
 * The rays stop at r=9.5 in a 24 box, so there is real padding inside the
 * viewBox. That matters: the glyph is centred by `background-fit: contain`,
 * and without the inset it would touch the rim of a 22px node.
 */
const CLAUDE_BURST =
  '<polygon points="12.42,10.50 13.05,2.50 10.95,2.50 11.58,10.50"/><polygon points="13.08,10.89 16.75,5.62 15.15,4.70 12.42,10.51"/><polygon points="13.51,11.61 20.75,8.16 19.70,6.34 13.09,10.89"/><polygon points="13.50,12.38 19.90,12.92 19.90,11.08 13.50,11.62"/><polygon points="13.09,13.11 19.70,17.66 20.75,15.84 13.51,12.39"/><polygon points="12.42,13.49 15.15,19.30 16.75,18.38 13.08,13.11"/><polygon points="11.58,13.50 10.95,21.50 13.05,21.50 12.42,13.50"/><polygon points="10.92,13.11 7.25,18.38 8.85,19.30 11.58,13.49"/><polygon points="10.49,12.39 3.25,15.84 4.30,17.66 10.91,13.11"/><polygon points="10.50,11.62 4.10,11.08 4.10,12.92 10.50,12.38"/><polygon points="10.91,10.89 4.30,6.34 3.25,8.16 10.49,11.61"/><polygon points="11.58,10.51 8.85,4.70 7.25,5.62 10.92,10.89"/><circle cx="12" cy="12" r="1.9"/>';

const SVG: Record<Provider, string> = {
  claude: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="#fff">${CLAUDE_BURST}</g></svg>`,
  // A four-pointed sparkle, in the family of Gemini's.
  gemini: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 30 30"><path fill="#fff" d="M12 1.5c.9 5.2 4.4 8.7 9.6 9.6v1.8c-5.2.9-8.7 4.4-9.6 9.6h-1.8C9.3 17.3 5.8 13.8.6 12.9v-1.8c5.2-.9 8.7-4.4 9.6-9.6z"/></svg>`,
  // A knot, in the family of ChatGPT's.
  chatgpt: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3.4 -3.4 30.8 30.8"><g fill="none" stroke="#fff" stroke-width="2.2"><circle cx="12" cy="12" r="7.6"/><path d="M12 4.4v15.2M4.4 12h15.2"/></g></svg>`,
};

export const PROVIDER_COLOURS: Record<Provider, string> = {
  chatgpt: "#4f9d80",
  claude: "#c8703f",
  gemini: "#5c7fc4",
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude Code",
  gemini: "Gemini",
};

export function providerMark(provider: Provider): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(SVG[provider])}`;
}
