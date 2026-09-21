import { App, TFile } from "obsidian";

/** The kinds of node the vault schema knows about. */
export type NodeKind = "note" | "topic" | "source" | "session" | "other";

/**
 * An edge layer. The whole point of Strata: an edge is never just "A links to B",
 * it always belongs to exactly one of these, and each can be shown or hidden
 * independently. Obsidian's graph collapses all four into one line, which is why
 * it looks like spaghetti.
 */
export type LayerId =
  | "topics"
  | "source"
  | "hierarchy"
  | "links"
  | "serves"
  | "sessions"
  | "suggested"
  | "bridges"
  | "resonance"
  | "echo";

export const LAYERS: { id: LayerId; label: string; hint: string }[] = [
  { id: "topics", label: "Topics", hint: "note to what it is about (frontmatter `topics`)" },
  { id: "source", label: "Sources", hint: "note to where it came from (frontmatter `source`)" },
  { id: "hierarchy", label: "Hierarchy", hint: "topic to its parent (frontmatter `up`)" },
  {
    id: "serves",
    label: "Serves",
    hint: "inside Work: an entry to the project or course it is for (frontmatter `for`). The counterpart of `topics` in the knowledge vault — that one asks what a note is *about*, this one asks what a piece of work is *for*.",
  },
  { id: "links", label: "Links", hint: "wikilinks written in note bodies" },
  { id: "sessions", label: "Sessions", hint: "AI conversations, joined to the notes they produced. Claude Code sessions are read off disk; Gemini and ChatGPT are added by hand, because their transcripts are not on this machine." },
  {
    id: "bridges",
    label: "Bridges",
    hint: "links that cross between the knowledge vault and Work. Written as plain `<Vault>/<path>` strings, because no wikilink survives the crossing.",
  },
  {
    id: "suggested",
    label: "Suggested",
    hint: "two notes that share topics but have never been linked. Pure set arithmetic, no AI: these are the links the vault is missing.",
  },
  {
    id: "resonance",
    label: "Resonance",
    hint: "notes that say related things without sharing a topic. Read by the local model, and the only layer here that finds what the schema cannot.",
  },
  {
    id: "echo",
    label: "Echo",
    hint: "notes that are near-identical. You wrote this twice — merge them, or link them and keep both on purpose.",
  },
];

export interface GNode {
  id: string; // vault path, the stable identity
  label: string;
  kind: NodeKind;
  origin?: string;
  /** `timeless` | `situational` | undefined when it has not been decided yet */
  horizon?: string;
  captured?: string;
  /** paths of the topics this node sits under, for filtering */
  topicPaths: string[];
  /** session nodes only: enough to reopen the conversation */
  session?: { project: string; at: number; provider: "claude" | "gemini" | "chatgpt" };
  /** set when the node lives in the other vault, to the vault's name */
  foreign?: string;
  /** raw `<Vault>/<path>` bridge targets declared in frontmatter */
  bridges?: string[];
  /** foreign nodes only: the raw `for:` wikilink targets, unresolved */
  serves?: string[];
}

/**
 * Two headings are the same heading if they read the same.
 *
 * The segmenter keeps a heading's *text*; Obsidian keeps it as written. A
 * heading written `### **Some Heading**` is stored here as `Some Heading` and
 * indexed there as `**Some Heading**` — passages miss their anchor on exactly
 * that difference. Comparing with the decoration removed lets the two meet.
 */
