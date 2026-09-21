import { App, TFile, normalizePath } from "obsidian";
import type { SemanticIndex, SemanticSettings } from "./semantic";

/**
 * The Inbox: written, not yet filed.
 *
 * Membership is yours and mapping is the system's, so dropping a file in here
 * *is* the decision to keep it — the prose is already what you want, because
 * anything half-formed is still wherever you draft. What is missing is only
 * where it belongs.
 *
 * **Filing is suggested, not decided, and the reason is measured.** Three
 * classifiers were tried — a small local model reading the note, nearest
 * neighbours, and topic centroids — each scored leave-one-out against notes
 * whose topics had already been chosen by hand. The model reading the note was
 * the worst of the three by a distance, and none of them was fit to write
 * frontmatter unattended.
 *
 * **Re-measured, and the first reading of it was half wrong.** That run blamed
 * the taxonomy: a long tail of topics holding only one or two notes each, and
 * near-duplicate branches no classifier could be expected to tell apart. Some
 * of that holds. But two larger causes sat in the harness rather than in the
 * vault:
 *
 *   - The prompt never said how many topics to pick, so the model answered with
 *     five to eight where most notes carry exactly one. Stating the real
 *     distribution improved it measurably, on the same model.
 *   - The prompt offered the root topics too, which almost nothing is filed
 *     under directly, and the small model reached for them constantly.
 *
 * And the retrieval signal is much better than the earlier numbers implied.
 * Leave-one-out over the notes already filed, nearest neighbours voting their
 * own topics: the right topic is top-1 about half the time, and in the top five
 * far more often than that. The taxonomy is learnable. What was failing was the
 * judgement on top of it — handed that shortlist, the small model picked worse
 * than simply taking the top of the list.
 *
 * So the ordering stands, for a better reason than before: **suggestions come
 * from neighbours, not from a model.** A vote cannot invent a topic, and it
 * carries conventions no prompt conveys — that an entry of a given form files
 * under that form rather than under whatever it happens to discuss.
 * A wrong topic is the invisible damage the schema warns about, not a tidy-up.
 *
 * So the split is by what is actually known:
 *
 *   - A file that **already carries topics** was filed deliberately. Moving it is
 *     bookkeeping, and that happens on its own.
 *   - A file with **no frontmatter** gets a ranked shortlist and waits. One
 *     click, no model invoked at the moment of filing, and the judgement stays
 *     where the evidence says it belongs.
 */

export const INBOX = "Inbox";
export const NOTES = "Notes";

/** How many topics to offer. Past three the list stops being a shortlist. */
const SUGGEST = 3;
/** Neighbours consulted per suggestion. */
const NEIGHBOURS = 8;
/** Enough of a note to judge what it is about. */
const JUDGE_CHARS = 2400;

