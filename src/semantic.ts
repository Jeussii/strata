import { App, normalizePath } from "obsidian";
import type { Doc } from "./docs";
import { GEdge, Graph } from "./model";
import { cosine, embed } from "./ollama";
import { Segment, segment } from "./segment";

/**
 * The semantic index.
 *
 * Everything else in Strata is set arithmetic over frontmatter: cheap, exact,
 * and blind to anything you did not already write down. This is the half that
 * reads the prose.
 *
 * Two things come out of it, and they are deliberately different questions:
 *
 *   Echo      — near-identical passages. "You have written this twice." A
 *               finding the schema genuinely cannot make: two notes can say the
 *               same thing under different topics.
 *   Resonance — passages that rhyme across notes that share no topic. The
 *               cross-domain link, the only thing here set arithmetic could
 *               never reach.
 *
 * Two decisions carry the whole design:
 *
 * **Passages, not notes.** Comparing whole notes averaged each document into one
 * point, capped at 2400 characters — which discarded more than half of a real
 * vault's text outright. It also made every long note a hub, because an
 * average sits near
 * everything. Comparing passages fixes the coverage, fixes the hubs, and yields
 * something a whole-note score never could: the actual paragraph to quote back.
 *
 * **Mutual k-nearest-neighbour, not a threshold.** A flat cut produced hundreds
 * of pairs dominated by whichever notes were longest. Requiring each note to
 * sit in the
 * other's top-k makes the relation symmetric and holds the busiest node to k
 * regardless of length.
 */

const CACHE_VERSION = 2;
/**
 * How much of two notes must overlap before they are called the same note.
 * Measured on a real vault: at 0.5 every pair the echo list holds is a genuine
 * duplicate; without it, cross-references get misfiled as duplicates.
 */
const ECHO_COVERAGE = 0.5;
const SEG_CHARS = 1800;
const PREVIEW = 240;
export const BATCH = 8;

export interface SemanticSettings {
  host: string;
  model: string;
  /** how many neighbours each note may claim */
  k: number;
  /** at or above this, two passages are the same passage */
  echoAt: number;
  /** below this, similarity only means both were written in the same language */
  floor: number;
  /** read the vault in the background when nothing else is happening */
  background: boolean;
}

export const DEFAULT_SEMANTIC: SemanticSettings = {
  host: "http://localhost:11434",
  model: "nomic-embed-text",
  k: 4,
  echoAt: 0.88,
  floor: 0.74,
  background: true,
};

interface StoredSegment {
  /** base64 Float32Array */
  v: string;
  /** heading this passage sat under */
  h: string;
  /** enough text to quote back on a card */
  p: string;
}

interface Entry {
  /** mtime, the free staleness check */
  m: number;
  /** content hash, the authoritative one — a touched file is not a changed file */
  c: number;
  segs: StoredSegment[];
}

interface CacheFile {
  version: number;
  model: string;
  entries: Record<string, Entry>;
}

export interface Passage {
  path: string;
  heading: string;
  preview: string;
  score: number;
}

interface Pair {
  score: number;
  ai: number;
  bi: number;
  /** how much of the two notes is shared, not just how alike the best bit is */
  coverage: number;
}

/** One end of a semantic edge, resolved to the paragraph that actually matched. */
export interface Match {
  score: number;
  a: { heading: string; preview: string };
  b: { heading: string; preview: string };
}

// ------------------------------------------------------------------- text

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * `clustering:` is nomic-embed-text's own prefix for symmetric comparison.
 * `search_document` would tilt the space toward query matching, which is not
 * the question being asked. The note title rides along so a passage keeps some
 * of its context when the paragraph alone is ambiguous.
 */
function forEmbedding(title: string, seg: Segment): string {
  const head = seg.heading ? `${title} — ${seg.heading}` : title;
  return `clustering: ${head}. ${seg.text}`.slice(0, SEG_CHARS);
}

// ----------------------------------------------------------------- base64