export function plainHeading(heading: string): string {
  return heading
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The link fragment that will actually resolve, or null if nothing matches.
 *
 * Obsidian's own heading index is the authority — whatever formatting a heading
 * carries, the fragment has to be what Obsidian has. Returning null rather than
 * a guess is deliberate: an unresolvable fragment opens a blank pane, and
 * opening the file at the top is a better answer than that.
 */
export function anchorFor(headings: { heading: string }[], stored: string): string | null {
  const want = plainHeading(stored);
  if (!want) return null;
  const hit = headings.find((h) => plainHeading(h.heading) === want);
  if (!hit) return null;
  // `#` would end the fragment, `|` would start an alias.
  const anchor = hit.heading.replace(/[#|[\]]/g, "").trim();
  return anchor || null;
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  layer: LayerId;
  /** links layer: both notes point at each other */
  mutual?: boolean;
  /** resonance and echo: cosine similarity, kept so the card can show its working */
  similarity?: number;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  /** topic path to display name, for the filter chips */
  topics: Map<string, string>;
  /** topic path to every topic beneath it, so filtering a topic includes its children */
  descendants: Map<string, Set<string>>;
  /** basename to path, for matching file references found outside the vault */
  byName: Map<string, string>;
}

/**
 * Frontmatter link values arrive as `"[[Identity]]"`, sometimes `"[[Identity|alias]]"`,
 * occasionally as a bare string. Return the linkpath, or null if there isn't one.
 */
function linkpath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^\[\[([^\]|#]+)/);
  const target = (m ? m[1] : trimmed).trim();
  return target || null;
}

/** Frontmatter fields that may hold one value or a list of them. */
function asList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(linkpath).filter((s): s is string => !!s);
  const one = linkpath(raw);
  return one ? [one] : [];
}

function inferKind(file: TFile, declared: unknown): NodeKind {
  if (declared === "note" || declared === "topic" || declared === "source") return declared;
  // Fall back to the folder, so a vault that does not set `type` still renders.
  const folder = file.parent?.name ?? "";
  if (folder === "Notes") return "note";
  if (folder === "Topics") return "topic";
  if (folder === "Sources") return "source";
  return "other";
}

/**
 * Two folders that are in the vault but not in the graph.
 *
 * `Full/` is the archive: the unsplit document a set of atoms was drawn from,
 * kept so nothing is lost and kept out because a 30,000-word original would
 * connect to every atom taken from it and drown them.
 *
 * `Inbox/` is the opposite end of the same idea — written but not yet filed.
 * It stays out because an unfiled note has no topics, so it would arrive as an
 * orphan every time and the graph would fill with things that are mid-decision
 * rather than decided.
 */
function isArchive(file: TFile, declared: unknown): boolean {
  const folder = file.parent?.name;
  return declared === "full" || folder === "Full" || folder === "Inbox";
}

/**
 * Read the whole vault into a layered graph.
 *
 * Everything here comes from `metadataCache`, which Obsidian keeps warm, so this
 * is a pass over already-parsed frontmatter rather than a re-read of every file.
 * No AI, no embeddings, no network. This is the "costs nothing" half of the design.
 */
export function buildGraph(app: App): Graph {
  const files = app.vault.getMarkdownFiles();
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const topics = new Map<string, string>();

  // Pass 1: nodes. Needed in full before edges, so link targets can be validated.
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (isArchive(file, fm?.type)) continue;
    const kind = inferKind(file, fm?.type);
    nodes.set(file.path, {
      id: file.path,
      label: file.basename,
      kind,
      origin: typeof fm?.origin === "string" ? fm.origin : undefined,
      horizon: typeof fm?.horizon === "string" ? fm.horizon : undefined,
      captured: fm?.captured ? String(fm.captured) : undefined,
      topicPaths: [],
      bridges: Array.isArray(fm?.bridges)
        ? fm.bridges.map(String)
        : typeof fm?.bridges === "string"
          ? [fm.bridges]
          : [],
    });
    if (kind === "topic") topics.set(file.path, file.basename);
  }

  const resolve = (raw: unknown, from: string): string | null => {
    const p = linkpath(raw);
    if (!p) return null;
    const dest = app.metadataCache.getFirstLinkpathDest(p, from);
    return dest && nodes.has(dest.path) ? dest.path : null;
  };

  // Track which (from, to) pairs the schema already explains, so the `links`
  // layer shows only what was written in a note's body. Obsidian's resolvedLinks
  // counts frontmatter wikilinks too, and without this every topic edge would be
  // drawn twice: once as structure, once as a "link".
  const structural = new Set<string>();
  const pair = (a: string, b: string) => `${a} ${b}`;

  // Pass 2: structural edges, straight from frontmatter.
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const self = nodes.get(file.path);
    if (!self) continue;

    for (const raw of asList(fm.topics)) {
      const target = resolve(raw, file.path);
      if (!target) continue;
      edges.push({ id: `topics:${file.path}>${target}`, source: file.path, target, layer: "topics" });
      structural.add(pair(file.path, target));
      self.topicPaths.push(target);
    }

    for (const raw of asList(fm.source)) {
      const target = resolve(raw, file.path);
      if (!target) continue;
      edges.push({ id: `source:${file.path}>${target}`, source: file.path, target, layer: "source" });
      structural.add(pair(file.path, target));
    }

    // `up` is how a topic names its parent. This is the layer Breadcrumbs reads.
    for (const raw of asList(fm.up)) {
      const target = resolve(raw, file.path);
      if (!target) continue;
      edges.push({ id: `hierarchy:${file.path}>${target}`, source: file.path, target, layer: "hierarchy" });
      structural.add(pair(file.path, target));
    }
  }

  // Pass 3: body wikilinks, minus anything the schema already accounted for.
  //
  // Collapsed to one edge per pair. When two notes link to each other the raw
  // data holds A->B and B->A, and drawing both puts two lines along the same
  // path — the "same link twice" that made the count and the picture disagree.
  // Mutual is a property of the relation, not a second relation.
  const resolved = app.metadataCache.resolvedLinks;
  const drawn = new Map<string, GEdge>();
  for (const [from, targets] of Object.entries(resolved)) {
    if (!nodes.has(from)) continue;
    for (const to of Object.keys(targets)) {
      if (!nodes.has(to) || from === to) continue;
      if (structural.has(pair(from, to))) continue;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      const existing = drawn.get(key);
      if (existing) {
        existing.mutual = true;
        continue;
      }
      drawn.set(key, { id: `links:${key}`, source: from, target: to, layer: "links" });
    }
  }
  edges.push(...drawn.values());

  // Topic descendants, so filtering to a root topic also brings in everything
  // beneath it rather than only what is tagged with the root itself.
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.layer !== "hierarchy") continue;
    const siblings = children.get(edge.target) ?? [];
    siblings.push(edge.source);
    children.set(edge.target, siblings);
  }
  const descendants = new Map<string, Set<string>>();
  for (const topic of topics.keys()) {
    const seen = new Set<string>([topic]);
    const queue = [topic];
    while (queue.length) {
      for (const child of children.get(queue.pop() as string) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    descendants.set(topic, seen);
  }

  const byName = new Map<string, string>();
  for (const file of files) byName.set(file.name, file.path);

  return { nodes: [...nodes.values()], edges, topics, descendants, byName };
}

/**
 * Edges that cross between the two vaults.
 *
 * A bridge is declared once, on whichever side was being edited, as a plain
 * `<Vault>/<path>` string. Both sides are scanned so it does not matter which
 * one carries it, and a target that resolves to nothing is dropped rather than
 * drawn — a dangling bridge is a maintenance finding, not an edge.
 */
/**
 * The Work vault's own spine.
 *
 * Until this existed, Strata drew edges *between* the two vaults and none
 * *inside* the second one — so the sibling rendered as loose dots in the orphan
 * ring, most of them with no edge at all, while nearly all carried a perfectly
 * good `for:` naming the project or course they serve. The structure was in the
 * files the whole time; nothing was reading it.
 *
 * `for` is Work's counterpart to `topics`: the knowledge vault organises by
 * what a note is *about*, Work by what a piece of work is *for*. Same shape,
 * different question, so it gets its own layer rather than being folded into
 * one that would then be lying about which field it came from.
 *
 * `with:` (people) and `about:` are deliberately not drawn. `about:` is plain
 * strings by design — the spec calls them
 * "descriptive, not a hierarchy to maintain", and turning them into nodes
 * would be inventing exactly the hierarchy it says not to.
 */
export function servesEdges(foreign: GNode[], byName: Map<string, string>): GEdge[] {
  const out: GEdge[] = [];
  const seen = new Set<string>();
  for (const node of foreign) {
    for (const raw of node.serves ?? []) {
      const target = byName.get(raw.toLowerCase());
      if (!target || target === node.id) continue;
      const key = node.id < target ? `${node.id}|${target}` : `${target}|${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `serves:${key}`, source: node.id, target, layer: "serves" });
    }
  }
  return out;
}

export function bridgeEdges(
  local: GNode[],
  foreign: GNode[],
  byKey: Map<string, string>,
  localVault: string
): GEdge[] {
  const localKey = new Map<string, string>();
  for (const node of local) {
    localKey.set(`${localVault}/${node.id}`, node.id);
    localKey.set(`${localVault}/${node.id}`.replace(/\.md$/, ""), node.id);
  }

  const out: GEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: `bridges:${key}`, source: from, target: to, layer: "bridges" });
  };

  for (const node of local) {
    for (const raw of node.bridges ?? []) {
      const target = byKey.get(raw) ?? byKey.get(raw.replace(/\.md$/, ""));
      if (target) add(node.id, target);
    }
  }
  for (const node of foreign) {
    for (const raw of node.bridges ?? []) {
      const target = localKey.get(raw) ?? localKey.get(raw.replace(/\.md$/, ""));
      if (target) add(node.id, target);
    }
  }
  return out;
}

/**
 * Links the vault is missing.
 *
 * Two notes that share two or more topics but have never been linked to each
 * other are, by the vault's own schema, about the same things and unaware of one
 * another. That is a maintenance failure the schema can prove without any model
 * being asked an opinion — it is set arithmetic, and it is checkable.
 *
 * This is the first thing here that tells you what to *do* rather than showing
 * you what you have.
 */
export function suggestLinks(graph: Graph, minShared = 2): GEdge[] {
  const linked = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.layer !== "links") continue;
    linked.add(`${edge.source} ${edge.target}`);
    linked.add(`${edge.target} ${edge.source}`);
  }

  const shared = new Map<string, number>();
  const byTopic = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "note") continue;
    for (const topic of node.topicPaths) {
      const group = byTopic.get(topic) ?? [];
      group.push(node.id);
      byTopic.set(topic, group);
    }
  }

  // Grouping by topic first keeps this near-linear in practice: only notes that
  // already share a topic are ever compared.
  for (const group of byTopic.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = group[i] < group[j] ? `${group[i]}\u0000${group[j]}` : `${group[j]}\u0000${group[i]}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }

  const out: GEdge[] = [];
  for (const [key, count] of shared) {
    if (count < minShared) continue;
    const [a, b] = key.split("\u0000");
    if (linked.has(`${a} ${b}`)) continue;
    out.push({ id: `suggested:${a}>${b}`, source: a, target: b, layer: "suggested" });
  }
  return out;
}

/** Counts for the toolbar, so the layer toggles say what they would actually show. */
export function layerCounts(graph: Graph): Record<LayerId, number> {
  const out: Record<LayerId, number> = {
    topics: 0,
    source: 0,
    hierarchy: 0,
    links: 0,
    serves: 0,
    sessions: 0,
    suggested: 0,
    bridges: 0,
    resonance: 0,
    echo: 0,
  };
  for (const e of graph.edges) out[e.layer]++;
  return out;
}

/**
 * The nine layers, grouped by **who asserted the edge**.
 *
 * Nine flat chips made the toolbar a list of implementation details: `hierarchy`
 * and `bridges` are schema mechanics, and a control strip is the wrong place to
 * learn them. The axis that actually matters when looking at a graph is the same
 * one `origin` asks of a note — *whose claim is this?* — applied to edges:
 *
 *   Structure  the frontmatter says so. Derived, not asserted by anyone.
 *   Links      you wrote it, in a note body, on purpose.
 *   Sessions   a conversation touched these notes.
 *   Maybe      the machine proposes it. Nothing has confirmed it yet.
 *
 * That last boundary is the load-bearing one, and the stylesheet already drew
 * it: `suggested`, `resonance` and `echo` are the three layers rendered as
 * broken lines, because they are proposals rather than facts the vault can
 * prove. Grouping some of them under `links` would have put two guesses inside
 * a fact and left the third outside — the reason this cut is by claimant and
 * not by "does it join two notes".
 */
export type LayerGroupId = "structure" | "links" | "sessions" | "maybe";

export const LAYER_GROUPS: {
  id: LayerGroupId;
  label: string;
  hint: string;
  layers: LayerId[];
}[] = [
  {
    id: "structure",
    label: "Structure",
    hint: "what the frontmatter says: topics, source, a topic's parent, what a piece of work serves, and links that cross into Work. Nobody claimed these — they are read off the files.",
    layers: ["topics", "source", "hierarchy", "serves", "bridges"],
  },
  {
    id: "links",
    label: "Links",
    hint: "wikilinks written in note bodies. The only layer here that is a decision rather than a derivation.",
    layers: ["links"],
  },
  {
    id: "sessions",
    label: "Sessions",
    hint: "AI conversations, joined to the notes they produced.",
    layers: ["sessions"],
  },
  {
    id: "maybe",
    label: "Maybe",
    hint: "edges nothing has confirmed: notes that share topics but were never linked, notes that rhyme without sharing a topic, and notes that are near-duplicates. Drawn broken, because that is what they are.",
    layers: ["suggested", "resonance", "echo"],
  },
];

export const GROUP_OF: Record<LayerId, LayerGroupId> = LAYER_GROUPS.reduce((acc, group) => {
  for (const layer of group.layers) acc[layer] = group.id;
  return acc;
}, {} as Record<LayerId, LayerGroupId>);
