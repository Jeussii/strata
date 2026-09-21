import { Notice, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { StrataView, VIEW_TYPE_STRATA } from "./view";
import type { Tab } from "./findings";
import { SessionMeta, dedupe, topicsFromWrites } from "./sessions";
import { DEFAULT_SEMANTIC, SemanticIndex, SemanticSettings } from "./semantic";
import { StrataSettingTab } from "./settings";
import { IndexRunner } from "./runner";
import { CaptureModal } from "./capture";
import { SplitModal } from "./split";
import { DEFAULT_FORCES, ForceSettings } from "./forces";
import { Doc, sessionDocs, siblingDocs, vaultDoc } from "./docs";
import { INBOX, fileTheObvious } from "./inbox";
import type { Aspect } from "./aspect";

interface StrataData {
  /** Node positions, keyed by vault path. The arrangement is the user's work. */
  positions: Record<string, { x: number; y: number }>;
  /**
   * Sessions you have explicitly added. Nothing is discovered: this map is
   * empty until you pick something, and it only ever grows by hand.
   */
  linkedSessions: Record<string, SessionMeta>;
  /** Model host, thresholds — everything that decides what a semantic edge means. */
  semantic: SemanticSettings;
  /**
   * Which layout produced the saved positions.
   *
   * Positions outlive the code that made them. When the arrangement rules
   * change, the old coordinates are not merely stale — they encode a shape the
   * current layout would never produce, and no amount of incremental repair
   * removes it. Bumping this throws them away once.
   */
  layoutVersion: number;
  /**
   * The four force sliders, plus the one that decides how far out the
   * unattached sit. Named after the forces themselves rather than an abstract
   * "spread", because a simulation is what is actually running.
   */
  forces: ForceSettings;
  /**
   * Pairs you have looked at and said no to.
   *
   * A suggestion that keeps coming back after being refused is not a suggestion,
   * it is nagging — and it trains you to stop reading the list. Keyed by the two
   * paths, so it survives everything except one of them being renamed.
   */
  dismissed: string[];
  /**
   * The model that judges, names and files passages. Bigger than the embedder,
   * used far less — so its size is paid for in latency you notice only when you
   * clicks something, never in the background.
   *
   * **qwen3:8b, and the jump from 4b is not a guess.** Measured against five
   * hand-written relation controls at five repetitions each:
   *
   *   qwen3:4b       10/25   455ms/call
   *   qwen3:8b       20/25   597ms/call
   *   qwen3:30b-a3b  10/25  1098ms/call
   *
   * The 4b was getting `tension` and `unrelated` wrong every single time, which
   * is the half of the aspect layer worth having. Doubling accuracy costs 140ms.
   *
   * The 30B mixture-of-experts is the interesting negative result: 30B of
   * weights but ~3B active per token, so it holds far more knowledge and does
   * no more reasoning. It scored exactly like the 4b at 2.4x the latency and
   * 18GB resident. Active parameters buy judgement; total parameters buy
   * recall, and nothing here needs recall.
   */
  writer: string;
  /**
   * What the local model made of a pair, keyed by the two paths.
   *
   * Cached because judging costs a second of model time and the answer only
   * changes when one of the notes does — and because nothing here runs on its
   * own. A pair is read when you open it, not when the graph loads.
   */
  aspects: Record<string, Aspect>;
}

const DEFAULT_DATA: StrataData = {
  positions: {},
  linkedSessions: {},
  semantic: DEFAULT_SEMANTIC,
  layoutVersion: 10,
  forces: DEFAULT_FORCES,
  writer: "qwen3:8b",
  dismissed: [],
  aspects: {},
};

export default class StrataPlugin extends Plugin {
  data: StrataData = DEFAULT_DATA;
  /**
   * Held on the plugin rather than the view so the embeddings survive closing
   * the tab. Rebuilding them is cheap but not free, and the index is about the
   * vault, not about a window being open.
   */
  index: SemanticIndex | null = null;
  /** Notes changed since the model last read them; see `countStale`. */
  staleCount = 0;
  runner: IndexRunner | null = null;

  /**
   * Dragging a node fires constantly. Coalesce the writes so a minute of
   * rearranging costs one disk write, not four hundred.
   */
  queueSave = debounce(() => void this.saveData(this.data), 1500, false);

  async onload() {
    const stored = (await this.loadData()) as (Partial<StrataData> & { sessionCache?: unknown }) | null;
    this.data = Object.assign({}, DEFAULT_DATA, stored);
    this.data.semantic = Object.assign({}, DEFAULT_SEMANTIC, stored?.semantic);
    // A fresh object, not the shared default: these are mutated by the sliders,
    // and assigning the constant straight in would edit it for the whole module.
    this.data.forces = Object.assign({}, DEFAULT_FORCES, stored?.forces);
    this.data.aspects = stored?.aspects ?? {};
    // Positions saved while sessions were auto-scanned were laid out around
    // edges that no longer exist, which left the notes bunched into a
    // corner. Drop them once so the next open lays out clean.
    if (stored && "sessionCache" in stored) {
      this.data.positions = {};
      const legacy = this.data as unknown as Record<string, unknown>;
      for (const key of ["sessionCache", "sessionTriage", "scanVersion"]) delete legacy[key];
    }
    // `spread` was one number standing in for the five named forces. It is
    // carried forward by the defaults merge forever unless dropped, and a
    // setting nothing reads is a setting that will confuse someone later.
    if (stored && "spread" in stored) {
      delete (this.data as unknown as Record<string, unknown>).spread;
      this.queueSave();
    }
    // `writer` has never had a settings control, so a stored "qwen3:4b" is the
    // old default rather than a choice, and moving it forward is safe. Anything
    // else set by hand is left exactly as it is.
    if (stored?.writer === "qwen3:4b") {
      this.data.writer = DEFAULT_DATA.writer;
      this.queueSave();
    }
    // The packed grid lives in the saved coordinates, not in the code that made
    // it. Unconnected nodes get re-placed on every render, but a node holding a
    // semantic edge is not unconnected — so its grid position was never touched,
    // which is why fixing the layout appeared to change nothing.
    //
    // Bumped to 6 for the same class of problem: one of the three places that
    // save a position was saving parked ones too, so a well-connected note
    // could be left a thousand pixels out with its edges stretched back to the
    // middle. Measured against a finished graph — a fresh simulation puts the
    // furthest node just outside the core and every one of those is genuinely
    // edgeless, while the stored file had a well-connected note twice as far
    // out. The code is fixed; the bad coordinates are already on disk and have
    // to be dropped once.
    //
    // 7 for the second half of the same fix: the guard trusted a graph that
    // reported no edges, which is what Obsidian's metadata cache reports for a
    // few seconds after a cold start, so the parked ring was written over every
    // real coordinate anyway. Those rings need dropping too.
    //
    // 8 because neither of those was the root. The graph is not only *empty*
    // while the cache fills, it is *partial* — and a partial graph looks
    // exactly like a real one with fewer edges, so every guard that asked
    // "does this node have edges" got a truthful no about a node with plenty.
    // A topic page was saved far out in the orphan ring; the simulation, run
    // offline against the finished graph, puts it near the middle.
    // Nothing is written now until the cache covers every file.
    //
    // 9 because the sibling vault gained its own edges. Nodes that were
    // genuinely edgeless — and correctly ringed — are attached now, and a
    // stored ring position with live edges is the starburst all over again.
    if ((stored?.layoutVersion ?? 0) < DEFAULT_DATA.layoutVersion) {
      this.data.positions = {};
      this.data.layoutVersion = DEFAULT_DATA.layoutVersion;
      await this.saveData(this.data);
    }

    this.index = new SemanticIndex(this.app, this.manifest.dir ?? ".obsidian/plugins/strata");
    this.runner = new IndexRunner(this.index, () => this.data.semantic);
    this.runner.onChange = () => this.refreshViews();
    this.index.onEdgesReady = () => this.refreshViews();

    // Loading the cache is deferred past layout. Nothing about the graph needs
    // it, and reading a couple of megabytes of vectors is not worth delaying
    // the window for.
    // Findings used to be a tab of its own. A leaf left in a saved workspace
    // comes back as a dead pane for a view type nothing registers any more —
    // and Obsidian restores those lazily, so clearing them once at startup is
    // not enough: one reappeared several seconds later, after the sweep had
    // already run. Watching layout-change catches it whenever it shows up.
    const sweepRetired = () => {
      for (const stale of this.app.workspace.getLeavesOfType("strata-findings")) stale.detach();
    };
    this.registerEvent(this.app.workspace.on("layout-change", sweepRetired));

    // One conversation, one node. Claude Code forks a transcript on resume and
    // copies the history prefix, so the same conversation arrives as several
    // files — and two nodes for one thing is a double-count, not a graph.
    this.collapseSessions();

    // Obsidian resolves its link cache asynchronously, and on a vault of any
    // size that takes a few seconds: watched live, the edge count climbs,
    // collapses to zero, and refills. Anything computed from it before the
    // last of those is computed from a graph that does not exist. Re-render
    // when it settles, and see `keepPosition` in the view for what is refused
    // until then.
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refreshViews()));

    this.app.workspace.onLayoutReady(() => {
      sweepRetired();
      // What a conversation was about, taken from the notes it wrote. It has to
      // wait for layout: `metadataCache` is empty during `onload`, so asking a
      // note for its topics there returns nothing and files the session under
      // no subject at all.
      this.refreshSessionTopics();
      void (async () => {
        await this.index?.load();
        this.refreshViews();
        if (this.data.semantic.background) this.sweep();
        void this.fileInbox();
      })();
    });

    // Something landed in the Inbox. Filing runs itself — needing to invoke a
    // model by hand every time would make the folder a chore rather than a
    // drop point. Debounced because a paste can fire several events.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.parent?.name === INBOX) this.nudgeInbox();
      })
    );

    // A note that changed is a note the model has not read. Queued, never
    // indexed inline: saving a file must not wait on an embedding.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.data.semantic.background)
          this.runner?.enqueue([vaultDoc(this.app, file)]);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", () => {
        if (this.index?.prune(new Set(this.app.vault.getMarkdownFiles().map((f) => f.path)))) this.refreshViews();
        if (this.data.semantic.background) this.sweep();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        if (this.index?.prune(new Set(this.app.vault.getMarkdownFiles().map((f) => f.path)))) this.refreshViews();
      })
    );

    this.registerView(VIEW_TYPE_STRATA, (leaf: WorkspaceLeaf) => new StrataView(leaf, this));
    this.addSettingTab(new StrataSettingTab(this.app, this));

    this.addRibbonIcon("layers", "Strata: the graph", () => void this.activate());
    this.addRibbonIcon("list-checks", "Strata: findings", () => this.openFindings());
    this.addRibbonIcon("plus-circle", "Strata: capture a thought", () => this.capture());
    this.addCommand({
      id: "open-strata-graph",
      name: "Open the layered graph",
      callback: () => void this.activate(),
    });
    this.addCommand({
      id: "open-strata-findings",
      name: "Open findings",
      callback: () => this.openFindings(),
    });
    this.addCommand({
      id: "strata-link-session",
      name: "Add an AI session to the graph",
      callback: () => void this.linkSession(),
    });
    this.addCommand({
      id: "strata-web-chat",
      name: "Add a Gemini or ChatGPT conversation",
      callback: () => void this.addWebChat(),
    });
    this.addCommand({
      id: "strata-index",
      name: "Read the vault with the local model",
      callback: () => this.sweep(true),
    });
    this.addCommand({
      id: "strata-split",
      name: "Split this note into atoms",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || !this.splittable(file)) return false;
        if (!checking) this.split(file);
        return true;
      },
    });
    this.addCommand({
      id: "strata-capture",
      name: "Capture a thought (checks for duplicates first)",
      callback: () => this.capture(),
    });
  }

  async onunload() {
    this.runner?.stop();
    await this.saveData(this.data);
  }

  /**
   * Queue whatever the model has not read.
   *
   * `force` is the difference between the button and the background: pressing
   * it says so out loud when there is nothing to do, while the background pass
   * stays silent either way.
   */
  /** Topics for every linked session, from the notes each one wrote. */
  refreshSessionTopics(): void {
    const topicsOf = (path: string): string[] => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return [];
      const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.topics;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return list.map((t) => String(t));
    };
    let changed = false;
    for (const session of Object.values(this.data.linkedSessions)) {
      const topics = topicsFromWrites(session, topicsOf);
      if (topics.join("|") === (session.topics ?? []).join("|")) continue;
      session.topics = topics;
      changed = true;
    }
    if (changed) this.queueSave();
  }

  /** Drop session entries that are the same conversation as one already held. */
  private collapseSessions(): void {
    const all = Object.values(this.data.linkedSessions);
    if (all.length < 2) return;
    const { drop } = dedupe(all);
    if (!drop.length) return;
    for (const stale of drop) {
      delete this.data.linkedSessions[stale.id];
      delete this.data.positions[`session:${stale.id}`];
    }
    this.queueSave();
    new Notice(
      `Merged ${drop.length} duplicate session${drop.length === 1 ? "" : "s"} — same conversation, resumed.`
    );
  }

  /**
   * Move out of the Inbox anything that needs no judgement.
   *
   * Only files that already carry frontmatter. Measured on a real vault,
   * every automatic way of choosing a topic — a local model reading the note,
   * nearest neighbours, topic centroids — gets it wrong more often than right,
   * so nothing unfiled is touched here however confident it looks. Those wait
   * in the Findings panel with a shortlist.
   */
  async fileInbox(): Promise<void> {
    try {
      const moved = await fileTheObvious(this.app);
      if (moved.length) {
        new Notice(`Filed ${moved.length} note${moved.length === 1 ? "" : "s"} from the Inbox.`);
        this.sweep();
        this.refreshViews();
      }
    } catch (err) {
      console.error("[strata] inbox pass failed", err);
    }
  }

  /** Coalesce a burst of Inbox writes into one pass. */
  nudgeInbox = debounce(() => void this.fileInbox(), 2500, false);

  /**
   * How many notes the model has not read since they last changed.
   *
   * Cheap on the common path: `stale` compares mtime first and only hashes the
   * files whose mtime moved, so an unchanged vault costs a directory listing.
   * It exists because the Re-read button was supposed to say how much work was
   * outstanding and instead said "Re-read" — a button that gives no reason to
   * press it, next to Re-layout, which is a different verb on a different
   * noun.
   */
  async countStale(): Promise<number> {
    const index = this.index;
    if (!index) return 0;
    try {
      const files = await this.embeddable();
      this.staleCount = (await index.stale(files, this.data.semantic)).length;
    } catch {
      // A count is a nicety; failing to get one must never break a render.
      this.staleCount = 0;
    }
    return this.staleCount;
  }

  sweep(force = false): void {
    void (async () => {
      const index = this.index;
      if (!index) return;
      const files = await this.embeddable();
      index.prune(new Set(files.map((f) => f.key)));
      const todo = await index.stale(files, this.data.semantic);
      if (!todo.length) {
        if (force) new Notice(`Already read: ${index.size} notes, ${index.segmentCount} passages.`);
        return;
      }
      if (force) new Notice(`Reading ${todo.length} note${todo.length === 1 ? "" : "s"} in the background.`);
      this.runner?.enqueue(todo);
    })();
  }

  /**
   * Notes worth embedding.
   *
   * Topics and sources are Dataview stubs that assemble themselves, so their
   * prose is a query rather than a thought.
   */
  /**
   * This vault's own notes. Schema-bound work (horizon, compound splitting)
   * belongs to the knowledge vault alone, so it asks for this rather than for
   * the combined list.
   */
  vaultNotes(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => {
      const folder = f.parent?.name ?? "";
      // `Full/` holds the unsplit original a set of atoms came out of. It is
      // deliberately not a node and not embedded: it would echo against every
      // atom taken from it, which is true and completely useless.
      if (folder === "Topics" || folder === "Sources" || folder === "Full") return false;
      // Written but not filed. Embedding it would put a note into the space
      // before you have said what it is about, and the Inbox exists precisely so
      // that decision has somewhere to be pending.
      if (folder === "Inbox") return false;
      const type = this.app.metadataCache.getFileCache(f)?.frontmatter?.type;
      return type !== "topic" && type !== "source" && type !== "full";
    });
  }

  /**
   * Everything worth embedding, across both vaults.
   *
   * The sibling vault joins the same space here. Until it did, Work entries
   * were drawn on the canvas and invisible to the layers that do the
   * connecting, so a business decision could not rhyme with the value it
   * rests on.
   */
  async embeddable(): Promise<Doc[]> {
    return [
      ...this.vaultNotes().map((f) => vaultDoc(this.app, f)),
      ...(await siblingDocs(this.app)),
      ...sessionDocs(Object.values(this.data.linkedSessions)),
    ];
  }

  /**
   * Splitting writes knowledge-vault frontmatter, so it only runs on knowledge-
   * vault atoms. Pointed at a Work entry it would produce a `type: note` file in
   * a vault whose schema has no such thing — a silent corruption, so it refuses.
   */
  private splittable(file: TFile): boolean {
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
    if (type) return type === "note";
    return file.parent?.name === "Notes";
  }

  /** The writer model reuses the embedder's host: one Ollama, two jobs. */
  split(file: TFile): void {
    if (!this.splittable(file)) {
      new Notice("Splitting only applies to knowledge-vault atoms (type: note).");
      return;
    }
    new SplitModal(this.app, file, { host: this.data.semantic.host, model: this.data.writer }, () => {
      this.sweep();
      this.refreshViews();
    }).open();
  }

  /** Open the graph, then the queue inside it. */
  openFindings(tab?: Tab): void {
    void (async () => {
      await this.activate();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_STRATA)[0];
      (leaf?.view as { showFindings?: (t?: Tab) => void } | undefined)?.showFindings?.(tab);
    })();
  }

  capture(): void {
    if (!this.index) return;
    // The capture form writes knowledge-vault frontmatter, so it needs a
    // knowledge vault to write into.
    const folder = this.app.vault.getAbstractFileByPath("Notes");
    if (!folder) {
      new Notice("Capture writes knowledge-vault atoms, and this vault has no Notes folder.");
      return;
    }
    new CaptureModal(this.app, this.index, this.data.semantic, (result) => {
      const file = this.app.vault.getAbstractFileByPath(result.path);
      if (file instanceof TFile) this.runner?.enqueue([vaultDoc(this.app, file)]);
      this.refreshViews();
    }).open();
  }

  /** The stable key for a pair, whichever order it arrives in. */
  static pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  isDismissed(a: string, b: string): boolean {
    return this.data.dismissed.includes(StrataPlugin.pairKey(a, b));
  }

  dismiss(a: string, b: string): void {
    const key = StrataPlugin.pairKey(a, b);
    if (!this.data.dismissed.includes(key)) this.data.dismissed.push(key);
    void this.saveData(this.data);
    this.refreshViews();
  }

  /** Redraw every open Strata view — used when a setting changes what an edge means. */
  refreshViews() {
    for (const type of [VIEW_TYPE_STRATA]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        (leaf.view as { refresh?: () => void }).refresh?.();
      }
    }
  }

  private async addWebChat() {
    await this.activate();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_STRATA)[0];
    (leaf?.view as { addWebChat?: () => void } | undefined)?.addWebChat?.();
  }

  /** Routed through the open view, which owns the vault index the parser needs. */
  private async linkSession() {
    await this.activate();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_STRATA)[0];
    const view = leaf?.view as { pickSession?: () => void } | undefined;
    view?.pickSession?.();
  }

  private async activate(type: string = VIEW_TYPE_STRATA) {
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    // Main area, not a sidebar. Both of these are places to work, not accessories.
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
