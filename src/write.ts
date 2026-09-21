import { App, TFile } from "obsidian";

/**
 * The only two ways anything in Strata changes a note.
 *
 * Both are additive and both are visible. Nothing here rewrites a sentence,
 * reorders a paragraph, or deletes a line — append-never-rewrite survives
 * contact with automation only because the automation is this small.
 */

const ADDED = "## Added";
const RELATED = "## Related";

/**
 * A note's name is not a regular expression.
 *
 * `note-c++ (draft)` compiled to `\[\[note-c++ (draft)[\]|#]` and threw
 * "Nothing to repeat" — so a single plus sign in a filename crashed the button
 * rather than linking anything.
 */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `2026-01-31` — the vault writes dates one way everywhere. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Grow a note by a dated entry.
 *
 * `vault.process` reads and writes in one atomic step, so a note open in another
 * pane cannot lose the addition to a stale read.
 */
export async function appendTo(app: App, file: TFile, text: string): Promise<void> {
  const entry = `*${today()}* — ${text.trim()}`;
  await app.vault.process(file, (data) => {
    const trimmed = data.replace(/\s*$/, "");
    return trimmed.includes(ADDED)
      ? `${trimmed}\n\n${entry}\n`
      : `${trimmed}\n\n${ADDED}\n\n${entry}\n`;
  });
}

/**
 * Write a wikilink under a Related heading.
 *
 * Returns false when the link is already there, so a caller can say "already
 * linked" instead of silently doing nothing and looking broken.
 */
export async function linkTo(app: App, fromPath: string, toPath: string): Promise<boolean> {
  const from = app.vault.getAbstractFileByPath(fromPath);
  const to = app.vault.getAbstractFileByPath(toPath);
  if (!(from instanceof TFile) || !(to instanceof TFile)) return false;

  let written = false;
  await app.vault.process(from, (data) => {
    if (new RegExp(`\\[\\[${literal(to.basename)}[\\]|#]`).test(data)) return data;
    written = true;
    const line = `- [[${to.basename}]]`;
    const trimmed = data.replace(/\s*$/, "");
    return new RegExp(`\\n${RELATED}\\s*\\n`).test(trimmed)
      ? trimmed.replace(new RegExp(`\\n${RELATED}\\s*\\n`), `\n${RELATED}\n${line}\n`)
      : `${trimmed}\n\n${RELATED}\n${line}\n`;
  });
  return written;
}

/**
 * Write a bridge into a note's frontmatter.
 *
 * The other half of "link these two". Obsidian cannot resolve a wikilink into
 * a second vault, so a link that crosses is a plain `<Vault>/<path>` string in
 * `bridges:` — which means it is frontmatter rather than body text, and a
 * different write from `linkTo` even though it is the same gesture.
 *
 * Only ever written on this vault's side. The spec says a bridge is symmetric
 * in meaning but written once, on whichever side you were editing, and that is
 * the line that makes this safe: Strata reads the Work vault off disk and has
 * no business writing to a vault Obsidian has not opened.
 */
export async function bridgeTo(app: App, fromPath: string, ref: string): Promise<boolean> {
  const from = app.vault.getAbstractFileByPath(fromPath);
  if (!(from instanceof TFile)) return false;

  const bare = (value: string) => value.replace(/\.md$/, "");
  let written = false;
  await app.fileManager.processFrontMatter(from, (fm) => {
    const list: string[] = Array.isArray(fm.bridges)
      ? fm.bridges.map(String)
      : typeof fm.bridges === "string" && fm.bridges
        ? [fm.bridges]
        : [];
    if (list.some((existing) => bare(existing) === bare(ref))) return;
    list.push(ref);
    fm.bridges = list;
    written = true;
  });
  return written;
}