function toB64(vec: Float32Array): string {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  let s = "";
  // Chunked: String.fromCharCode(...bytes) overflows the stack at 3KB a vector.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ------------------------------------------------------------------ index

export class SemanticIndex {
  private app: App;
  private dir: string;
  private entries = new Map<string, Entry>();
  private vecs = new Map<string, Float32Array[]>();
  private model = "";

  /** Bumped on every mutation, so the edge cache knows when it is stale. */
  private revision = 0;
  /**
   * Keyed by signature, and more than one.
   *
   * This used to be a single slot, which two open views quietly fought over:
   * the graph folds in sessions and the sibling vault, findings does not, so
   * they compute different signatures and each one's write evicted the other's
   * answer. A four-entry map costs nothing and lets both views keep theirs.
   */
  private cache = new Map<string, GEdge[]>();
  /** The most recent answer of any key — shown while a new one is worked out. */
  private last: GEdge[] | null = null;
  /** One build per signature, however many callers ask for it at once. */
  private inflight = new Map<string, Promise<GEdge[]>>();
  private matches = new Map<string, Match>();
  /** Fired when a deferred edge pass lands, so the view can redraw. */
  onEdgesReady: (() => void) | null = null;

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.dir = pluginDir;
  }

  /** Notes covered. Segments are an implementation detail everywhere but here. */
  get size() {
    return this.vecs.size;
  }

  /** Whether an edge pass has actually completed, as opposed to being pending. */
  get hasEdges(): boolean {
    return this.last !== null;
  }

  get segmentCount() {
    let n = 0;
    for (const segs of this.vecs.values()) n += segs.length;
    return n;
  }

  private get path() {
    return normalizePath(`${this.dir}/semantic-index.json`);
  }

  /**
   * Kept out of `data.json` on purpose. Positions and linked sessions are small
   * and worth reading by eye; a few thousand embeddings are neither.
   */
  async load(): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.path))) return;
      const raw = JSON.parse(await this.app.vault.adapter.read(this.path)) as CacheFile;
      // A version bump means the unit changed (notes to passages). Old vectors
      // are not wrong, they answer a different question — so they are dropped.
      if (raw.version !== CACHE_VERSION) {
        await this.app.vault.adapter.remove(this.path);
        return;
      }
      this.model = raw.model;
      for (const [path, entry] of Object.entries(raw.entries ?? {})) {
        this.entries.set(path, entry);
        this.vecs.set(
          path,
          entry.segs.map((s) => fromB64(s.v))
        );
      }
      this.revision++;
    } catch (err) {
      console.error("[strata] could not read the semantic index", err);
    }
  }

  async save(): Promise<void> {
    const file: CacheFile = {
      version: CACHE_VERSION,
      model: this.model,
      entries: Object.fromEntries(this.entries),
    };
    await this.app.vault.adapter.write(this.path, JSON.stringify(file));
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.vecs.clear();
    this.model = "";
    this.revision++;
    this.invalidate();
    if (await this.app.vault.adapter.exists(this.path)) await this.app.vault.adapter.remove(this.path);
  }

  /**
   * Which files the index no longer speaks for.
   *
   * mtime first because it is free; the hash only decides for files whose mtime
   * moved, so re-saving a note without editing it costs nothing. A changed model
   * invalidates everything — vectors from two models do not share a space, and
   * comparing them produces confident nonsense.
   */
  async stale(docs: Doc[], settings: SemanticSettings): Promise<Doc[]> {
    if (this.model && this.model !== settings.model) return docs.slice();
    const out: Doc[] = [];
    for (const doc of docs) {
      const entry = this.entries.get(doc.key);
      if (!entry) {
        out.push(doc);
        continue;
      }
      if (entry.m === doc.mtime) continue;
      const raw = await doc.read();
      if (hash(raw) !== entry.c) out.push(doc);
      else entry.m = doc.mtime; // touched, not changed
    }
    return out;
  }

  /** Drop vectors for notes that no longer exist, so a deleted note stops matching. */
  prune(alive: Set<string>): boolean {
    let dropped = false;
    for (const path of [...this.entries.keys()]) {
      if (alive.has(path)) continue;
      this.entries.delete(path);
      this.vecs.delete(path);
      dropped = true;
    }
    if (dropped) this.revision++;
    return dropped;
  }

  /**
   * Read one file into the index.
   *
   * Deliberately one file at a time: this is what makes background indexing
   * possible. The caller decides how much to do and when to stop, so the work
   * can be spread across idle moments instead of held in one long await that
   * blocks the vault opening.
   */
  async ingest(doc: Doc, settings: SemanticSettings): Promise<number> {
    if (this.model && this.model !== settings.model) {
      this.entries.clear();
      this.vecs.clear();
    }
    this.model = settings.model;

    const raw = await doc.read();
    const segs = segment(raw);
    if (!segs.length) {
      // A stub is all title and no thought. Recorded as empty so it is not
      // retried on every pass.
      this.entries.set(doc.key, { m: doc.mtime, c: hash(raw), segs: [] });
      this.vecs.delete(doc.key);
      this.revision++;
      return 0;
    }

    const title = doc.title;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < segs.length; i += BATCH) {
      const slice = segs.slice(i, i + BATCH);
      vectors.push(...(await embed(settings.host, settings.model, slice.map((s) => forEmbedding(title, s)))));
    }

    this.entries.set(doc.key, {
      m: doc.mtime,
      c: hash(raw),
      segs: segs.map((s, i) => ({ v: toB64(vectors[i]), h: s.heading, p: s.text.slice(0, PREVIEW) })),
    });
    this.vecs.set(doc.key, vectors);
    this.revision++;
    this.invalidate();
    return segs.length;
  }

  // ------------------------------------------------------------- retrieval

  /**
   * The passages nearest to a piece of text.
   *
   * This is what capture asks before writing anything: not "is this note
   * similar to that one" but "have I already said this". One embedding call,
   * then a scan — the index is already in memory.
   */
  async nearest(text: string, settings: SemanticSettings, limit = 5): Promise<Passage[]> {
    const [query] = await embed(settings.host, settings.model, [`clustering: ${text}`.slice(0, SEG_CHARS)]);
    const hits: Passage[] = [];
    for (const [path, segs] of this.vecs) {
      const meta = this.entries.get(path)?.segs ?? [];
      let best = -1;
      let at = 0;
      for (let i = 0; i < segs.length; i++) {
        const s = cosine(query, segs[i]);
        if (s > best) {
          best = s;
          at = i;
        }
      }
      if (best < 0) continue;
      hits.push({ path, heading: meta[at]?.h ?? "", preview: meta[at]?.p ?? "", score: best });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** The passage pair behind an edge, so a card can show its working. */
  match(a: string, b: string): Match | null {
    return this.matches.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? null;
  }

  /**
   * The best-matching passage pair, and how much of the two notes overlap.
   *
   * Score alone cannot say two notes are the same note. A single shared
   * paragraph inside two long documents scores as high as a genuine duplicate:
   * `note-a-long-session-writeup` and `note-a-profile` hit 0.94 on one passage
   * while sharing 8% of their content, because the first cites the second.
   * That is a cross-reference, and calling it a duplicate is wrong.
   *
   * So coverage is measured both ways and the smaller taken: the fraction of
   * each note's passages with a near-twin in the other. A short note quoted
   * inside a long one scores 1.0 one way and 0.05 the other, and the minimum
   * correctly refuses to call it a duplicate.
   */
  private bestPair(a: string, b: string, tau: number): Pair {
    const va = this.vecs.get(a) ?? [];
    const vb = this.vecs.get(b) ?? [];
    if (!va.length || !vb.length) return { score: -1, ai: 0, bi: 0, coverage: 0 };

    let score = -1;
    let ai = 0;
    let bi = 0;
    let hitA = 0;
    const hitB = new Array<boolean>(vb.length).fill(false);
    for (let i = 0; i < va.length; i++) {
      let bestForA = -1;
      for (let j = 0; j < vb.length; j++) {
        const s = cosine(va[i], vb[j]);
        if (s > bestForA) bestForA = s;
        if (s >= tau) hitB[j] = true;
        if (s > score) {
          score = s;
          ai = i;
          bi = j;
        }
      }
      if (bestForA >= tau) hitA++;
    }
    const coverage = Math.min(hitA / va.length, hitB.filter(Boolean).length / vb.length);
    return { score, ai, bi, coverage };
  }

  // ----------------------------------------------------------------- edges

  /**
   * What the cached edge set actually depends on.
   *
   * Not the graph's raw size: the graph view folds in sessions and the sibling
   * vault while the findings view does not, so keying on `nodes.length` made the
   * two views invalidate each other's cache on every switch and re-run a third
   * of a million dot products each time. Both produce the same inputs to *this*
   * computation, so the key is built from those instead.
   */
  private signature(graph: Graph, s: SemanticSettings): string {
    let explained = 0;
    for (const e of graph.edges) if (e.layer === "links" || e.layer === "suggested") explained++;
    let embedded = 0;
    for (const n of graph.nodes) if (!n.foreign && this.vecs.has(n.id)) embedded++;
    return `${this.revision}|${embedded}|${explained}|${s.k}|${s.echoAt}|${s.floor}`;
  }

  /**
   * Mutual k-nearest neighbours over passages, split into the two layers.
   *
   * Cached against the index revision and the thresholds, because this is now
   * O(passages squared) rather than O(notes squared) — a few hundred passages
   * is a third of a million dot products, fine once and far too slow on every
   * keystroke.
   *
   * Resonance skips any pair the graph already explains: an existing wikilink,
   * or a Suggested edge, which proposes shared-topic pairs by set arithmetic.
   * Drawing both would put two lines along one path and make the counts disagree
   * with the picture. Echo does not skip linked pairs — two notes can be linked
   * *and* be the same note, and that is still worth being told.
   */
  edges(graph: Graph, settings: SemanticSettings): GEdge[] {
    const key = this.signature(graph, settings);
    const hit = this.cache.get(key);
    if (hit) return hit;
    // Never computed on the calling frame. Opening the graph must not wait on a
    // third of a million dot products, so the last result is shown while the new
    // one is worked out — stale beats blank, and blank beats a frozen window.
    void this.compute(graph, settings, key);
    return this.last ?? [];
  }

  /**
   * The same edges, awaited.
   *
   * The findings view is a queue, not a canvas: it can wait a second, and it
   * must never draw an empty list while an answer is on its way. Peeking at a
   * cache someone else might fill is what left it permanently blank — no pairs
   * meant no rows, and no rows meant no merge buttons, so "merge does nothing"
   * was literally true. Asking and waiting has no such window.
   */
  async pairs(graph: Graph, settings: SemanticSettings): Promise<GEdge[]> {
    const key = this.signature(graph, settings);
    return this.cache.get(key) ?? (await this.compute(graph, settings, key));
  }

  /** One build per signature, shared by every caller that asks while it runs. */
  private compute(graph: Graph, settings: SemanticSettings, key: string): Promise<GEdge[]> {
    const running = this.inflight.get(key);
    if (running) return running;

    const job = (async () => {
      try {
        const edges = await this.buildEdges(graph, settings);
        this.remember(key, edges);
        this.onEdgesReady?.();
        return edges;
      } catch (err) {
        console.error("[strata] semantic edge pass failed", err);
        return [];
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  private remember(key: string, edges: GEdge[]): void {
    // Two views, plus a little room for a setting being nudged back and forth.
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, edges);
    this.last = edges;
  }

  private invalidate(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  private async buildEdges(graph: Graph, settings: SemanticSettings): Promise<GEdge[]> {
    const local = new Set(graph.nodes.filter((n) => !n.foreign).map((n) => n.id));
    const ids = [...this.vecs.keys()].filter((p) => local.has(p) && (this.vecs.get(p)?.length ?? 0) > 0);
    const n = ids.length;
    if (n < 2) return [];

    const explained = new Set<string>();
    const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const edge of graph.edges) {
      if (edge.layer === "links" || edge.layer === "suggested") explained.add(pair(edge.source, edge.target));
    }

    const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(-1));
    const where = new Map<string, Pair>();
    // A passage counts as having a twin a little below the duplicate threshold,
    // so coverage measures "the same material" rather than "identical wording".
    const tau = Math.min(settings.echoAt - 0.06, 0.85);
    for (let i = 0; i < n; i++) {
      // Hand the frame back regularly. The pass is long enough to drop frames
      // if it runs to completion uninterrupted, and nothing here is urgent.
      if (i % 12 === 11) await new Promise((r) => window.setTimeout(r, 0));
      for (let j = i + 1; j < n; j++) {
        const best = this.bestPair(ids[i], ids[j], tau);
        sim[i][j] = best.score;
        sim[j][i] = best.score;
        if (best.score >= settings.floor) where.set(pair(ids[i], ids[j]), best);
      }
    }

    const k = Math.max(1, settings.k);
    const near: { j: number; s: number }[][] = [];
    for (let i = 0; i < n; i++) {
      const row: { j: number; s: number }[] = [];
      for (let j = 0; j < n; j++) {
        if (i !== j && sim[i][j] >= settings.floor) row.push({ j, s: sim[i][j] });
      }
      row.sort((a, b) => b.s - a.s);
      near.push(row.slice(0, k));
    }

    const claims = near.map((row) => new Set(row.map((r) => r.j)));
    const out: GEdge[] = [];
    this.matches.clear();
    for (let i = 0; i < n; i++) {
      for (const { j, s } of near[i]) {
        if (j < i) continue; // one edge per pair
        if (!claims[j].has(i)) continue; // mutual, or it is a hub reaching down
        const a = ids[i];
        const b = ids[j];
        // Echo needs both: near-identical language *and* enough of it.
        const at = where.get(pair(a, b));
        const isEcho = s >= settings.echoAt && (at?.coverage ?? 0) >= ECHO_COVERAGE;
        if (!isEcho && explained.has(pair(a, b))) continue;

        if (at) {
          const first = a < b ? a : b;
          const second = a < b ? b : a;
          const fi = a < b ? at.ai : at.bi;
          const si = a < b ? at.bi : at.ai;
          const fm = this.entries.get(first)?.segs[fi];
          const sm = this.entries.get(second)?.segs[si];
          this.matches.set(pair(a, b), {
            score: s,
            a: { heading: fm?.h ?? "", preview: fm?.p ?? "" },
            b: { heading: sm?.h ?? "", preview: sm?.p ?? "" },
          });
        }

        out.push({
          id: `${isEcho ? "echo" : "resonance"}:${a}>${b}`,
          source: a,
          target: b,
          layer: isEcho ? "echo" : "resonance",
          similarity: s,
        });
      }
    }

    return out;
  }
}
