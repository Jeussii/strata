/**
 * Cutting a note into passages.
 *
 * The first version of the index embedded each note as one vector, capped at
 * 2400 characters. Measured against a real vault that threw away **more than
 * half of the text** — one note in it ran to 58,000 characters and the model
 * read the first 2,400 of them. Everything past the cap was invisible, so
 * the semantic layers were quietly biased toward short notes.
 *
 * A passage is also the honest unit for the question being asked. Two long notes
 * are rarely "about the same thing"; one paragraph in each is. Embedding whole
 * notes averages a document's ideas into a single point that sits near
 * everything and means nothing, which is the same reason a long note becomes a
 * hub. Comparing passages instead gives a real answer *and* a quotable reason.
 */

export interface Segment {
  /** heading this passage sits under, for naming it in the UI */
  heading: string;
  /** normalised for the embedder: markdown stripped, whitespace collapsed */
  text: string;
  /**
   * The passage exactly as written, markdown intact.
   *
   * `text` is destroyed on purpose — bullets flattened, emphasis stripped — and
   * that is right for a vector and catastrophic for a file. Splitting a note
   * writes `raw`, so a list stays a list and not one run-on line.
   */
  raw: string;
}

const TARGET = 1100;
const MAX = 1800;
const MIN = 220;
const FLOOR = 60;

/**
 * Strip the YAML block. Frontmatter is schema, not prose.
 *
 * Line endings are normalised first. Notes that came off a Windows machine
 * still carry CRLF, and a stray `\r` is enough to stop a heading regex from
 * matching — which silently costs every passage in them its heading, and
 * under-segments the vault.
 */
export function bodyOf(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end < 0 ? text : text.slice(end + 4);
}

function clean(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[\[([^\]|#]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/[*`_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split on headings first, then paragraphs.
 *
 * A heading is a seam the author declared; splitting anywhere else inside a
 * section would cut an argument in half. Only when a section is still too long
 * does it get packed into paragraph-sized windows, and runts are merged back so
 * a stray line never becomes its own vector.
 */
export function segment(raw: string): Segment[] {
  const body = bodyOf(raw);

  const blocks: { heading: string; line: string; lines: string[] }[] = [];
  let current = { heading: "", line: "", lines: [] as string[] };
  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      if (current.lines.length) blocks.push(current);
      // The heading line is kept verbatim as well as parsed: it is prose someone
      // wrote, so a passage that becomes its own note keeps it.
      current = { heading: h[1].replace(/[*`#]/g, "").trim(), line, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) blocks.push(current);

  const out: Segment[] = [];
  for (const block of blocks) {
    // Two forms of every paragraph, carried together.
    //
    // `text` is trimmed because the embedder does not care about indentation.
    // `raw` must not be: four leading spaces are what make a nested list item
    // nested, and trimming them turned an indented block under `- Prompt` into
    // a sibling paragraph. Passages were being rewritten that way, and
    // splitting a note wrote the damaged version to disk.
    const paras = block.lines
      .join("\n")
      .split(/\n\s*\n/)
      .map((p) => ({ text: p.trim(), raw: p.replace(/^\n+/, "").replace(/\s+$/, "") }))
      .filter((p) => p.text);

    let buffer = { text: "", raw: "" };
    let first = true;
    const flush = () => {
      if (buffer.text) {
        // Only the first passage of a section carries its heading; the rest are
        // continuations and would otherwise repeat it.
        const raw = first && block.line ? `${block.line}\n\n${buffer.raw}` : buffer.raw;
        out.push({ heading: block.heading, text: buffer.text, raw });
        first = false;
      }
      buffer = { text: "", raw: "" };
    };
    for (const para of paras) {
      if (!buffer.text || buffer.text.length + para.text.length < TARGET) {
        buffer = buffer.text
          ? { text: `${buffer.text}\n\n${para.text}`, raw: `${buffer.raw}\n\n${para.raw}` }
          : { ...para };
        if (buffer.text.length > MAX) flush();
        continue;
      }
      flush();
      buffer = { ...para };
    }
    flush();
  }

  // Merge runts forward, then clean. A two-line fragment carries no meaning on
  // its own and its vector would sit in the middle of the space.
  const merged: Segment[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && seg.text.length < MIN && last.heading === seg.heading) {
      last.text += `\n\n${seg.text}`;
      last.raw += `\n\n${seg.raw}`;
      continue;
    }
    merged.push({ ...seg });
  }

  return merged
    // Leading blank lines go; leading *spaces* stay, for the same reason.
    .map((s) => ({ heading: s.heading, raw: s.raw.replace(/^\n+/, "").replace(/\s+$/, ""), text: clean(s.text) }))
    .filter((s) => s.text.length >= FLOOR);
}

/**
 * Notes that are documents wearing an atom's frontmatter.
 *
 * One idea per atom is the rule, and the vault cannot check it — so nothing
 * has. In a real vault **a handful of the longest notes hold a large share of
 * the text, with a great many headed sections between them.** Those
 * are not atoms, and no amount of embedding fixes a note that is five ideas
 * filed as one; it only makes the note similar to five different things.
 *
 * This is a finding, never an action. Splitting rewrites prose, and prose is
 * the one thing an agent does not get to touch.
 */
export interface Compound {
  sections: number;
  chars: number;
  /** seams the author already marked with an inline `topics:` comment */
  marked: number;
}

export function compound(raw: string, minChars = 2400, minSections = 3): Compound | null {
  const body = bodyOf(raw);
  const sections = (body.match(/^##\s+\S/gm) ?? []).length;
  if (body.length < minChars || sections < minSections) return null;
  return {
    sections,
    chars: body.length,
    marked: (body.match(/<!--\s*topics:/g) ?? []).length,
  };
}