/**
 * Merge one note into another, with nothing lost.
 *
 * "Merge" under a vault whose first law is *append, never rewrite* cannot mean
 * "delete the loser". So it does not: the absorbed note's body is appended to
 * the keeper under a dated `## Added` entry that names where it came from, and
 * the absorbed file itself moves into `Vault/Full/` — the folder that already
 * exists for text that is kept but is not a node. The keeper points at it with
 * `full:`, and Obsidian repoints every inbound link on the way. Nothing is
 * deleted at any point.
 *
 * The result: one node instead of two, no prose rewritten, no file deleted, and
 * an audit trail readable without leaving Obsidian.
 */
export async function mergeInto(app: App, keepPath: string, absorbPath: string): Promise<number> {
  const keep = app.vault.getAbstractFileByPath(keepPath);
  const absorb = app.vault.getAbstractFileByPath(absorbPath);
  if (!(keep instanceof TFile) || !(absorb instanceof TFile)) {
    throw new Error("one of these notes no longer exists");
  }

  const raw = await app.vault.read(absorb);
  const body = raw.replace(/\r\n?/g, "\n");
  const stripped = body.startsWith("---")
    ? body.slice(body.indexOf("\n---", 3) + 4).trim()
    : body.trim();

  const name = absorb.basename;
  await appendTo(app, keep, `absorbed from [[${name}]]\n\n${stripped}`);

  // Anything that pointed at the absorbed note now points at the keeper.
  //
  // Obsidian repoints links on a rename, which is the wrong answer here: the
  // basename does not change, so every referrer quietly followed the note into
  // `Full/` — and an archive is not a node, so those edges vanished from the
  // graph while still looking fine in the editor. The content moved to the
  // keeper, so the links belong on the keeper. Wiring is an index, not a claim,
  // which is the one thing the vault's laws allow to be corrected.
  const repointed = await repoint(app, absorb, keep);

  if (!app.vault.getAbstractFileByPath("Full")) await app.vault.createFolder("Full");
  let archive = `Full/${name}.md`;
  let n = 2;
  while (app.vault.getAbstractFileByPath(archive)) archive = `Full/${name}-${n++}.md`;
  await app.fileManager.renameFile(absorb, archive);

  const moved = app.vault.getAbstractFileByPath(archive);
  if (moved instanceof TFile) {
    // An archive is not a node: it keeps its provenance and loses its wiring.
    await app.fileManager.processFrontMatter(moved, (fm) => {
      fm.type = "full";
      for (const key of ["topics", "origin", "horizon", "bridges", "full"]) delete fm[key];
    });
  }

  await app.fileManager.processFrontMatter(keep, (fm) => {
    // Never overwrite one. `full:` names the original a note was drawn from, and
    // a keeper that already had one would lose the pointer to its real source in
    // exchange for a pointer to the note it just ate. The `## Added` entry names
    // the archive either way, so nothing is unrecoverable.
    if (!fm.full) fm.full = `[[${moved instanceof TFile ? moved.basename : name}]]`;
  });

  return repointed;
}

/**
 * Rewrite `[[from]]` to `[[to]]`, keeping any alias or heading intact.
 *
 * Which files to touch comes from the link index rather than from reading the
 * vault: `vault.process` writes whatever the callback returns, so walking every
 * note and returning it unchanged would rewrite all of them — new mtimes, a
 * full re-index and a sync storm, to change two files.
 */
async function repoint(app: App, from: TFile, to: TFile): Promise<number> {
  const referrers = Object.entries(app.metadataCache.resolvedLinks)
    .filter(([path, targets]) => path !== from.path && path !== to.path && from.path in targets)
    .map(([path]) => path);
  if (!referrers.length) return 0;

  const pattern = new RegExp(`\\[\\[${literal(from.basename)}((?:\\||#)[^\\]]*)?\\]\\]`, "g");
  let count = 0;
  for (const path of referrers) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    await app.vault.process(file, (data) => {
      pattern.lastIndex = 0;
      return data.replace(pattern, (_m, tail: string | undefined) => `[[${to.basename}${tail ?? ""}]]`);
    });
    count++;
  }
  return count;
}
