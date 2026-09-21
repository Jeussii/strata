/**
 * Composing an atom, with no Obsidian in sight.
 *
 * Pulled out of the split workspace so it can be run against the real vault
 * outside the app. Everything here is a pure function of its inputs: the file
 * this produces is the file that gets written, so testing it is testing the
 * thing rather than a re-implementation of it.
 */

export interface Original {
  origin: string;
  source: string;
  captured: string;
  topics: string[];
}

export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 8)
      .join("-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/**
 * Body shape follows `origin`, which the schema makes non-optional.
 *
 * An atom split out of a `quote` note is still a quote, so it still has to look
 * like one. Getting this wrong would present a source's words as yours.
 */
export function shape(text: string, origin: string): string {
  const quoted = text
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
  if (origin === "ai-summary") return `> [!ai]\n${quoted}`;
  if (origin === "highlight") return `> [!quote]\n${quoted}`;
  if (origin === "quote") return quoted;
  return text;
}

/** YAML needs quoting whenever a value could be read as something else. */
function scalar(value: string): string {
  return /^[A-Za-z0-9][\w .&/-]*$/.test(value) ? value : JSON.stringify(value);
}

export interface AtomSpec {
  title: string;
  topics: string[];
  horizon: string;
  /** verbatim passage text, already joined if several were merged */
  body: string;
  original: Original;
  /** basename of the `Full/` original this came out of */
  archive: string;
}

export function composeAtom(spec: AtomSpec): string {
  // Enforced where the file is actually made rather than only in the UI that
  // normally prevents it. An atom with nothing to be about is not an atom, and
  // emitting a bare `topics:` key would produce one that parses.
  if (!spec.topics.length) throw new Error(`"${spec.title}" has no topic`);
  const lines = ["---", "type: note", `origin: ${spec.original.origin}`];
  if (spec.horizon) lines.push(`horizon: ${spec.horizon}`);
  lines.push("topics:");
  for (const topic of spec.topics) lines.push(`  - "[[${topic}]]"`);
  if (spec.original.source) lines.push(`source: "[[${spec.original.source}]]"`);
  // The original's date, not today's: the atom records when it was thought, and
  // moving a paragraph between files is not a new thought.
  lines.push(`captured: ${scalar(spec.original.captured)}`);
  lines.push(`full: "[[${spec.archive}]]"`);
  lines.push("---", "");
  return `${lines.join("\n")}${shape(spec.body.trim(), spec.original.origin)}\n`;
}

/** A name no file in the vault is already using. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${base}-${n++}`;
  taken.add(name.toLowerCase());
  return name;
}
