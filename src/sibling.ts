import { App, FileSystemAdapter } from "obsidian";
import { GNode, NodeKind } from "./model";

/**
 * The other vault.
 *
 * Obsidian runs a plugin inside exactly one vault and cannot resolve a wikilink
 * into another, which would make the two-vault split a wall. It isn't one:
 * philosophy ends up inside business decisions constantly, so the graph has to
 * span both even though the stores are separate.
 *
 * So the sibling vault is read straight off disk — frontmatter only, never
 * bodies — and its nodes join the graph as foreign nodes. Edges between the two
 * come from `bridges:` entries, which are plain `<Vault>/<path>` strings
 * precisely because no wikilink could survive the crossing.
 */

export interface Foreign {
  nodes: GNode[];
  /** bridge target key -> node id, for resolving `bridges:` from either side */
  byKey: Map<string, string>;
  /**
   * lowercased basename -> node id, for resolving the other vault's *own*
   * wikilinks. A `for: "[[some-project]]"` in the other vault has to be resolved
   * without Obsidian, which only indexes the vault it has open.
   */
  byName: Map<string, string>;
}

function nodeModule<T>(name: string): T {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (!req) throw new Error(`Strata needs Electron's require to load ${name}`);
  return req(name) as T;
}

/** Just the frontmatter block — bodies are never read across the boundary. */
function frontmatter(head: string): Record<string, string> {
  if (!head.startsWith("---")) return {};
  const end = head.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  let key = "";
  for (const line of head.slice(4, end).split("\n")) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].trim();
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && key) out[key] = out[key] ? `${out[key]}, ${item[1].trim()}` : item[1].trim();
  }
  return out;
}

const strip = (raw: string) => raw.replace(/^["']|["']$/g, "").replace(/^\[\[|\]\]$/g, "").trim();

function kindOf(declared: string, folder: string): NodeKind {
  if (declared === "note" || declared === "topic" || declared === "source" || declared === "session") {
    return declared;
  }
  if (folder === "Notes") return "note";
  if (folder === "Topics") return "topic";
  if (folder === "Sources") return "source";
  if (folder === "Sessions") return "session";
  return "other";
}

/**
 * Find and read the vault next door.
 *
 * The sibling is any directory beside this one that holds markdown — typically
 * both vaults sitting in the same container. Nothing is
 * assumed about its schema beyond `type` and the folder it sits in.
 */
export async function readSibling(app: App): Promise<Foreign> {
  const empty: Foreign = { nodes: [], byKey: new Map(), byName: new Map() };
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return empty;

  let fs: typeof import("node:fs/promises");
  let path: typeof import("node:path");
  try {
    fs = nodeModule<typeof import("node:fs/promises")>("node:fs/promises");
    path = nodeModule<typeof import("node:path")>("node:path");
  } catch {
    return empty;
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
    return empty;
  }

  const nodes: GNode[] = [];
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();

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

        let head: string;
        try {
          const handle = await fs.open(full, "r");
          try {
            const buffer = Buffer.alloc(2048);
            const { bytesRead } = await handle.read(buffer, 0, 2048, 0);
            head = buffer.subarray(0, bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
        } catch {
          continue;
        }

        const fm = frontmatter(head);
        const rel = path.relative(root, full);
        const key = `${vault}/${rel}`;
        const id = `foreign:${key}`;
        nodes.push({
          id,
          label: entry.name.replace(/\.md$/, "").replace(/^note-/, ""),
          kind: kindOf(strip(fm.type ?? ""), path.basename(path.dirname(full))),
          origin: fm.origin ? strip(fm.origin) : undefined,
          horizon: fm.horizon ? strip(fm.horizon) : undefined,
          captured: fm.captured ? strip(fm.captured) : undefined,
          topicPaths: [],
          foreign: vault,
          bridges: (fm.bridges ?? "").split(",").map(strip).filter(Boolean),
          // What this piece of work is for — Work's counterpart to `topics`.
          serves: (fm.for ?? "").split(",").map(strip).filter(Boolean),
        });
        byKey.set(key, id);
        byName.set(entry.name.replace(/\.md$/, "").toLowerCase(), id);
        // Tolerate a bridge written without the .md, which is the mistake a
        // human makes first.
        byKey.set(key.replace(/\.md$/, ""), id);
      }
    };
    await walk(root);
  }

  return { nodes, byKey, byName };
}