export interface Waiting {
  file: TFile;
  title: string;
  excerpt: string;
  /** Already has frontmatter — filed by hand, nothing to suggest. */
  ready: boolean;
  suggestions: { topic: string; score: number }[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[`*_#>[\]()]/g, "")
    .replace(/[^a-z0-9åäöü]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "untitled";
}

/** The first heading, else the first real line — what the note calls itself. */
export function titleOf(body: string): string {
  for (const line of body.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) return heading[1];
    if (line.trim() && !line.startsWith("---")) return line.trim();
  }
  return "untitled";
}

function hasFrontmatter(raw: string): boolean {
  return raw.startsWith("---\n") && raw.indexOf("\n---\n", 3) > 0;
}

export function inboxFiles(app: App): TFile[] {
  const folder = app.vault.getFolderByPath(normalizePath(INBOX));
  if (!folder) return [];
  return folder.children.filter(
    (child): child is TFile => child instanceof TFile && child.extension === "md"
  );
}

/**
 * What is waiting, and what each one might be about.
 *
 * Suggestions come from the notes already filed: the nearest passages
 * vote for their own topics, weighted by similarity. No topic can be invented
 * this way — the rule that a new topic is proposed and never conjured holds by
 * construction rather than by instruction.
 */
export async function surveyInbox(
  app: App,
  index: SemanticIndex | null,
  settings: SemanticSettings
): Promise<Waiting[]> {
  const out: Waiting[] = [];
  for (const file of inboxFiles(app)) {
    const raw = await app.vault.read(file);
    const ready = hasFrontmatter(raw);
    const item: Waiting = {
      file,
      title: titleOf(raw),
      excerpt: raw.replace(/^---[\s\S]*?\n---\n/, "").trim().slice(0, 220),
      ready,
      suggestions: [],
    };
    if (!ready && index) {
      try {
        item.suggestions = await suggest(app, index, raw.slice(0, JUDGE_CHARS), settings);
      } catch {
        // Ollama down is the normal state of a laptop. The file still lists;
        // it simply lists without advice.
        item.suggestions = [];
      }
    }
    out.push(item);
  }
  return out;
}

async function suggest(
  app: App,
  index: SemanticIndex,
  text: string,
  settings: SemanticSettings
): Promise<{ topic: string; score: number }[]> {
  const near = await index.nearest(text, settings, NEIGHBOURS);
  const votes = new Map<string, number>();
  for (const hit of near) {
    const file = app.vault.getAbstractFileByPath(hit.path);
    if (!(file instanceof TFile)) continue;
    const front = app.metadataCache.getFileCache(file)?.frontmatter;
    const topics = front?.topics;
    const list = Array.isArray(topics) ? topics : topics ? [topics] : [];
    for (const entry of list) {
      const name = String(entry).replace(/^\[\[|\]\]$/g, "").trim();
      if (name) votes.set(name, (votes.get(name) ?? 0) + hit.score);
    }
  }
  return [...votes.entries()]
    .map(([topic, score]) => ({ topic, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SUGGEST);
}

/**
 * Move a file out of the Inbox and into the vault proper.
 *
 * `renameFile` so Obsidian repoints anything already pointing at it, and
 * `processFrontMatter` so the body is never rewritten by hand. Topics are
 * written only when given: filing without them would produce an atom that is
 * about nothing, which the schema forbids.
 */
export async function fileInto(
  app: App,
  file: TFile,
  topics: string[],
  origin = "my-thought"
): Promise<string | null> {
  const raw = await app.vault.read(file);
  const already = hasFrontmatter(raw);
  const base = slugify(already ? file.basename : titleOf(raw));
  const stem = base.startsWith("note-") ? base : `note-${base}`;
  let target = normalizePath(`${NOTES}/${stem}.md`);
  let n = 2;
  while (app.vault.getAbstractFileByPath(target)) {
    target = normalizePath(`${NOTES}/${stem}-${n++}.md`);
  }
  try {
    await app.fileManager.renameFile(file, target);
  } catch {
    return null;
  }
  if (!already) {
    const landed = app.vault.getAbstractFileByPath(target);
    if (landed instanceof TFile) {
      await app.fileManager.processFrontMatter(landed, (fm: Record<string, unknown>) => {
        fm.type = "note";
        fm.origin = origin;
        fm.topics = topics.map((t) => `[[${t}]]`);
        fm.captured = today();
        // `horizon` is deliberately left unset. The schema is explicit that an
        // unset horizon is a visible maintenance item and a guessed one is
        // invisible damage, and nothing here knows which this is.
      });
    }
  }
  return target;
}

/**
 * File everything that needs no judgement.
 *
 * Only files that already carry frontmatter — those are moves, not
 * decisions. Anything unfiled is left alone however confident a suggestion
 * looks, because the measurements say confidence is not warranted.
 */
export async function fileTheObvious(app: App): Promise<string[]> {
  const moved: string[] = [];
  for (const file of inboxFiles(app)) {
    const raw = await app.vault.read(file);
    if (!hasFrontmatter(raw)) continue;
    const to = await fileInto(app, file, []);
    if (to) moved.push(to);
  }
  return moved;
}
