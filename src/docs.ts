import { App, FileSystemAdapter, TFile } from "obsidian";
import { SessionMeta, readable } from "./sessions";

/**
 * Something worth embedding, wherever it lives.
 *
 * The indexer used to take a `TFile`, which quietly meant "only this vault" —
 * and so the semantic layers stopped at the vault boundary. Work entries were
 * drawn on the canvas as foreign nodes and were invisible to Echo and
 * Resonance, which is the half of Strata that does the connecting. A business
 * decision could not rhyme with the value it rests on, because only one of them
 * was in the space.
 *
 * A `Doc` is the smallest thing the indexer actually needs: an identity, a
 * title, a modification time, and a way to get the text. Vault notes make one
 * out of `TFile`; the sibling vault makes one out of a path on disk. Session
 * transcripts will make one out of a `.jsonl` and a turn extractor without this
 * file changing again, which is the point of doing it now.
 */
export interface Doc {
  /** Index key. Vault paths stay bare; anything else is prefixed by its store. */
  key: string;
  /** For the embedding prompt — a passage keeps some of its origin that way. */
  title: string;
  mtime: number;
  read(): Promise<string>;
}

function nodeModule<T>(name: string): T {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (!req) throw new Error(`Strata needs Electron's require to load ${name}`);
  return req(name) as T;
}

const niceTitle = (base: string) => base.replace(/^note-/, "").replace(/-/g, " ");

/** A note in this vault, read through Obsidian's cache. */
export function vaultDoc(app: App, file: TFile): Doc {
  return {
    key: file.path,
    title: niceTitle(file.basename),
    mtime: file.stat.mtime,
    read: () => app.vault.cachedRead(file),
  };
}

/**
 * Every markdown file in the sibling vault, as Docs.
 *
 * Keyed `<vault>/<relative path>` so an index entry says which store it came from
 * and can never collide with a vault path. Bodies *are* read here, unlike in
 * `sibling.ts` which only ever wanted frontmatter — the whole point is to put
 * the prose into the same vector space as the notes.
 *
 * Obsidian fires no events for files it does not own, so changes over here are
 * noticed on a sweep (startup, or Re-read) rather than on save. That is honest
 * rather than ideal: watching a second tree would mean a file watcher whose
 * failure mode is a silently stale index.
 */
export async function siblingDocs(app: App): Promise<Doc[]> {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return [];

  let fs: typeof import("node:fs/promises");
  let path: typeof import("node:path");
  try {
    fs = nodeModule<typeof import("node:fs/promises")>("node:fs/promises");
    path = nodeModule<typeof import("node:path")>("node:path");
  } catch {
    return [];
  }

  const here = adapter.getBasePath();
  const container = path.dirname(here);
  const mine = path.basename(here);

  let siblings: string[];
  try {
    siblings = (await fs.readdir(container, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== mine && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }

  const docs: Doc[] = [];
  for (const vault of siblings) {
    const root = path.join(container, vault);
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        // Containers and paperwork, not thinking. Projects and courses are
        // status and dates; Admin and the vault map are the schema describing
        // the store rather than anything held in it. Same reasoning that keeps
        // Topics and Sources out — a spec that matches every query about the
        // vault crowds out the notes actually being asked for.
        if (rel.startsWith("Projects/") || rel.startsWith("Courses/")) continue;
        if (rel.startsWith("Admin/") || rel === "VAULT-MAP.md") continue;
        let stat: import("node:fs").Stats;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        docs.push({
          key: `${vault}/${rel}`,
          title: niceTitle(entry.name.replace(/\.md$/, "")),
          mtime: stat.mtimeMs,
          read: () => fs.readFile(full, "utf8"),
        });
      }
    };
    await walk(root);
  }
  return docs;
}

/**
 * Linked sessions, as Docs.
 *
 * Only the ones you picked — nothing here discovers a transcript, and the rest
 * of the machine stays out until you say otherwise. Keyed `session:<id>` so the
 * index can tell a conversation from a note at a glance.
 *
 * `read()` renders the readable conversation on demand rather than caching it,
 * which is what makes a session node *live*: the transcript grows as you keep
 * talking, the mtime moves, `stale()` notices, and the turns that were added
 * get embedded. A snapshot would have needed a refresh mechanism; this needs
 * none.
 */
export function sessionDocs(sessions: SessionMeta[]): Doc[] {
  let fs: typeof import("node:fs");
  try {
    fs = nodeModule<typeof import("node:fs")>("node:fs");
  } catch {
    return [];
  }
  const docs: Doc[] = [];
  for (const session of sessions) {
    let mtime: number;
    try {
      mtime = fs.statSync(session.file).mtimeMs;
    } catch {
      continue; // transcript moved or deleted; the node stays, the text does not
    }
    // Memoised per Doc, because one sweep reads each twice: `stale()` reads to
    // hash the content, then `ingest` reads to segment it. On a large
    // transcript that is twice the I/O and two full renders to answer one
    // question about whether anything changed.
    let rendered: string | null = null;
    docs.push({
      key: `session:${session.id}`,
      title: session.title,
      mtime,
      read: async () => {
        if (rendered === null) {
          rendered = readable(await fs.promises.readFile(session.file, "utf8")).text;
        }
        return rendered;
      },
    });
  }
  return docs;
}
