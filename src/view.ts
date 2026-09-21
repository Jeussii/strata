import { ItemView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import cytoscape, { Core, EdgeSingular, ElementDefinition, NodeSingular } from "cytoscape";
import type StrataPlugin from "./main";
import {
  GEdge,
  GNode,
  Graph,
  LayerId,
  LAYERS,
  LayerGroupId,
  LAYER_GROUPS,
  bridgeEdges,
  servesEdges,
  buildGraph,
  anchorFor,
  layerCounts,
  suggestLinks,
} from "./model";
import { Foreign, readSibling } from "./sibling";
import { SessionRef, parseSession, resumeSession } from "./sessions";
import type { Passage } from "./semantic";
import { WebChatModal } from "./webchat";
import { compound, segment } from "./segment";
import { bridgeTo, linkTo } from "./write";
import { FindingsPanel, Tab } from "./findings";
import { ForceSettings, LOOSE_FLOOR, Placed, Spring, simulate, park } from "./forces";
import { PROVIDER_COLOURS, PROVIDER_LABELS, providerMark } from "./marks";
import { RELATION_LABEL, judge, pairKey } from "./aspect";
import {
  KIND_COLOURS,
  KIND_LABEL,
  LAYER_COLOURS,
  LAYER_MEANING,
  NEUTRAL,
  ORIGIN_COLOURS,
  ORIGIN_MEANING,
  recencyColour,
  HORIZON_COLOURS,
  HORIZON_MEANING,
  isDark,
  tune,
} from "./theme";


export const VIEW_TYPE_STRATA = "strata-graph";

type ColourMode = "origin" | "kind" | "recency" | "horizon";

const LABEL_ZOOM = 1.15;
/**
 * How far the unrelated recedes on hover.
 *
 * This was 0.07, which is not receding, it is erasing — hovering any node
 * turned the rest of the graph into faint grey ghosts and read as "the
 * colouring disappeared". 0.3 was the second attempt and still failed the same
 * test: on a light background a mid-saturation dot at 30% is grey, not a
 * quieter orange.
 *
 * The mistake was using one number for nodes and edges. Nodes hold the colour,
 * so they barely move; edges hold the clutter, so they do the receding.
 */
const FADE = 0.62;
/** Edges carry the de-emphasis, because losing a line costs no information. */
const FADE_EDGE = 0.08;

/** Layers drawn as broken lines: a proposal, not a fact the vault can prove. */
const DASHED = new Set<LayerId>(["suggested", "resonance", "echo"]);

/**
 * What each colour mode is actually answering.
 *
 * The key used to head itself `ORIGIN` — the name of a frontmatter field,
 * which tells you where the value is stored and nothing about what the picture
 * in front of you means. A key that has to be looked up is not a key.
 */
const MODE_QUESTION: Record<ColourMode, string> = {
  origin: "whose thinking it is",
  kind: "what kind of page",
  recency: "when it was captured",
  horizon: "how long it stays true",
};

const MODE_ORDER: ColourMode[] = ["origin", "kind", "recency", "horizon"];

/** A row of the colour key, as something the graph can be narrowed to. */
interface MarkFilter {
  field: "origin" | "horizon" | "kind" | "foreign";
  value: string;
}

/**
 * On by default: the whole Structure group, plus the links you wrote yourself.
 *
 * `bridges` joined the default set when the chips became groups. It was off
 * before because it had its own chip and seven edges did not earn one — but a
 * group that is permanently half-on is a worse control than one extra hairline
 * is clutter, and seven edges across two vaults is not clutter.
 *
 * `serves` joins on the same argument: it is frontmatter structure like the
 * rest of its group, and a group that is permanently half-on is a worse
 * control than one more hairline is clutter.
 *
 * Sessions and Maybe stay off: both are noisy until asked for.
 */
const DEFAULT_LAYERS: LayerId[] = ["topics", "source", "hierarchy", "serves", "bridges", "links"];

/**
 * The one surface.
 *
 * Legibility rules, which are the difference between this and Obsidian's graph:
 *
 *   1. Labels are earned. Only hubs carry one until you zoom in or hover, and
 *      nothing with no visible edge is ever named.
 *   2. Attention is exclusive. Hovering fades everything unrelated.
 *   3. An edge says what it means, in words, on hover and in the legend.
 *
 * And the rule that keeps it honest: **every layer answers a question.** Topics
 * answers "what is this about". Sessions answers "what did I work on". Suggested
 * answers "what have I failed to connect". A layer that only looks good gets cut.
 */
export class StrataView extends ItemView {
  private plugin: StrataPlugin;
  private cy: Core | null = null;
  private graph: Graph | null = null;
  private foreign: Foreign = { nodes: [], byKey: new Map(), byName: new Map() };

  private canvasEl!: HTMLElement;
  private clearEl?: HTMLButtonElement;
  private resultsEl?: HTMLElement;
  /** Passages the index matched for the current query, newest answer wins. */
  private semantic: Passage[] = [];
  private semanticFor = "";
  private semanticRun = 0;
  private semanticNote = "";
  private cardEl!: HTMLElement;
  private findings!: FindingsPanel;
  private findingsBtn?: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private readoutEl!: HTMLElement;
  private legendEl!: HTMLElement;
  private keyHeadEl!: HTMLElement;
  private keyBodyEl!: HTMLElement;
  private modeEls = new Map<ColourMode, HTMLElement>();
  /** Set while a mode tab is hovered, so the graph previews without committing. */
  private previewMode: ColourMode | null = null;
  private modeTimer: number | null = null;
  private settingsEl!: HTMLElement;
  private sizeWatch: ResizeObserver | null = null;
  private fitted = false;
  private warmUntil = 0;
  private warming = false;
  private topicSelect!: HTMLSelectElement;
  private kindSelect!: HTMLSelectElement;
  private horizonSelect!: HTMLSelectElement;
  private searchEl!: HTMLInputElement;
  private indexBtn!: HTMLButtonElement;
  private tipEl!: HTMLElement;
  private tipTimer: number | null = null;

  private activeLayers = new Set<LayerId>(DEFAULT_LAYERS);
  /** Which group has its member layers unfolded, if any. At most one at a time. */
  private openGroup: LayerGroupId | null = null;
  /** Nodes holding at least one edge on *any* layer — see `keepPosition`. */
  private connected = new Set<string>();
  /** Whether the vault has finished loading — see `graphSettled`. */
  private settled = false;
  /** The key row that is currently isolating part of the graph, if any. */
  private markFilter: MarkFilter | null = null;
  private segEl!: HTMLElement;
  private subEl!: HTMLElement;
  private colourMode: ColourMode = "origin";
  private topicFilter = "";
  private kindFilter = "";
  private horizonFilter = "";
  private query = "";
  private hideIsolated = false;
  private pinned: string | null = null;
  /** Re-read on every render, because the theme can change under a live view. */
  private dark = false;

  constructor(leaf: WorkspaceLeaf, plugin: StrataPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_STRATA;
  }
  getDisplayText() {
    return "Strata";
  }
  getIcon() {
    return "layers";
  }

  /**
   * Build the shell, if it is not there already.
   *
   * Same reason as the findings view: Obsidian does not reliably call `onOpen`
   * on a view it has constructed, and a view that cannot build itself on
   * demand is one dropped lifecycle call away from being a blank pane. This
   * one has been getting away with it; that is luck, not design.
   */
  private shell(): void {
    if (this.canvasEl) return;
    const root = this.contentEl;
    root.empty();
    root.addClass("strata-root");

    this.buildToolbar(root.createDiv({ cls: "strata-toolbar" }));
    this.tipEl = root.createDiv({ cls: "strata-tip" });

    const stage = root.createDiv({ cls: "strata-stage" });
    this.canvasEl = stage.createDiv({ cls: "strata-canvas" });

    // Obsidian lays a view out after it is opened, so the first render happens
    // in a pane that is still zero-width and `fit` computes a viewport for a
    // canvas that does not exist yet — the graph is drawn correctly and sits
    // entirely off-screen, which reads as "nothing loaded". Watching the canvas
    // instead of guessing at a delay fixes it for the slow cases too: opening
    // the sidebar, dragging the split, restoring the window.
    this.sizeWatch = new ResizeObserver(() => {
      const cy = this.cy;
      if (!cy || !this.canvasEl.clientWidth) return;
      cy.resize();
      // Only until it has landed once. After that the viewport is yours.
      if (!this.fitted) this.fitViewport();
    });
    this.sizeWatch.observe(this.canvasEl);
    this.cardEl = stage.createDiv({ cls: "strata-card" });
    // The key is built once and only its body is redrawn. That matters: the
    // mode tabs are hovered while the body changes under them, and calling
    // empty() on an ancestor of the hovered element fires a spurious
    // mouseleave in Chromium, which would cancel the preview you are watching.
    this.legendEl = stage.createDiv({ cls: "strata-key" });
    this.keyHeadEl = this.legendEl.createDiv({ cls: "strata-key-head" });
    this.keyBodyEl = this.legendEl.createDiv({ cls: "strata-key-body" });
    this.buildModes(this.legendEl.createDiv({ cls: "strata-key-modes" }));
    this.legendEl.createDiv({ cls: "strata-key-hint", text: "click a row to show only that" });
    // The queue lives here rather than in a tab of its own — see FindingsPanel
    // for why, and why it is the better arrangement anyway.
    this.findings = new FindingsPanel(this.app, this.plugin, stage.createDiv({ cls: "strata-panel" }));
    this.findings.onCounts = () => this.syncFindingsChip();
    this.findings.onLinkSessions = (refs) => this.linkSessions(refs);
    const foot = stage.createDiv({ cls: "strata-foot" });
    this.statusEl = foot.createDiv({ cls: "strata-status" });
    this.readoutEl = foot.createDiv({ cls: "strata-readout" });
  }

  async onOpen() {
    this.shell();
    const root = this.contentEl;

    this.render();
    void this.loadSibling();

    // Escape is the way out of every sticky state this view can get into, and
    // it used to be gated on `pinned` — which is only set by tapping a node. So
    // the one state you could most easily get stuck in, an active Find query
    // dimming the whole graph, was the one Escape would not clear unless the
    // box still had focus. Clear whatever is actually on.
    //
    // Registered on the view, not per render.
    this.registerDomEvent(root, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!this.pinned && !this.query) return;
      this.pinned = null;
      this.clearQuery();
      this.unfocus();
      this.hideCard();
    });

    const refresh = debounce(() => this.render(), 800, true);
    this.registerEvent(this.app.metadataCache.on("resolved", refresh));
  }

  async onClose() {
    this.sizeWatch?.disconnect();
    this.sizeWatch = null;
    this.cy?.destroy();
    this.cy = null;
  }

  /** Frame the graph, and remember that it has been framed. */
  private fitViewport(): void {
    const cy = this.cy;
    if (!cy || !this.canvasEl?.clientWidth) return;
    // Frame what the visible layers actually connect. Nodes parked outside
    // because their edges are switched off are deliberately allowed to fall
    // beyond the viewport — they are context, not the subject, and including
    // them in the fit is what made a soloed layer unreadable.
    const shown = cy.nodes().not(".strata-hidden");
    const connected = shown.filter((n) => this.liveEdges(n as NodeSingular).length > 0);
    const frame = connected.length >= 2 ? connected : shown;
    cy.fit(frame.nonempty() ? frame : undefined, 60);
    this.fitted = true;
  }

  /**
   * The other vault, read once in the background. Frontmatter only, so even a
   * few hundred files cost almost nothing, and the graph is usable before it
   * lands.
   */
  private async loadSibling() {
    this.foreign = await readSibling(this.app);
    if (this.foreign.nodes.length) this.render();
  }

  /** Claude Code sessions: read off disk, chosen one at a time. */
  /**
   * Link the sessions chosen in the Findings panel.
   *
   * This used to live behind a `FuzzySuggestModal` that linked exactly one and
   * then closed. The list was never the problem — nearly every transcript
   * carries a real title — but almost none of them were in the graph, because
   * putting twenty in meant opening the modal twenty times. Same rule,
   * one pass.
   */
  private async linkSessions(refs: SessionRef[]): Promise<void> {
    const known = this.graph?.byName ?? new Map<string, string>();
    let wrote = 0;
    for (const ref of refs) {
      try {
        const meta = await parseSession(ref, known);
        this.plugin.data.linkedSessions[meta.id] = meta;
        wrote += meta.wrote.length;
      } catch {
        // One unreadable transcript should not lose the other nineteen.
        continue;
      }
    }
    this.plugin.queueSave();
    this.activeLayers.add("sessions");
    this.syncLayerChips();
    this.render();
    new Notice(
      `Added ${refs.length} session${refs.length === 1 ? "" : "s"}` +
        (wrote ? ` · ${wrote} note${wrote === 1 ? "" : "s"} they wrote to` : "")
    );
  }

  // ------------------------------------------------------------ local model

  /**
   * What the button says.
   *
   * It reports the background pass rather than driving it. Pressing it only
   * queues work; nothing here ever blocks on a model, which is the whole reason
   * the runner exists.
   */
  private syncIndexButton() {
    const index = this.plugin.index;
    const runner = this.plugin.runner;
    if (!this.indexBtn || !index || !runner) return;
    const state = runner.state;

    if (state.running) {
      this.indexBtn.setText(`Reading ${state.done}/${state.total}`);
      this.indexBtn.title = state.blocked
        ? `Paused: ${state.blocked}. It will pick itself up.`
        : "Reading in the background. Nothing is waiting on this.";
      this.indexBtn.toggleClass("is-on", true);
      this.indexBtn.toggleClass("is-working", !state.blocked);
      return;
    }

    this.indexBtn.removeClass("is-working");
    if (index.size === 0) {
      this.indexBtn.setText("Read vault");
      this.indexBtn.title = "Have the local model read every note, so Resonance and Echo have something to work from.";
      this.indexBtn.toggleClass("is-on", false);
      return;
    }
    // Say what it re-reads, and how much of it is actually waiting. "Re-read"
    // on its own named no object and gave no reason to press it, sitting next
    // to Re-layout — a different verb on a different noun, close enough in
    // shape to read as its sibling.
    const stale = this.plugin.staleCount;
    this.indexBtn.setText(stale ? `Re-read ${stale} note${stale === 1 ? "" : "s"}` : "Re-read vault");
    this.indexBtn.title = stale
      ? `${stale} note${stale === 1 ? " has" : "s have"} changed since the model last read ${stale === 1 ? "it" : "them"}.`
      : `Nothing has changed. ${index.size} notes, ${index.segmentCount} passages already read.`;
    this.indexBtn.toggleClass("is-on", stale > 0);
  }

  /** Redraw without rebuilding anything expensive — thresholds moved, not notes. */
  refresh() {
    this.shell();
    this.render();
    this.findings.refresh();
  }

  /** Open the queue, optionally on a particular tab. The plugin's way in. */
  showFindings(tab?: Tab): void {
    this.resultsEl?.removeClass("is-open");
    this.shell();
    this.findings.show(tab);
    this.syncFindingsChip();
  }

  /** The chip says whether the panel is open, and how much is waiting in it. */
  private syncFindingsChip(): void {
    if (!this.findingsBtn) return;
    this.findingsBtn.toggleClass("is-on", this.findings.visible);
    const waiting = this.findings.outstanding;
    this.findingsBtn.setText(waiting ? `Findings ${waiting}` : "Findings");
  }

  /** Gemini and ChatGPT: nothing on disk to find, so it is filled in deliberately. */
  addWebChat() {
    new WebChatModal(this.app, (meta) => {
      this.plugin.data.linkedSessions[meta.id] = meta;
      this.plugin.queueSave();
      this.activeLayers.add("sessions");
      this.syncLayerChips();
      this.render();
      new Notice(`Added ${meta.title}, joined to ${meta.wrote.length} note${meta.wrote.length === 1 ? "" : "s"}.`);
    }).open();
  }

  private unlinkSession(id: string) {
    delete this.plugin.data.linkedSessions[id];
    this.plugin.queueSave();
    this.pinned = null;
    this.hideCard();
    this.render();
  }

  // ---------------------------------------------------------------- toolbar

  private buildToolbar(bar: HTMLElement) {
    const layers = bar.createDiv({ cls: "strata-group strata-layers" });
    // Four chips, not nine. What they are grouped by, and why that cut and not
    // the obvious one, is in LAYER_GROUPS.
    this.segEl = layers.createDiv({ cls: "strata-seg" });
    for (const group of LAYER_GROUPS) {
      this.buildGroupChip(this.segEl, group);
    }
    // The unfolded group's own layers, when one is unfolded. A row of its own,
    // under the group chips, so that opening it pushes nothing sideways — the
    // four chips stay exactly where they were, which is the whole reason this
    // is not an inline expansion.
    this.subEl = layers.createDiv({ cls: "strata-sub" });
    this.syncSubRow();

    // Everything that is a preference rather than an action lives in here.
    // Nine controls on one strip meant the toolbar competed with the graph for
    // attention; what stays out is what gets touched constantly (which layers
    // are on, and search), and what moves in is what gets set once.
    this.settingsEl = bar.createDiv({ cls: "strata-settings" });
    this.settingsEl.createDiv({ cls: "strata-settings-head", text: "View" });

    const find = bar.createDiv({ cls: "strata-group strata-find" });
    this.searchEl = find.createEl("input", { cls: "strata-search", type: "text" });
    this.searchEl.placeholder = "Find…";
    // A query dims the entire graph for as long as it is set, and the only
    // thing on screen saying so was small grey text in the box. Leave one in by
    // accident — or have someone else leave one in for you — and the graph
    // looks like it has decided to highlight one node forever. Give it a
    // visible off-switch.
    this.clearEl = find.createEl("button", { cls: "strata-search-clear", text: "×" });
    this.clearEl.setAttribute("aria-label", "Clear the search");
    this.clearEl.onclick = () => {
      this.clearQuery();
      this.applyVisibility();
    };
    this.resultsEl = find.createDiv({ cls: "strata-results" });
    this.searchEl.oninput = debounce(() => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.applyVisibility();
      void this.runSemantic();
    }, 160, true);
    this.searchEl.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.searchEl.value = "";
        this.query = "";
        this.applyVisibility();
      }
      if (e.key === "Enter") this.fitToMatches();
    };

    // The Colour control used to be a <select> in here. It is the key's own
    // mode strip now: the thing that explains the colours and the thing that
    // changes them are one object, three pixels apart, instead of a legend in
    // one corner and a dropdown behind a disclosure in another.

    const scope = this.settingsEl.createDiv({ cls: "strata-row" });
    scope.createSpan({ cls: "strata-group-label", text: "Topic" });
    this.topicSelect = scope.createEl("select", { cls: "strata-select strata-topic" });
    this.topicSelect.onchange = () => {
      this.topicFilter = this.topicSelect.value;
      this.applyVisibility();
    };

    // Two more cuts through the same graph: what kind of thing a node is, and
    // whether it is a truth or a moment. Both are filters, not layers, because
    // they subset nodes rather than describe a relation.
    const cat = this.settingsEl.createDiv({ cls: "strata-row" });
    cat.createSpan({ cls: "strata-group-label", text: "Kind" });
    this.kindSelect = cat.createEl("select", { cls: "strata-select" });
    for (const [value, label] of [
      ["", "all"],
      ["note", "notes"],
      ["topic", "topics"],
      ["source", "sources"],
      ["session", "sessions"],
    ] as const) {
      this.kindSelect.createEl("option", { value, text: label });
    }
    this.kindSelect.onchange = () => {
      this.kindFilter = this.kindSelect.value;
      this.applyVisibility();
    };

    const hz = this.settingsEl.createDiv({ cls: "strata-row" });
    hz.createSpan({ cls: "strata-group-label", text: "Horizon" });
    this.horizonSelect = hz.createEl("select", { cls: "strata-select" });
    for (const [value, label] of [
      ["", "all"],
      ["timeless", "timeless"],
      ["situational", "situational"],
      ["unset", "not yet decided"],
    ] as const) {
      this.horizonSelect.createEl("option", { value, text: label });
    }
    this.horizonSelect.onchange = () => {
      this.horizonFilter = this.horizonSelect.value;
      this.applyVisibility();
    };

    const opts = bar.createDiv({ cls: "strata-group strata-group-right" });

    // The only button here that talks to a model. It never fires on its own:
    // the label says how much work is outstanding and waits to be asked, so
    // opening the graph never quietly spins up a model in the background.
    this.indexBtn = opts.createEl("button", { cls: "strata-chip strata-chip-plain strata-chip-model" });
    this.indexBtn.onclick = () => this.plugin.sweep(true);
    this.syncIndexButton();

    const add = opts.createEl("button", { cls: "strata-chip strata-chip-plain", text: "+ Session" });
    this.explain(add, "Pick Claude Code sessions off this machine. Nothing appears here on its own.");
    add.onclick = () => this.showFindings("sessions");

    // Rarely reached for: a linked session is almost always Claude Code, and
    // a Gemini or ChatGPT transcript has to be typed in by hand. That is a
    // deliberate, rare act, so it sits in here rather than taking a permanent
    // slot in the bar.
    const web = this.settingsEl.createEl("button", { cls: "strata-chip strata-chip-plain strata-row-btn", text: "+ Chat" });
    this.explain(
      web,
      "Add a Gemini or ChatGPT conversation by hand. Their transcripts live on someone else's server, so there is nothing to read here."
    );
    web.onclick = () => this.addWebChat();

    const isolated = this.settingsEl.createEl("button", { cls: "strata-chip strata-chip-plain strata-row-btn", text: "Hide isolated" });
    this.explain(isolated, "Hide anything with no visible edge.");
    isolated.onclick = () => {
      this.hideIsolated = !this.hideIsolated;
      isolated.toggleClass("is-on", this.hideIsolated);
      this.applyVisibility();
    };

    // Obsidian's own four, by their own names, plus the one that decides how
    // far out the unattached sit. A slider called "spread" was one number
    // standing in for four different forces, which is why nudging it appeared
    // to cause and cure the grid at different ends of its travel.
    this.force(this.settingsEl, "Centre", "centre", 0, 1.5, 0.05, "Pull toward the middle. Everything drifts apart without it.");
    this.force(this.settingsEl, "Repel", "repel", 1, 30, 0.5, "How hard every node pushes every other one away.");
    this.force(this.settingsEl, "Link", "link", 0, 2, 0.05, "Spring strength along an edge. Higher pulls linked notes tighter together.");
    this.force(this.settingsEl, "Distance", "distance", 40, 500, 10, "How long a link wants to be, in pixels.");
    this.force(
      this.settingsEl,
      "Outer ring",
      "loose",
      LOOSE_FLOOR,
      1,
      0.05,
      "How far the unconnected sit outside the rest. At 1 they mix in among everything else, the way Obsidian does it."
    );

    this.findingsBtn = opts.createEl("button", { cls: "strata-chip strata-chip-plain", text: "Findings" });
    this.explain(
      this.findingsBtn,
      "Duplicates, unlinked rhymes, notes holding several ideas — as a list, with the action on each."
    );
    this.findingsBtn.onclick = () => {
      this.findings.toggle();
      this.syncFindingsChip();
    };

    const gear = opts.createEl("button", { cls: "strata-chip strata-chip-plain", text: "View" });
    this.explain(gear, "Colour, filters and the layout forces.");
    gear.onclick = () => {
      const open = this.settingsEl.hasClass("is-open");
      this.settingsEl.toggleClass("is-open", !open);
      gear.toggleClass("is-on", !open);
    };

    const relayout = opts.createEl("button", { cls: "strata-chip strata-chip-plain", text: "Re-layout" });
    this.explain(relayout, "Rearrange, using only the layers that are switched on.");
    relayout.onclick = () => this.runLayout(true);
  }

  /**
   * What a control does, said in words, where the cursor already is.
   *
   * Every one of these had a `title` attribute, which the OS renders after a
   * second of stillness in a system font that belongs to no design. A layer
   * whose whole purpose is to answer a question should not make you wait a
   * second to find out which question.
   */
  /**
   * One named force slider.
   *
   * Dragging one does not recompute the layout. It warms the simulation and
   * lets the arrangement on screen ease toward the new balance, which is the
   * difference between watching a graph respond to you and watching it be
   * replaced sixty times a second. It keeps easing for a beat after the handle
   * stops, then settles and saves.
   */
  private force(host: HTMLElement, label: string, key: keyof ForceSettings, min: number, max: number, step: number, hint: string) {
    const row = host.createDiv({ cls: "strata-row strata-force" });
    row.createSpan({ cls: "strata-row-label", text: label });
    const input = row.createEl("input", { cls: "strata-range", type: "range" });
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.plugin.data.forces[key]);
    const readout = row.createSpan({ cls: "strata-row-value", text: input.value });
    this.explain(row, hint);
    input.oninput = () => {
      this.plugin.data.forces[key] = Number(input.value);
      readout.setText(input.value);
      this.warm();
    };
    input.onchange = () => this.plugin.queueSave();
  }

  /**
   * Keep the simulation running for a moment.
   *
   * Each frame is a short burst from wherever the nodes currently are, so the
   * motion is the layout relaxing rather than a new one being dropped in. The
   * edge list is gathered once per warm spell instead of per frame — it cannot
   * change while a slider is under the cursor.
   */
  private warm(): void {
    this.warmUntil = performance.now() + 900;
    if (this.warming) return;
    const cy = this.cy;
    if (!cy) return;
    const visible = cy.elements().not(".strata-hidden");
    if (visible.nodes().length < 2) return;
    const springs: Spring[] = (visible.edges().toArray() as EdgeSingular[]).map((e) => ({
      source: e.source().id(),
      target: e.target().id(),
      layer: e.data("layer") as LayerId,
    }));
    // Same rule as runLayout, and it was missing here: only the nodes the
    // visible layers actually connect go into the simulation. Without this a
    // slider drag quietly undid the parking — every off-layer node came back
    // into the physics, pushed the core around, and the layer being looked at
    // shrank again while the handle was moving.
    const onLayer = new Set<string>();
    for (const spring of springs) {
      onLayer.add(spring.source);
      onLayer.add(spring.target);
    }
    if (onLayer.size < 2) return;
    this.warming = true;
    const tick = () => {
      const live = this.cy;
      if (!live || performance.now() > this.warmUntil) {
        this.warming = false;
        if (live) {
          // And only those get their position kept, for the same reason
          // layoutstop does it: a parked coordinate describes the layers that
          // are on right now, not where the node lives.
          live.nodes().forEach((node) => {
            if (this.keepPosition(node)) this.plugin.data.positions[node.id()] = { ...node.position() };
          });
          this.plugin.queueSave();
          this.applyLabelPolicy();
        }
        return;
      }
      const nodes = live.elements().not(".strata-hidden").nodes().filter((n) => onLayer.has(n.id()));
      const placed: Placed[] = (nodes.toArray() as NodeSingular[]).map((n) => ({ id: n.id(), ...n.position() }));
      simulate(placed, springs, this.plugin.data.forces, false, 4);
      live.batch(() => {
        for (const p of placed) live.getElementById(p.id).position({ x: p.x, y: p.y });
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private explain(el: HTMLElement, text: string) {
    el.addEventListener("mouseenter", () => {
      if (this.tipTimer) window.clearTimeout(this.tipTimer);
      this.tipTimer = window.setTimeout(() => {
        const box = el.getBoundingClientRect();
        const root = this.contentEl.getBoundingClientRect();
        this.tipEl.setText(text);
        this.tipEl.addClass("is-open");
        // Measure after filling, then keep it inside the pane.
        const width = this.tipEl.offsetWidth;
        const left = Math.min(
          Math.max(8, box.left - root.left + box.width / 2 - width / 2),
          Math.max(8, root.width - width - 8)
        );
        this.tipEl.style.left = `${left}px`;
        this.tipEl.style.top = `${box.bottom - root.top + 7}px`;
      }, 260);
    });
    el.addEventListener("mouseleave", () => {
      if (this.tipTimer) window.clearTimeout(this.tipTimer);
      this.tipEl.removeClass("is-open");
    });
  }

  // ------------------------------------------------------------ layer chips

  /**
   * One group: a pill that toggles everything inside it, plus a caret when
   * there is anything inside to look at.
   *
   * Three states rather than two. A group is `is-on` when every layer under it
   * is showing, `is-mixed` when some are, and plain when none are — because a
   * chip that reads "on" while two of its four layers are hidden is lying, and
   * that is precisely the failure the grouping would otherwise introduce.
   */
  private buildGroupChip(seg: HTMLElement, group: (typeof LAYER_GROUPS)[number]) {
    const chip = seg.createDiv({ cls: "strata-chip strata-group-chip" });
    chip.dataset.group = group.id;

    const main = chip.createEl("button", { cls: "strata-chip-main" });
    this.explain(main, group.hint);
    this.groupSwatch(main, group.layers);
    main.createSpan({ cls: "strata-chip-label", text: group.label });
    main.createSpan({ cls: "strata-count", text: "0" });

    main.onclick = (event) => {
      // Alt or Cmd/Ctrl solos, exactly as it did per-layer — looking at one
      // band of the graph alone is what this view is for, and getting there by
      // switching the other three off is three clicks in the way of it.
      if (event.altKey || event.metaKey || event.ctrlKey) {
        const alone =
          this.activeLayers.size === group.layers.length &&
          group.layers.every((id) => this.activeLayers.has(id));
        this.activeLayers = new Set(alone ? DEFAULT_LAYERS : group.layers);
        this.syncLayerChips();
        this.applyVisibility();
        this.runLayout(true);
        return;
      }
      // Anything short of fully on turns the whole group on. So the second
      // click after unfolding and hiding one layer restores the group rather
      // than clearing it, which is the direction you actually want.
      const all = group.layers.every((id) => this.activeLayers.has(id));
      for (const id of group.layers) {
        if (all) this.activeLayers.delete(id);
        else this.activeLayers.add(id);
      }
      this.syncLayerChips();
      this.applyVisibility();
    };
    main.onmouseenter = () => this.previewLayers(group.layers);
    main.onmouseleave = () => this.clearPreview();

    if (group.layers.length > 1) {
      const more = chip.createEl("button", { cls: "strata-chip-more" });
      more.setAttribute("aria-label", `Show the layers inside ${group.label}`);
      this.explain(more, `the ${group.layers.length} layers inside ${group.label}, one at a time`);
      more.onclick = () => {
        this.openGroup = this.openGroup === group.id ? null : group.id;
        this.syncSubRow();
        this.syncLayerChips();
      };
    }
  }

  /**
   * A group's line, drawn as its members' colours in bands.
   *
   * It is deliberately not four distinguishable swatches: at chip size that is
   * decoration pretending to be a key. The one thing it has to say is "this is
   * several lines, and roughly these colours" — the exact line belongs to the
   * per-layer chip you get by unfolding, where there is room to draw it
   * properly.
   */
  private groupSwatch(host: HTMLElement, ids: LayerId[]) {
    const swatch = host.createSpan({ cls: "strata-swatch is-line" });
    if (ids.length > 1) swatch.addClass("is-multi");
    this.paintGroupSwatch(swatch, ids);
  }

  /**
   * Paint a group's swatch from the layers that are *currently showing*, which
   * is what makes a half-on group readable at a glance: switch Bridges off and
   * Structure's line goes from four bands to three. A group with nothing on
   * falls back to all of its bands, so the chip still says what you would get
   * by turning it on.
   */
  private paintGroupSwatch(swatch: HTMLElement, all: LayerId[]) {
    const dark = isDark();
    const live = all.filter((id) => this.activeLayers.has(id));
    const ids = live.length ? live : all;
    swatch.removeClass("is-dashed");
    swatch.removeClass("is-dotted");
    if (all.length === 1) {
      swatch.style.color = tune(LAYER_COLOURS[ids[0]], dark);
      if (ids[0] === "resonance") swatch.addClass("is-dotted");
      else if (DASHED.has(ids[0])) swatch.addClass("is-dashed");
      return;
    }
    const step = 100 / ids.length;
    const stops = ids
      .map((id, i) => `${tune(LAYER_COLOURS[id], dark)} ${i * step}% ${(i + 1) * step}%`)
      .join(", ");
    swatch.style.backgroundImage = `linear-gradient(90deg, ${stops})`;
    if (ids.every((id) => DASHED.has(id))) swatch.addClass("is-dashed");
  }

  /** One layer, inside an unfolded group. The old chip, one row down. */
  private buildLayerChip(row: HTMLElement, id: LayerId) {
    const layer = LAYERS.find((l) => l.id === id);
    if (!layer) return;
    const chip = row.createEl("button", { cls: "strata-chip strata-layer-chip" });
    chip.dataset.layer = id;
    this.explain(chip, layer.hint);
    const swatch = chip.createSpan({ cls: "strata-swatch is-line" });
    swatch.style.color = tune(LAYER_COLOURS[id], isDark());
    if (id === "resonance") swatch.addClass("is-dotted");
    else if (DASHED.has(id)) swatch.addClass("is-dashed");
    chip.createSpan({ cls: "strata-chip-label", text: layer.label });
    chip.createSpan({ cls: "strata-count", text: "0" });
    chip.onclick = (event) => {
      if (event.altKey || event.metaKey || event.ctrlKey) {
        const alone = this.activeLayers.size === 1 && this.activeLayers.has(id);
        this.activeLayers = alone ? new Set(DEFAULT_LAYERS) : new Set([id]);
        this.syncLayerChips();
        this.applyVisibility();
        this.runLayout(true);
        return;
      }
      if (this.activeLayers.has(id)) this.activeLayers.delete(id);
      else this.activeLayers.add(id);
      this.syncLayerChips();
      this.applyVisibility();
    };
    chip.onmouseenter = () => this.previewLayers([id]);
    chip.onmouseleave = () => this.clearPreview();
  }

  private syncSubRow() {
    if (!this.subEl) return;
    this.subEl.empty();
    const group = LAYER_GROUPS.find((g) => g.id === this.openGroup);
    this.subEl.toggleClass("is-open", !!group);
    if (!group) return;
    for (const id of group.layers) this.buildLayerChip(this.subEl, id);
    this.syncLayerChips();
  }

  /**
   * The four ways the graph can be coloured, as the key's own last line.
   *
   * Hovering one previews it — every node is re-tinted and the rows above
   * change to match, with nothing committed until you click. That is cheap
   * here in a way it would not be in most graph tools: colour is a `tint` field
   * on node data read by one stylesheet rule, so a preview is one pass over a
   * few hundred nodes and no relayout at all. It makes "what does horizon even look
   * like" a question you answer by moving the mouse.
   *
   * The revert is deliberately not delayed while the preview is. A slow entry
   * stops the strip flickering as the cursor crosses it; a slow exit would let
   * you leave the graph painted in a mode you never chose.
   */
  private buildModes(host: HTMLElement) {
    for (const mode of MODE_ORDER) {
      const tab = host.createEl("button", { cls: "strata-key-mode", text: mode });
      this.modeEls.set(mode, tab);
      tab.onmouseenter = () => {
        if (mode === this.colourMode) return;
        if (this.modeTimer) window.clearTimeout(this.modeTimer);
        this.modeTimer = window.setTimeout(() => {
          this.previewMode = mode;
          this.applyColours(mode);
          this.drawKeyBody(mode);
        }, 90);
      };
      tab.onmouseleave = () => {
        if (this.modeTimer) window.clearTimeout(this.modeTimer);
        this.modeTimer = null;
        if (!this.previewMode) return;
        this.previewMode = null;
        this.applyColours();
        this.drawKeyBody(this.colourMode);
      };
      tab.onclick = () => {
        if (this.modeTimer) window.clearTimeout(this.modeTimer);
        this.modeTimer = null;
        this.previewMode = null;
        this.colourMode = mode;
        // A held filter belongs to the mode that made it. Switching used to
        // leave `origin = quote` dimming the whole graph with no row, no tab
        // and no off-switch anywhere on screen to explain it.
        this.markFilter = null;
        this.applyColours();
        this.applyMarkFilter();
        this.drawLegend();
      };
    }
  }

  private syncLayerChips() {
    for (const chip of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".strata-chip[data-layer]"))) {
      chip.toggleClass("is-on", this.activeLayers.has(chip.dataset.layer as LayerId));
    }
    for (const group of LAYER_GROUPS) {
      const chip = this.contentEl.querySelector<HTMLElement>(`.strata-chip[data-group="${group.id}"]`);
      if (!chip) continue;
      const on = group.layers.filter((id) => this.activeLayers.has(id)).length;
      chip.toggleClass("is-on", on === group.layers.length);
      chip.toggleClass("is-mixed", on > 0 && on < group.layers.length);
      chip.toggleClass("is-off", on === 0);
      chip.toggleClass("is-open", this.openGroup === group.id);
      const swatch = chip.querySelector<HTMLElement>(".strata-swatch");
      if (swatch) this.paintGroupSwatch(swatch, group.layers);
    }
    this.syncCounts();
  }

  /** Counts live on the chips, so they are re-read whenever the graph is. */
  private syncCounts() {
    if (!this.graph) return;
    const counts = layerCounts(this.graph);
    for (const chip of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".strata-chip[data-layer]"))) {
      const id = chip.dataset.layer as LayerId;
      chip.querySelector<HTMLElement>(".strata-count")?.setText(String(counts[id]));
    }
    for (const group of LAYER_GROUPS) {
      const chip = this.contentEl.querySelector<HTMLElement>(`.strata-chip[data-group="${group.id}"]`);
      // A half-on group counts what is actually drawn; a fully on or fully off
      // one counts everything it holds. So the number answers the question you
      // are asking of it either way — "how much of this is on screen" when
      // some of it is, "how much would I get" when none of it is.
      const live = group.layers.filter((id) => this.activeLayers.has(id));
      const shown = live.length && live.length < group.layers.length ? live : group.layers;
      const total = shown.reduce((sum, id) => sum + counts[id], 0);
      chip?.querySelector<HTMLElement>(".strata-count")?.setText(String(total));
    }
  }

  // ----------------------------------------------------------------- render

  private render() {
    this.dark = isDark();
    this.graph = buildGraph(this.app);

    // Sessions and suggestions are derived, not read: folded in after the vault
    // pass so the vault stays the single source of truth for everything real.
    const derived: { nodes: GNode[]; edges: GEdge[] } = { nodes: [], edges: [] };
    // A session's topics are computed at load from the notes it wrote, so a
    // conversation is reachable by subject and not only by similarity.
    for (const session of Object.values(this.plugin.data.linkedSessions)) {
      const id = `session:${session.id}`;
      const topicPaths = (session.topics ?? []).map((t) => `Topics/${t}.md`);
      derived.nodes.push({
        id,
        label: session.title,
        kind: "session",
        topicPaths,
        session: { project: session.project, at: session.at, provider: session.provider ?? "claude" },
      });
      for (const target of session.wrote) {
        derived.edges.push({ id: `sessions:${id}>${target}`, source: id, target, layer: "sessions" });
      }
      // On the topics layer, exactly like a note — so soloing Topics shows the
      // conversation sitting under the subjects it actually moved.
      for (const path of topicPaths) {
        if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
          derived.edges.push({ id: `topics:${id}>${path}`, source: id, target: path, layer: "topics" });
        }
      }
    }
    this.graph.nodes.push(...derived.nodes);
    this.graph.edges.push(...derived.edges);
    this.graph.edges.push(...suggestLinks(this.graph));

    // The model's half. Folded in after the schema's, and only ever additive:
    // resonance skips any pair the frontmatter already explains, so the two
    // halves never draw the same relation twice.
    if (this.plugin.index?.size) {
      this.graph.edges.push(
        ...this.plugin.index
          .edges(this.graph, this.plugin.data.semantic)
          .filter((e) => !this.plugin.isDismissed(e.source, e.target))
      );
    }

    // The vault next door. Its nodes are present but not native: they carry no
    // topics here and are never counted as this vault's orphans.
    if (this.foreign.nodes.length) {
      const localVault = this.app.vault.getName();
      this.graph.edges.push(
        ...bridgeEdges(this.graph.nodes, this.foreign.nodes, this.foreign.byKey, localVault),
        // The sibling's own structure. Without it the other vault arrived as
        // loose dots: most of them with no edge at all, parked in the orphan
        // ring, while nearly all named the project they serve in frontmatter
        // that nothing was reading.
        ...servesEdges(this.foreign.nodes, this.foreign.byName)
      );
      this.graph.nodes.push(...this.foreign.nodes);
    }

    this.settled = this.graphSettled();
    // Rebuilt every render, from the whole graph rather than the visible part:
    // `keepPosition` needs "has an edge at all", not "has one right now".
    this.connected = new Set<string>();
    for (const edge of this.graph.edges) {
      this.connected.add(edge.source);
      this.connected.add(edge.target);
    }

    this.syncCounts();
    // Asynchronous and deliberately not awaited: the button corrects itself a
    // moment after the graph is up, rather than the graph waiting on a count.
    void this.plugin.countStale().then(() => this.syncIndexButton());

    if (this.topicSelect) {
      const previous = this.topicFilter;
      this.topicSelect.empty();
      this.topicSelect.createEl("option", { value: "", text: "all" });
      for (const [path, name] of [...this.graph.topics].sort((a, b) => a[1].localeCompare(b[1]))) {
        this.topicSelect.createEl("option", { value: path, text: name });
      }
      this.topicSelect.value = this.graph.topics.has(previous) ? previous : "";
      this.topicFilter = this.topicSelect.value;
    }

    const seededCount = this.seedPositions();

    const degree = new Map<string, number>();
    for (const edge of this.graph.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const elements: ElementDefinition[] = [];
    for (const node of this.graph.nodes) {
      elements.push({
        data: {
          id: node.id,
          label: node.label.replace(/^note-/, ""),
          search: node.label.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(),
          kind: node.kind,
          origin: node.origin ?? "",
          captured: node.captured ?? "",
          topics: node.topicPaths,
          horizon: node.horizon ?? "",
          provider: node.session?.provider ?? "",
          foreign: node.foreign ?? "",
          degree: degree.get(node.id) ?? 0,
        },
        classes: node.foreign ? "is-foreign" : undefined,
        position: this.plugin.data.positions[node.id],
      });
    }
    for (const edge of this.graph.edges) {
      elements.push({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          layer: edge.layer,
          mutual: edge.mutual ? 1 : 0,
          similarity: edge.similarity ?? 0,
        },
        classes: edge.layer,
      });
    }

    this.cy?.destroy();
    this.cy = cytoscape({
      container: this.canvasEl,
      elements,
      // Without this cytoscape runs its own grid layout on init and throws away
      // the saved positions.
      layout: { name: "preset" },
      style: this.stylesheet(),
      wheelSensitivity: 0.18,
      minZoom: 0.06,
      maxZoom: 4,
    });

    this.bindInteractions();
    this.applyColours();
    this.applyVisibility();
    this.drawLegend();

    this.syncIndexButton();

    // Every node has a position by now, seeded if it had none. Fit to what is
    // actually shown: saved positions are graph coordinates, not screen ones,
    // so without this the graph can sit off in a corner of a resized pane.
    // A cold start gets a real layout.
    //
    // Seeding places a node next to its neighbours, which works for a handful of
    // new notes and fails completely for a whole vault: with nothing placed yet
    // there are no neighbours to sit beside, so everything falls through to the
    // ring — and a tight ring of a few hundred nodes put through the overlap
    // pass relaxes into a perfect lattice. That grid was never the layout's
    // doing; it was the absence of one.
    // A seed is a guess — "somewhere near your neighbours", or a ring when you
    // have none — so anything seeded gets relaxed rather than frozen. Freezing
    // it is how a sibling vault became a perfect circle a thousand pixels out:
    // its nodes arrived in one batch after the first layout, fell under
    // the threshold that would have re-run it, and their guesses were saved as
    // though they had been solved. The threshold now only decides whether to
    // start over or to settle what is already there.
    if (seededCount && this.settled) {
      this.runLayout(false, seededCount > this.graph.nodes.length * 0.3);
      this.drawLegend();
      return;
    }

    // Otherwise a few notes are new. One relaxation pass stops them landing
    // underneath something, and leaves everything already placed where it was.
    if (seededCount) this.separate(40);

    // Nothing else moves on a render.
    //
    // Unconnected nodes used to be re-parked here on every redraw, which is why
    // the graph rearranged itself when a layer was toggled. Where a node sits is
    // now decided once, by the simulation, and only Re-layout asks again.

    this.fitViewport();
  }

  private bindInteractions() {
    const cy = this.cy;
    if (!cy) return;

    cy.on("mouseover", "node", (e) => this.focus(e.target as NodeSingular));
    // Always. This used to re-focus the pinned node instead of clearing, and
    // since tapping a node both pins it *and* opens the note in a new tab, the
    // fade outlived the reason for it: click one note, come back, and every
    // node outside that one's neighbourhood is sitting at 7% opacity — which
    // reads as "the colours randomly stopped working", with no way back except
    // clicking empty canvas or pressing Escape, neither of which is signposted.
    //
    // The fade follows the mouse now. The card is the thing that persists,
    // which is the right division: the card is a place actions live, the fade
    // is only ever an answer to "what is this touching right now".
    cy.on("mouseout", "node", () => this.unfocus());
    // Cytoscape's mouseout is not reliable at the edge of the canvas: move the
    // pointer off a node and straight out of the pane — up to the toolbar, over
    // to the card, out of the window — and the event can simply not arrive, so
    // whatever was focused stays focused and the graph stays dimmed with no
    // node under the cursor to explain it. The DOM knows the pointer left even
    // when cytoscape does not, so ask the DOM.
    this.canvasEl.addEventListener("mouseleave", () => this.unfocus());

    cy.on("mouseover", "edge", (e) => {
      const edge = e.target as EdgeSingular;
      const layer = edge.data("layer") as LayerId;
      const sim = edge.data("similarity") as number;
      this.readoutEl.setText(
        `${edge.source().data("label")}  ${LAYER_MEANING[layer]}  ${edge.target().data("label")}` +
          (sim ? `   ${Math.round(sim * 100)}%` : "")
      );
    });
    cy.on("mouseout", "edge", () => this.readoutEl.setText(""));

    // A suggestion you cannot act on is just a complaint. Clicking one offers
    // to write the link, which is the only thing here that changes the vault.
    cy.on("tap", "edge.suggested", (e) => {
      this.pinned = null;
      this.showSuggestion(e.target as EdgeSingular);
    });

    cy.on("tap", "edge.resonance, edge.echo", (e) => {
      this.pinned = null;
      this.showSemantic(e.target as EdgeSingular);
    });

    // A click opens the thing. The card still comes up beside it, because the
    // card is where the actions live — but reaching a note should not cost a
    // click on the graph and then another on a button.
    cy.on("tap", "node", (e) => {
      const node = e.target as NodeSingular;
      // Shift-click joins this node to the one the card is open on. Two clicks
      // and a modifier is the whole gesture, which is the point: the graph is
      // where you notice that two notes belong together, and having to go and
      // find them both in an editor to say so is why it never got said.
      if (e.originalEvent && (e.originalEvent as MouseEvent).shiftKey && this.pinned && this.pinned !== node.id()) {
        void this.connect(this.pinned, node.id());
        return;
      }
      // Left-click opens the page and does nothing else.
      //
      // It used to open the card as well, which meant the card was drawn behind
      // a tab that had just taken the focus — every action on it went unread
      // because by the time it existed you were looking at a note. One gesture,
      // one result: read it here, or open it there.
      const id = node.id();
      if (id.startsWith("session:")) {
        const session = this.plugin.data.linkedSessions[id.replace(/^session:/, "")];
        if (session && !resumeSession(session)) {
          new Notice("That session's id does not look like an id — not running it.");
        }
        return;
      }
      this.openFile(id);
    });

    // Right-click is *inspect*: the card, and nothing opens.
    //
    // This is the gesture that makes the card worth designing at all. Everything
    // that acts on a page rather than reading it — linking, merging, splitting,
    // resuming a session — now has somewhere to live that is not competing with
    // an editor tab for the same click.
    cy.on("cxttap", "node", (e) => {
      const node = e.target as NodeSingular;
      this.pinned = node.id();
      this.showCard(node);
    });
    cy.on("cxttap", (e) => {
      if (e.target !== cy) return;
      // Closing the card has to disarm the pin with it, or shift-click stays
      // armed against a page that is no longer on screen anywhere.
      this.pinned = null;
      this.hideCard();
    });
    // Electron puts its own menu up on right-click and would cover the card
    // with a list of editor commands that mean nothing over a canvas.
    //
    // Bound to the stage, not the canvas. The card, the key and the findings
    // panel are *siblings* of the canvas inside it, and an open card takes
    // pointer events — so with the listener on the canvas alone, right-clicking
    // a node that happens to sit under the card's corner raised the editor
    // menu and no card appeared. The one exemption is a real text field, where
    // paste has to keep working.
    const stage = this.canvasEl.parentElement ?? this.canvasEl;
    stage.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      event.preventDefault();
    });

    // Left-click on empty canvas is the reset. Not "clears the pin" — the
    // reset: no focus, no query, no card, and the colours re-asserted. It is
    // the one gesture that should always be safe to reach for when the graph
    // looks wrong, so it puts everything back rather than only the one thing
    // the click happened to be about.
    cy.on("tap", (e) => {
      if (e.target !== cy) return;
      this.pinned = null;
      this.markFilter = null;
      this.drawLegend();
      this.clearQuery();
      this.unfocus();
      this.hideCard();
      this.applyColours();
      this.applyVisibility();
    });

    cy.on("dragfree", "node", (e) => {
      const node = e.target as NodeSingular;
      this.plugin.data.positions[node.id()] = { ...node.position() };
      this.plugin.queueSave();
    });

    cy.on("zoom", debounce(() => this.applyLabelPolicy(), 120, true));
  }

  private stylesheet(): cytoscape.StylesheetJson {
    const css = getComputedStyle(document.body);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    // A pale line on charcoal disappears where the same line on white reads fine.
    const lift = this.dark ? 1.45 : 1;
    const o = (base: number) => Math.min(1, base * lift);
    const label = v("--text-muted", "#8a8f94");
    const bg = v("--background-primary", "#ffffff");

    const style = [
      {
        selector: "node",
        style: {
          width: "mapData(degree, 0, 24, 10, 32)",
          height: "mapData(degree, 0, 24, 10, 32)",
          "background-color": NEUTRAL,
          "border-width": 0,
          label: "data(label)",
          color: label,
          "font-family": "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
          "font-size": 9,
          "font-weight": 450,
          "text-valign": "bottom",
          "text-margin-y": 4,
          "text-opacity": 0,
          "text-max-width": 130,
          "text-wrap": "ellipsis",
          "overlay-opacity": 0,
          "transition-property": "opacity, text-opacity, background-color",
          "transition-duration": 140,
        },
      },
      {
        selector: 'node[kind = "topic"]',
        style: {
          "border-width": 2,
          "border-color": this.col(LAYER_COLOURS.topics),
          "background-color": bg,
          "background-opacity": 0.9,
          "font-weight": 600,
          "font-size": 10,
        },
      },
      // Colour is read from the node's own data, and that is the whole point.
      //
      // It used to be a per-node style bypass set by `applyColours`. Cytoscape
      // drops bypasses when a `cy.batch()` flushes — the comment on
      // `applyColours` already says so, but only about its own batch. Every
      // other batch in this file wipes them too, and `focus()` is a batch. So
      // hovering a single node discarded the background colour of every node, the
      // stylesheet's NEUTRAL grey showed through, and nothing put it back until
      // the next full render. That is the "nodes go grey and stay grey" bug,
      // and no amount of tuning the fade opacity was ever going to fix it.
      //
      // Data survives batches. It is also declarative, which means the colour
      // cannot get out of step with the legend again.
      //
      // Placed before the topic/session/provider rules so those still win —
      // they set their own background and `applyColours` never gives them a
      // tint to begin with.
      { selector: "node[tint]", style: { "background-color": "data(tint)" } },
      { selector: 'node[kind = "source"]', style: { shape: "round-rectangle" } },
      // A session is an event, not a thing, so it gets its own silhouette.
      {
        selector: 'node[kind = "session"]',
        style: {
          shape: "ellipse",
          "background-color": this.col(KIND_COLOURS.session),
          width: 22,
          height: 22,
        },
      },
      // The mark is how a session node says which assistant it was, without
      // spending a label on it.
      //
      // `background-fit: none` was the bug. It draws the image at the given
      // size and pins it to the node's top-left, so every session node was a
      // coloured disc with a white glyph stuck in the corner — which at any
      // distance reads as a flag rather than as a logo. `contain` scales the
      // glyph to the node and centres it, and the padding that keeps it off
      // the rim now lives inside each SVG's own viewBox where it belongs.
      {
        selector: 'node[provider = "claude"]',
        style: {
          "background-color": this.col(PROVIDER_COLOURS.claude),
          "background-image": providerMark("claude"),
          "background-fit": "contain",
        },
      },
      {
        selector: 'node[provider = "gemini"]',
        style: {
          "background-color": this.col(PROVIDER_COLOURS.gemini),
          "background-image": providerMark("gemini"),
          "background-fit": "contain",
        },
      },
      {
        selector: 'node[provider = "chatgpt"]',
        style: {
          "background-color": this.col(PROVIDER_COLOURS.chatgpt),
          "background-image": providerMark("chatgpt"),
          "background-fit": "contain",
        },
      },
      // A node from the other vault is present but visibly not from here: an
      // outline rather than a fill, so the eye never mistakes it for local.
      {
        selector: "node.is-foreign",
        style: {
          "background-opacity": 0.12,
          "border-width": 1.6,
          "border-color": this.col(LAYER_COLOURS.bridges),
          "border-style": "dashed",
        },
      },
      { selector: "node.strata-label", style: { "text-opacity": 1 } },
      { selector: "node.strata-focus", style: { "text-opacity": 1, "font-weight": 600, "z-index": 20 } },
      { selector: "node.strata-match", style: { "text-opacity": 1, "border-width": 2, "border-color": v("--text-accent", "#c9784a") } },
      { selector: "node:selected", style: { "border-width": 2.5, "border-color": v("--text-accent", "#c9784a") } },
      {
        selector: "edge",
        style: {
          width: 0.8,
          "line-color": this.col(NEUTRAL),
          "curve-style": "bezier",
          "control-point-step-size": 28,
          opacity: o(0.28),
          "overlay-opacity": 0,
          "transition-property": "opacity, width",
          "transition-duration": 140,
        },
      },
      { selector: "edge.topics", style: { "line-color": this.col(LAYER_COLOURS.topics), opacity: o(0.2) } },
      { selector: "edge.source", style: { "line-color": this.col(LAYER_COLOURS.source), opacity: o(0.22) } },
      { selector: "edge.hierarchy", style: { "line-color": this.col(LAYER_COLOURS.hierarchy), width: 1.4, opacity: o(0.5) } },
      { selector: "edge.links", style: { "line-color": this.col(LAYER_COLOURS.links), width: 1.1, opacity: o(0.6) } },
      { selector: "edge.links[?mutual]", style: { width: 2, opacity: o(0.85) } },
      { selector: "edge.sessions", style: { "line-color": this.col(LAYER_COLOURS.sessions), width: 1, opacity: o(0.4) } },
      { selector: "edge.bridges", style: { "line-color": this.col(LAYER_COLOURS.bridges), width: 1.8, opacity: o(0.8) } },
      // Dashed, because a suggestion is not a fact about the vault yet.
      {
        selector: "edge.suggested",
        style: {
          "line-color": this.col(LAYER_COLOURS.suggested),
          "line-style": "dashed",
          "line-dash-pattern": [3, 4],
          width: 1,
          opacity: o(0.45),
        },
      },
      // Dotted rather than dashed: the model's proposals should never be
      // mistaken at a glance for something the schema can prove. Width tracks
      // similarity, so a strong claim looks like one.
      {
        selector: "edge.resonance",
        style: {
          "line-color": this.col(LAYER_COLOURS.resonance),
          "line-style": "dotted",
          width: "mapData(similarity, 0.7, 0.88, 0.9, 2.2)",
          opacity: o(0.55),
        },
      },
      {
        selector: "edge.echo",
        style: {
          "line-color": this.col(LAYER_COLOURS.echo),
          "line-style": "dashed",
          "line-dash-pattern": [2, 2],
          width: 2.2,
          opacity: o(0.75),
        },
      },
      { selector: "edge.strata-focus", style: { opacity: 0.95, width: 1.8, "z-index": 20 } },
      { selector: "node.strata-lonely", style: { opacity: 0.3 } },
      // Nodes and edges recede by different amounts, and that split is the
      // whole fix. One opacity for both meant the only value that made a
      // neighbourhood stand out also drained the colour out of every node on
      // screen — first at 0.07, which was invisible, then at 0.3, which on a
      // light background still reads as grey rather than as a dimmer colour.
      //
      // What actually makes a neighbourhood legible is the *edges* dropping
      // away, not the nodes. So the edges go far down and the nodes barely
      // move: the graph keeps its colour, and the thing under the cursor still
      // wins because everything joining it is the only line left with weight.
      { selector: "node.strata-faded", style: { opacity: FADE, "text-opacity": 0 } },
      { selector: "edge.strata-faded", style: { opacity: FADE_EDGE } },
      { selector: ".strata-hidden", style: { display: "none" } },
    ];

    return style as unknown as cytoscape.StylesheetJson;
  }

  // ------------------------------------------------------------- legibility

  /**
   * Give every new node somewhere to be.
   *
   * A node with no saved position is created at the origin, so the first open
   * after a batch of notes arrives puts all of them in one stack in the corner —
   * which is the "doesn't work when it loads" symptom exactly. Seeding them next
   * to whatever they are attached to costs nothing and keeps the arrangement
   * that was already there, which a full re-layout would throw away.
   */
  private seedPositions(): number {
    const graph = this.graph;
    if (!graph) return 0;
    const saved = this.plugin.data.positions;
    let missing = graph.nodes.filter((n) => !saved[n.id]);
    const total = missing.length;
    if (!total) return 0;

    const near = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = near.get(a);
      if (list) list.push(b);
      else near.set(a, [b]);
    };
    for (const edge of graph.edges) {
      link(edge.source, edge.target);
      link(edge.target, edge.source);
    }

    const known = Object.values(saved);
    const cx = known.length ? known.reduce((t, p) => t + p.x, 0) / known.length : 0;
    const cy = known.length ? known.reduce((t, p) => t + p.y, 0) / known.length : 0;
    // The 90th percentile, not the maximum. With the maximum, one node already
    // sitting in the outer ring sets where the next ring starts — so every
    // batch of unattached arrivals lands further out than the last, and the
    // band ratchets away from the graph a little at a time.
    const spread = known.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b);
    const span = spread.length ? Math.max(400, spread[Math.floor(spread.length * 0.9)]) : 400;

    // Several passes, so a new note attached only to other new notes still ends
    // up somewhere sensible once its neighbours have been placed.
    for (let pass = 0; pass < 3 && missing.length; pass++) {
      const still: typeof missing = [];
      for (const node of missing) {
        const anchors = (near.get(node.id) ?? []).map((id) => saved[id]).filter(Boolean);
        if (!anchors.length) {
          still.push(node);
          continue;
        }
        const ax = anchors.reduce((t, p) => t + p.x, 0) / anchors.length;
        const ay = anchors.reduce((t, p) => t + p.y, 0) / anchors.length;
        // Golden-angle offset: deterministic, and it never stacks two seeds.
        const a = (Object.keys(saved).length * 2.399963) % (Math.PI * 2);
        saved[node.id] = { x: ax + Math.cos(a) * 55, y: ay + Math.sin(a) * 55 };
      }
      missing = still;
    }

    // Whatever is left is genuinely unattached. Scattered through the band
    // outside the graph, with the outer edge solved from the count — a fixed
    // ring packs tighter the more nodes it holds, and a tight ring put through
    // the overlap pass is exactly how the lattice appeared.
    if (missing.length) {
      const inner = span + 140;
      const outer = Math.sqrt(inner * inner + (missing.length * 115 * 115) / Math.PI);
      const golden = Math.PI * (3 - Math.sqrt(5));
      missing.forEach((node, i) => {
        const t = (i + 0.5) / missing.length;
        const r = Math.sqrt(inner * inner + t * (outer * outer - inner * inner));
        saved[node.id] = { x: cx + Math.cos(i * golden) * r, y: cy + Math.sin(i * golden) * r };
      });
    }
    this.plugin.queueSave();
    return total;
  }

  /** One hue, adjusted for the ground it is being drawn on. */
  private col(hex: string): string {
    return tune(hex, this.dark);
  }

  /** Edges of a node that are actually on screen right now. */
  private liveEdges(node: NodeSingular) {
    return node.connectedEdges().filter((e) => !e.hasClass("strata-hidden"));
  }

  /**
   * May this node's position be written to disk?
   *
   * Two populations end up parked and they are not the same thing, which is the
   * distinction `park` exists to draw. A node with no edges *anywhere* is a fact
   * about the vault: its ring position is as good as any, and keeping it is what
   * stops the orphans reshuffling every time the plugin loads. A node whose
   * edges are merely on a switched-off layer is parked because of what is on
   * screen right now — remember that and it is stranded a thousand pixels out,
   * edges stretched back to the core, the moment the layer comes on again.
   *
   * This was already guarded in two of the three places that save coordinates,
   * which is worth exactly nothing: the third saved every node unconditionally,
   * so a single new note was enough to make every parked position permanent.
   * One predicate, so the next place that saves a position cannot get it wrong
   * on its own.
   */
  /**
   * Has Obsidian finished reading the vault?
   *
   * `resolvedLinks` gains an entry per markdown file as the cache resolves
   * them, so covering every file is a direct test rather than a timer or a
   * guess at an event ordering. It is the difference between a graph and a
   * graph that is still arriving: everything below refuses to write a position
   * until this is true, because a *partial* graph is the dangerous case — an
   * empty one is obvious, while one holding a fraction of its edges looks
   * exactly like a real graph whose nodes happen to be unconnected, and gets
   * believed.
   */
  private graphSettled(): boolean {
    const files = this.app.vault.getMarkdownFiles().length;
    return files > 0 && Object.keys(this.app.metadataCache.resolvedLinks).length >= files;
  }

  private keepPosition(node: NodeSingular): boolean {
    if (!this.settled) return false;
    // A graph with nodes and *no edges at all* is not a vault with nothing
    // linked — it is Obsidian's metadata cache mid-rebuild, which happens on
    // every cold start and takes a few seconds. Watched live the edge count
    // climbs, collapses to zero, and refills as the cache settles. During the
    // empty window every node looks like a genuine orphan, so the rule below
    // waves the whole parked ring through and it lands on disk over every real
    // coordinate. Measured after exactly that: the median radius roughly
    // doubles.
    return !this.connected.has(node.id()) || this.liveEdges(node).length > 0;
  }

  /**
   * Labels are earned. Below the zoom threshold only hubs are named, and nothing
   * with no visible edge is ever named — otherwise soloing a layer leaves a field
   * of labelled dots connected to nothing, which is exactly the noise that made
   * the hierarchy view unreadable.
   */
  private applyLabelPolicy() {
    const cy = this.cy;
    if (!cy) return;
    const zoomed = cy.zoom() >= LABEL_ZOOM;

    const live = new Map<string, number>();
    cy.edges().forEach((e) => {
      if (e.hasClass("strata-hidden")) return;
      live.set(e.source().id(), (live.get(e.source().id()) ?? 0) + 1);
      live.set(e.target().id(), (live.get(e.target().id()) ?? 0) + 1);
    });

    // When a layer is sparse, the top-15%-by-degree rule names almost nothing:
    // soloing Echo gives every node a degree of one or two, the cutoff floors at
    // three, and the result is a scatter of edges joining unlabelled dots.
    // Few enough nodes to read means: label them all and let collision decide.
    const degrees = [...live.values()].sort((a, b) => b - a);
    const sparse = live.size <= 60;
    const cutoff = zoomed || sparse ? 1 : Math.max(3, degrees[Math.floor(degrees.length * 0.15)] ?? 3);

    // Earning a label is necessary but not sufficient: it also has to fit.
    //
    // Zooming in used to drop the degree cutoff to 1, which meant every node in
    // view claimed a label at once and they printed straight over each other —
    // the single biggest reason the graph read as noise. So candidates are
    // sorted by importance and laid down greedily, and any label whose box would
    // collide with one already placed is simply not drawn. Nothing is lost:
    // hovering still names anything, and zooming further makes room.
    const zoom = cy.zoom();
    const pane = this.canvasEl.getBoundingClientRect();
    const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const fits = (box: { x1: number; y1: number; x2: number; y2: number }) => {
      for (const p of placed) {
        if (box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1) return false;
      }
      return true;
    };

    const candidates: NodeSingular[] = cy
      .nodes()
      .filter((n) => !n.hasClass("strata-hidden") && (live.get(n.id()) ?? 0) > 0)
      .toArray() as NodeSingular[];
    candidates.sort((a, b) => {
        // Topics first: they are the map's place names, and losing one costs
        // more orientation than losing any single note.
      const ta = a.data("kind") === "topic" ? 1 : 0;
      const tb = b.data("kind") === "topic" ? 1 : 0;
      if (ta !== tb) return tb - ta;
      return (live.get(b.id()) ?? 0) - (live.get(a.id()) ?? 0);
    });

    const named = new Set<string>();
    for (const n of candidates) {
      const d = live.get(n.id()) ?? 0;
      if (!(zoomed || d >= cutoff || n.data("kind") === "topic")) continue;

      const p = n.renderedPosition();
      const size = (n.data("kind") === "topic" ? 10 : 9) * zoom;
      const text = String(n.data("label") ?? "");
      const width = Math.min(130 * zoom, text.length * size * 0.55);
      const top = p.y + (n.renderedHeight() / 2) + 4 * zoom;
      // Offscreen labels cost nothing to skip and would otherwise reserve space
      // that on-screen ones need.
      if (p.x < -200 || p.y < -200 || p.x > pane.width + 200 || p.y > pane.height + 200) continue;

      const box = { x1: p.x - width / 2 - 2, y1: top - 1, x2: p.x + width / 2 + 2, y2: top + size * 1.25 + 1 };
      if (!fits(box)) continue;
      placed.push(box);
      named.add(n.id());
    }

    cy.batch(() => {
      cy.nodes().forEach((n) => {
        n.toggleClass("strata-label", named.has(n.id()));
      });
    });
  }

  /** Hover anything and everything unrelated recedes — following visible edges only. */
  private focus(node: NodeSingular) {
    const cy = this.cy;
    if (!cy) return;
    const edges = this.liveEdges(node);

    // A node with nothing visible attached has no neighbourhood to focus on, and
    // fading everything else leaves a grey field with one dot in it — which is
    // what soloing Echo and then clicking a note that has no echoes did. There
    // is nothing to recede *from*, so nothing recedes.
    if (edges.empty()) {
      cy.batch(() => {
        cy.elements().removeClass("strata-faded").removeClass("strata-focus");
        node.addClass("strata-focus");
      });
      return;
    }

    const near = edges.union(edges.connectedNodes()).union(node);
    cy.batch(() => {
      cy.elements().difference(near).addClass("strata-faded").removeClass("strata-focus");
      near.removeClass("strata-faded").addClass("strata-focus");
    });
  }

  private unfocus() {
    this.cy?.batch(() => {
      this.cy?.elements().removeClass("strata-faded").removeClass("strata-focus");
    });
    // Both of these dim things, and both have to survive a hover — otherwise
    // moving the mouse across the canvas silently cancels a filter you set on
    // purpose, which is the same class of bug as the sticky fade, inverted.
    this.applyQueryHighlight();
    if (this.markFilter) this.applyMarkFilter();
  }

  /** Hovering a chip previews what it controls alone, nodes included. */
  private previewLayers(layers: LayerId[]) {
    const cy = this.cy;
    if (!cy) return;
    const selector = layers.map((l) => `.${l}`).join(", ");
    const edges = cy.edges(selector).filter((e) => !e.hasClass("strata-hidden"));
    const near = edges.union(edges.connectedNodes());
    cy.batch(() => {
      cy.elements().difference(near).addClass("strata-faded");
      near.removeClass("strata-faded").addClass("strata-focus");
    });
  }

  private clearPreview() {
    this.unfocus();
  }

  /**
   * Highlight what the Find box matches — and, just as importantly, get out of
   * the way when it matches nothing.
   *
   * Two bugs lived here, and between them they made the graph look broken.
   *
   * Clearing the box removed `strata-match` and left `strata-faded` on every
   * element. `.strata-faded` also sets `text-opacity: 0`, so the whole graph
   * stayed washed out *with no labels at all* until something else happened to
   * clear it — hovering a node was the only route back, and nothing tells you
   * that. Search once, clear it, and the view is dimmed for the rest of the
   * session.
   *
   * And a query matching nothing faded everything too, which renders exactly
   * the same as "what you searched for is not in here". Typing a name and
   * watching the graph go blank is indistinguishable from being told the thing
   * does not exist — so it gets read as an answer, and it is not one.
   */
  /**
   * Ask the index what the query is *about*.
   *
   * The Find box matched `label.includes(query)` against filenames and nothing
   * else — so Strata shipped with a multi-megabyte semantic index and a search
   * bar that could not reach it. Typing a phrase that appears inside a note but
   * not in its filename found nothing, while the same query through the MCP
   * server returned the right passage. Two search systems in one product, and the one with a UI
   * was the substring one.
   *
   * Both run now. The substring pass is synchronous and stays instant, because
   * "which node is called X" is a real question with an immediate answer. The
   * semantic pass needs an embedding call, so it lands a moment later and
   * widens the same highlight rather than replacing it.
   */
  private async runSemantic(): Promise<void> {
    const query = this.query;
    if (query.length < 3) {
      this.semantic = [];
      this.semanticFor = "";
      this.semanticNote = "";
      return this.drawResults();
    }
    if (query === this.semanticFor) return;

    const index = this.plugin.index;
    if (!index?.size) {
      this.semanticNote = 'Nothing read yet — press "Re-read" to let the local model index the vault.';
      return this.drawResults();
    }

    // Every keystroke starts a pass; only the newest is allowed to answer.
    const run = ++this.semanticRun;
    this.semanticNote = "Thinking…";
    this.drawResults();
    try {
      const hits = await index.nearest(query, this.plugin.data.semantic, 8);
      if (run !== this.semanticRun || query !== this.query) return;
      this.semantic = hits.filter((h) => h.score >= 0.6);
      this.semanticFor = query;
      this.semanticNote = this.semantic.length ? "" : "Nothing in the vault is about that.";
    } catch {
      if (run !== this.semanticRun) return;
      this.semantic = [];
      this.semanticNote = "Ollama is not answering, so this is titles only.";
    }
    this.applyQueryHighlight();
    this.drawResults();
  }

  /** The ranked list under the box. A highlight in a graph this size is a hunt. */
  private drawResults(): void {
    const host = this.resultsEl;
    if (!host) return;
    host.empty();
    // Both are right-hand overlays, and the results were landing on top of the
    // Findings panel. They are also two different jobs — searching and working
    // a queue — so the one you just opened wins rather than them stacking.
    if (this.findings.visible) return void host.removeClass("is-open");
    if (!this.query) return void host.removeClass("is-open");
    if (!this.semantic.length && !this.semanticNote) return void host.removeClass("is-open");
    host.addClass("is-open");

    if (this.semanticNote) host.createDiv({ cls: "strata-result-note", text: this.semanticNote });
    for (const hit of this.semantic) {
      const row = host.createDiv({ cls: "strata-result" });
      const head = row.createDiv({ cls: "strata-result-head" });
      head.createSpan({ cls: "strata-result-name", text: this.label(hit.path) });
      if (hit.heading) head.createSpan({ cls: "strata-result-heading", text: hit.heading });
      head.createSpan({ cls: "strata-result-score", text: String(Math.round(hit.score * 100)) });
      row.createDiv({ cls: "strata-result-preview", text: hit.preview });
      row.onclick = () => {
        const node = this.cy?.getElementById(hit.path);
        if (node?.nonempty()) {
          this.cy?.animate({ center: { eles: node }, zoom: 1.4, duration: 260 });
          this.showCard(node as NodeSingular);
        }
        this.openAt(hit.path, hit.heading);
      };
    }
  }

  private label(path: string): string {
    return (
      (this.graph?.nodes.find((n) => n.id === path)?.label ?? path.split("/").pop() ?? path)
        .replace(/\.md$/, "")
        .replace(/^note-/, "")
    );
  }

  private applyQueryHighlight() {
    const cy = this.cy;
    if (!cy) return;
    if (!this.query) {
      cy.elements().removeClass("strata-faded");
      cy.nodes().removeClass("strata-match");
      this.searchEl?.removeClass("is-no-match");
      this.clearEl?.removeClass("is-on");
      return;
    }
    // `-` and `_` are separators in a filename and spaces in a name. Matching
    // across both means "jane smith" finds the source page *and* the notes
    // called note-some-long-article, which is what typing a person's name is
    // asking for.
    const needle = this.query.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    const semantic = new Set(this.semantic.map((h) => h.path));
    const matches = cy
      .nodes()
      .filter((n) => semantic.has(n.id()) || (n.data("search") as string).includes(needle));
    cy.batch(() => {
      cy.nodes().removeClass("strata-match");
      if (matches.empty()) {
        cy.elements().removeClass("strata-faded");
        return;
      }
      matches.addClass("strata-match");
      cy.elements().addClass("strata-faded");
      matches.union(matches.connectedEdges()).removeClass("strata-faded");
    });
    // The box itself carries the "nothing" answer, so the graph does not have
    // to say it by going blank.
    this.searchEl?.toggleClass("is-no-match", matches.empty());
    this.clearEl?.toggleClass("is-on", true);
  }

  /** One way to drop the query, so the box, Escape and the × cannot disagree. */
  private clearQuery(): void {
    this.query = "";
    this.semantic = [];
    this.semanticFor = "";
    this.semanticNote = "";
    this.semanticRun++;
    if (this.searchEl) this.searchEl.value = "";
    this.applyQueryHighlight();
    this.drawResults();
  }

  private fitToMatches() {
    const cy = this.cy;
    if (!cy || !this.query) return;
    const matches = cy.nodes(".strata-match").filter((n) => !n.hasClass("strata-hidden"));
    if (matches.nonempty()) cy.animate({ fit: { eles: matches, padding: 120 }, duration: 320 });
  }

  private applyColours(mode: ColourMode = this.colourMode) {
    const cy = this.cy;
    if (!cy) return;
    const now = Date.now();
    // Writes `tint` into each node's data; the stylesheet's `node[tint]` rule
    // reads it. This used to set a style bypass instead, which a batch discards
    // — see that rule for why that was the grey-nodes bug. Data is safe inside
    // or outside a batch, so this no longer has to care.
    cy.nodes().forEach((node) => {
      const kind = node.data("kind");
      if (kind === "topic" || kind === "session") return; // both carry their own identity
      if (node.data("foreign")) return; // the other vault reads as an outline
      let colour: string;
      if (mode === "kind") colour = this.col(KIND_COLOURS[kind] ?? KIND_COLOURS.other);
      else if (mode === "origin") colour = this.col(ORIGIN_COLOURS[node.data("origin") as string] ?? NEUTRAL);
      else if (mode === "horizon")
        colour = this.col(HORIZON_COLOURS[node.data("horizon") as string] ?? NEUTRAL);
      else colour = recencyColour(node.data("captured") as string, now, this.dark);
      node.data("tint", colour);
    });
  }

  private applyVisibility() {
    const cy = this.cy;
    if (!cy || !this.graph) return;
    const within = this.topicFilter ? this.graph.descendants.get(this.topicFilter) ?? new Set([this.topicFilter]) : null;

    cy.batch(() => {
      cy.edges().forEach((edge) => {
        edge.toggleClass("strata-hidden", !this.activeLayers.has(edge.data("layer") as LayerId));
      });

      if (within) {
        cy.nodes().forEach((node) => {
          const topics = (node.data("topics") as string[]) ?? [];
          const keep = within.has(node.id()) || topics.some((t) => within.has(t));
          node.toggleClass("strata-hidden", !keep);
        });
        cy.edges().forEach((edge) => {
          if (edge.source().hasClass("strata-hidden") || edge.target().hasClass("strata-hidden")) {
            edge.addClass("strata-hidden");
          }
        });
      } else {
        cy.nodes().removeClass("strata-hidden");
      }

      if (this.kindFilter || this.horizonFilter) {
        cy.nodes().forEach((node) => {
          if (node.hasClass("strata-hidden")) return;
          const kindOk = !this.kindFilter || node.data("kind") === this.kindFilter;
          const h = node.data("horizon") as string;
          const horizonOk =
            !this.horizonFilter ||
            (this.horizonFilter === "unset" ? !h && node.data("kind") === "note" : h === this.horizonFilter);
          node.toggleClass("strata-hidden", !(kindOk && horizonOk));
        });
        cy.edges().forEach((edge) => {
          if (edge.source().hasClass("strata-hidden") || edge.target().hasClass("strata-hidden")) {
            edge.addClass("strata-hidden");
          }
        });
      }

      if (this.hideIsolated) {
        cy.nodes().forEach((node) => {
          if (node.hasClass("strata-hidden")) return;
          if (this.liveEdges(node).length === 0) node.addClass("strata-hidden");
        });
      }

      // Present but not participating. Soloing a layer leaves a field of dots
      // that belong to no visible relation, and at full strength they drown the
      // handful of edges you actually asked to see.
      cy.nodes().forEach((node) => {
        node.toggleClass(
          "strata-lonely",
          !node.hasClass("strata-hidden") && this.liveEdges(node).length === 0
        );
      });
    });

    this.applyLabelPolicy();
    this.applyQueryHighlight();

    const nodes = cy.nodes().filter((n) => !n.hasClass("strata-hidden")).length;
    const edges = cy.edges().filter((e) => !e.hasClass("strata-hidden")).length;
    const orphans = cy.nodes().filter((n) => !n.hasClass("strata-hidden") && this.liveEdges(n).length === 0).length;
    const bits = [`${nodes} nodes`, `${edges} edges`, `${orphans} unconnected`];
    const linked = Object.keys(this.plugin.data.linkedSessions).length;
    if (linked) bits.push(`${linked} session${linked === 1 ? "" : "s"}`);
    this.statusEl.setText(bits.join(" · "));
  }

  /**
   * The legend describes *this* graph, not the schema.
   *
   * The first version listed every value the schema allows, which meant it
   * confidently named origins no note in the vault actually uses, and did it in
   * a bare column of text floating over the canvas with nothing to say which
   * half was edges and which was colour. A legend that lists things that are not
   * on screen is worse than no legend: it is a claim the picture contradicts.
   *
   * So: only what is actually drawn, counted, grouped, and quiet until looked at.
   */
  /**
   * The key: what the colours mean, and the switch for what they mean.
   *
   * The old one was nine rows of 11px text inside a container at `opacity:
   * 0.62`, headed by the name of a frontmatter field. Three faults, and the
   * opacity was the mechanical one — it faded the labels you have to read by
   * exactly as much as the chrome that should recede, and the per-element
   * tokens underneath (`--text-normal 26%`) then faded them again, landing the
   * counts somewhere near 16% contrast. Nothing was heavy, so the eye had
   * nowhere to land, and the honest verdict was "this just looks bad".
   *
   * What replaces it: a question instead of a field name, at most five rows of
   * real colour, everything that is not a note demoted to one wrapped line,
   * and the four colour modes as a strip you can hover to preview. Recession
   * comes from size and from the theme's own faint token — never from fading
   * the whole block.
   */
  private drawLegend() {
    this.drawKeyBody(this.previewMode ?? this.colourMode);
    for (const [mode, el] of this.modeEls) el.toggleClass("is-on", mode === this.colourMode);
  }

  /** The head says what question the colours are answering right now. */
  private drawKeyHead(mode: ColourMode) {
    this.keyHeadEl.empty();
    const filter = this.markFilter;
    if (!filter) {
      this.keyHeadEl.createSpan({ text: MODE_QUESTION[mode] });
      return;
    }
    // A filter dims the entire graph. The only way out of it used to be
    // clicking empty canvas, which is a full reset and is not signposted
    // either — so it gets a name and an off-switch where it was switched on.
    this.keyHeadEl.createSpan({ cls: "strata-key-held", text: this.markLabel(filter) });
    const off = this.keyHeadEl.createEl("button", { cls: "strata-key-clear", text: "×" });
    off.setAttribute("aria-label", "Show everything again");
    off.onclick = () => {
      this.markFilter = null;
      this.drawLegend();
      this.applyMarkFilter();
    };
  }

  private markLabel(filter: MarkFilter): string {
    if (filter.field === "foreign") return "the Work vault";
    if (filter.field === "kind") return KIND_LABEL[filter.value] ?? filter.value;
    if (!filter.value) return filter.field === "horizon" ? "not yet decided" : "not set";
    const meaning = filter.field === "horizon" ? HORIZON_MEANING : ORIGIN_MEANING;
    return meaning[filter.value] ?? filter.value;
  }

  private drawKeyBody(mode: ColourMode) {
    this.drawKeyHead(mode);
    const body = this.keyBodyEl;
    body.empty();

    const row = (parent: HTMLElement, text: string, count: number, filter: MarkFilter) => {
      const el = parent.createDiv({ cls: "strata-key-row is-pick" });
      const mark = el.createSpan({ cls: "strata-key-mark" });
      el.createSpan({ cls: "strata-key-label", text });
      el.createSpan({ cls: "strata-key-count", text: String(count) });
      const on = this.markFilter?.field === filter.field && this.markFilter?.value === filter.value;
      el.toggleClass("is-on", on);
      el.onclick = () => {
        this.markFilter = on ? null : filter;
        this.drawLegend();
        this.applyMarkFilter();
      };
      // The head doubles as the read-out, so naming a row costs no extra line.
      el.onmouseenter = () => {
        if (!this.markFilter) this.keyHeadEl.setText(`${text} · ${count}`);
        this.previewMark(filter);
      };
      el.onmouseleave = () => {
        if (!this.markFilter) this.drawKeyHead(mode);
        this.clearPreview();
      };
      return mark;
    };

    if (mode === "recency") {
      // A date is continuous, so it gets a ramp and not invented buckets —
      // "this quarter 30" would be a lie about what the colour encodes. The
      // gradient is painted from `recencyColour` itself rather than from
      // hard-coded stops, which is also a fix: the stops in the stylesheet
      // were the light-theme values and stayed wrong in the dark one.
      const now = Date.now();
      const ramp = body.createDiv({ cls: "strata-key-ramp" });
      const bar = ramp.createSpan({ cls: "strata-key-gradient" });
      const stops = [0, 4, 8, 12]
        .map((months) => recencyColour(new Date(now - months * 30 * 864e5).toISOString().slice(0, 10), now, this.dark))
        .join(", ");
      bar.style.background = `linear-gradient(90deg, ${stops})`;
      const ends = ramp.createDiv({ cls: "strata-key-ends" });
      ends.createSpan({ text: "this month" });
      ends.createSpan({ text: "6 months" });
      ends.createSpan({ text: "a year +" });
    } else {
      // Count what is present rather than listing what is permitted, and keep
      // "unset" — those nodes render neutral grey and a key that omits them
      // leaves part of the picture unexplained.
      const key = mode as "origin" | "kind" | "horizon";
      const tally = new Map<string, number>();
      for (const node of this.graph?.nodes ?? []) {
        if (node.foreign) continue;
        if (mode !== "kind" && node.kind !== "note") continue;
        const value = (node as unknown as Record<string, string | undefined>)[key] ?? "";
        tally.set(value, (tally.get(value) ?? 0) + 1);
      }
      const palette = mode === "horizon" ? HORIZON_COLOURS : mode === "origin" ? ORIGIN_COLOURS : KIND_COLOURS;
      const meaning = mode === "horizon" ? HORIZON_MEANING : mode === "origin" ? ORIGIN_MEANING : KIND_LABEL;
      for (const [value, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
        const label = value
          ? meaning[value] ?? value
          : mode === "horizon"
            ? "not yet decided"
            : "not set";
        const mark = row(body, label, n, { field: key, value });
        mark.style.background = this.col(value ? palette[value] ?? NEUTRAL : NEUTRAL);
        if (!value) mark.addClass("is-unset");
      }
    }

    this.drawAlso(body, mode);
  }

  /**
   * Everything on screen that is not a note, as one line rather than five rows.
   *
   * In every mode but `kind` the block above describes a property only notes
   * have, so on its own it leaves a third of the marks unexplained — and a
   * source page was being counted under "not set", as though it were a note
   * missing its origin rather than a thing that never had one. But these are
   * learned once and then known forever, which is the argument for a line of
   * secondary text and against five more rows of equal weight.
   */
  private drawAlso(host: HTMLElement, mode: ColourMode) {
    const tally = new Map<string, number>();
    let foreign = 0;
    for (const node of this.graph?.nodes ?? []) {
      if (node.foreign) foreign++;
      else if (node.kind !== "note") tally.set(node.kind, (tally.get(node.kind) ?? 0) + 1);
    }
    const order: [string, string][] = [
      ["topic", "topics"],
      ["source", "sources"],
      ["session", "sessions"],
      // Not "unfiled": folders like Essays, Goals and Reference are deliberate
      // folders, deliberately outside the atom schema. Calling them unfiled
      // would make the key accuse the vault of a mess that is not there.
      ["other", "own folders"],
    ];
    // In `kind` mode the rows above already name these; only the other vault
    // is left over.
    const rows = mode === "kind" ? [] : order.filter(([k]) => (tally.get(k) ?? 0) > 0);
    if (!rows.length && !foreign) return;

    // A two-column grid, not a wrapped run of inline items. Wrapping put the
    // break wherever the text happened to run out, so the marks never lined up
    // with each other and the block read as five fragments rather than one
    // secondary group — which is the whole of what looked messy about it. The
    // lead word is gone too: the hairline above already says "different kind
    // of thing", and "ALSO" in caps was the loudest text in the panel.
    const line = host.createDiv({ cls: "strata-key-also" });
    const item = (label: string, count: number, filter: MarkFilter) => {
      const el = line.createDiv({ cls: "strata-key-also-item" });
      const mark = el.createSpan({ cls: "strata-key-mark" });
      el.createSpan({ cls: "strata-key-also-label", text: label });
      el.createSpan({ cls: "strata-key-count", text: String(count) });
      const on = this.markFilter?.field === filter.field && this.markFilter?.value === filter.value;
      el.toggleClass("is-on", on);
      el.onclick = () => {
        this.markFilter = on ? null : filter;
        this.drawLegend();
        this.applyMarkFilter();
      };
      el.onmouseenter = () => this.previewMark(filter);
      el.onmouseleave = () => this.clearPreview();
      return mark;
    };
    for (const [kind, label] of rows) {
      const mark = item(label, tally.get(kind) ?? 0, { field: "kind", value: kind });
      mark.addClass(`is-${kind}`);
      // Match what the canvas draws, which differs by mode: a topic is a ring
      // in the topics colour whatever is selected, because `applyColours`
      // leaves it alone; a source is tinted like a note and so goes neutral
      // grey outside `kind` mode. Drawing it green here would make the key
      // wrong in the one place it exists to help.
      if (kind === "topic") mark.style.borderColor = this.col(LAYER_COLOURS.topics);
      else if (kind === "session") mark.style.background = this.col(KIND_COLOURS.session);
      else mark.style.background = this.col(NEUTRAL);
    }
    if (foreign) {
      const mark = item("Work vault", foreign, { field: "foreign", value: "1" });
      mark.addClass("is-foreign");
      mark.style.borderColor = this.col(LAYER_COLOURS.bridges);
    }
  }

  /** Hovering a key row previews what it names, the way a layer chip does. */
  private previewMark(filter: MarkFilter) {
    const cy = this.cy;
    if (!cy) return;
    const hit = cy.nodes().filter((n) => this.matchesMark(n, filter) && !n.hasClass("strata-hidden"));
    const near = hit.union(hit.connectedEdges());
    cy.batch(() => {
      cy.elements().difference(near).addClass("strata-faded");
      near.removeClass("strata-faded").addClass("strata-focus");
    });
  }

  private matchesMark(node: NodeSingular, filter: MarkFilter): boolean {
    if (filter.field === "foreign") return !!node.data("foreign");
    if (node.data("foreign")) return false;
    if (filter.field === "kind") return node.data("kind") === filter.value;
    // Only notes carry origin and horizon, so a source must not fall into
    // "not set" just because it has neither.
    if (node.data("kind") !== "note") return false;
    return (node.data(filter.field) ?? "") === filter.value;
  }

  /** Dim everything the picked key row does not name. */
  private applyMarkFilter() {
    const cy = this.cy;
    const filter = this.markFilter;
    if (!cy) return;
    if (!filter) {
      cy.elements().removeClass("strata-faded");
      this.applyQueryHighlight();
      return;
    }
    cy.batch(() => {
      const hit = cy.nodes().filter((n) => this.matchesMark(n, filter));
      const near = hit.union(hit.connectedEdges());
      cy.elements().difference(near).addClass("strata-faded");
      near.removeClass("strata-faded");
    });
  }

  /**
   * Lay out what is actually on screen.
   *
   * The old version fed every edge to the solver regardless of which layers were
   * on, so soloing Topics rearranged nothing: the notes stayed where the *links*
   * layer had put them, piled on each other, connected by lines that were no
   * longer drawn. A layout has to be computed from the graph being looked at, or
   * it is a picture of a different graph.
   */
  private runLayout(animate: boolean, fresh = true) {
    const cy = this.cy;
    if (!cy) return;
    const visible = cy.elements().not(".strata-hidden");
    const nodes = visible.nodes();
    if (nodes.length < 2) return;

    // One simulation, but only over the nodes the visible layers actually
    // connect. Everything used to go in, which is how soloing a layer ended up
    // showing that layer in **under a fifth of the canvas by area**: the rest
    // of the graph was still
    // in the simulation, still repelling, still claiming space, on the strength
    // of edges that were switched off.
    //
    // What is off-layer is parked instead — see `park` in forces.ts for why
    // those nodes and the genuinely edgeless ones are not the same population
    // and should not share a mechanism.
    const springs: Spring[] = (visible.edges().toArray() as EdgeSingular[]).map((e) => ({
      source: e.source().id(),
      target: e.target().id(),
      layer: e.data("layer") as LayerId,
    }));
    const onLayer = new Set<string>();
    for (const spring of springs) {
      onLayer.add(spring.source);
      onLayer.add(spring.target);
    }

    const core: Placed[] = [];
    const parked: Placed[] = [];
    for (const node of nodes.toArray() as NodeSingular[]) {
      (onLayer.has(node.id()) ? core : parked).push({ id: node.id(), ...node.position() });
    }

    // A layer with a single edge has nothing to simulate; the ring still needs
    // somewhere to be, so park runs either way.
    if (core.length >= 2) simulate(core, springs, this.plugin.data.forces, fresh);
    park(parked, core);

    const settled = new Map([...core, ...parked].map((p) => [p.id, { x: p.x, y: p.y }]));
    const layout = cy.layout({
      name: "preset",
      positions: (node: NodeSingular) => settled.get(node.id()) ?? node.position(),
      animate,
      animationDuration: 600,
      // Not cytoscape's own fit: it fits everything it was given, ring
      // included, which zooms far enough out that the layer you asked for is a
      // smudge in the middle and no label passes the zoom threshold. Fit the
      // core instead and let the ring sit outside the viewport, one scroll away.
      fit: false,
      padding: 60,
    } as unknown as cytoscape.LayoutOptions);
    layout.one("layoutstop", () => {
      // A touch-up, and only ever that: the simulation measured zero overlapping
      // pairs on the real graph, so this is here for the small graphs where two
      // nodes can still land on each other.
      this.separate();
      // Only the simulated nodes. A parked position is a statement about the
      // layers that happen to be switched on right now, not about where the
      // node lives — and persisting it strands the node: solo a layer, park
      // half the graph a thousand pixels out, switch the layers back on, and
      // those nodes are still out there with their edges now visible, stretched
      // back to a core that has shrunk into a corner. That starburst was this
      // line saving coordinates it had no business keeping.
      cy.nodes().forEach((node) => {
        if (this.keepPosition(node)) this.plugin.data.positions[node.id()] = { ...node.position() };
      });
      this.plugin.queueSave();
      this.fitViewport();
      this.applyLabelPolicy();
    });
    layout.run();
  }

  /**
   * Push apart anything sitting on top of something else.
   *
   * A force layout balances attraction against repulsion and is happy to leave
   * two nodes overlapping if the edges want it — which is how a dozen notes end
   * up in one dot. This is a short relaxation pass afterwards that only ever
   * enforces a minimum gap, so it fixes the collisions without undoing the
   * structure the solver found.
   */
  private separate(iterations = 26) {
    const cy = this.cy;
    if (!cy) return;
    const nodes = cy.nodes().not(".strata-hidden");
    if (nodes.length < 2) return;

    const items = (nodes.toArray() as NodeSingular[]).map((n) => ({
      node: n,
      p: { ...n.position() },
      r: n.width() / 2,
    }));
    // Constant, and small.
    //
    // This used to scale with the spread slider, which meant that at the wide
    // end every pair in the graph was being held at the same minimum distance —
    // and a uniform minimum distance applied everywhere is the definition of a
    // lattice. That is why the nodes snapped into squares. Spread belongs to the
    // force layout; this pass only ever un-stacks things that genuinely overlap.
    const gap = 7;

    // Refuse to be the layout.
    //
    // The rule this pass enforces — no two nodes closer than their radii plus a
    // gap — has exactly one solution when everything is in violation at once:
    // close packing. A crystal. So a few collisions are a touch-up and a
    // thousand are a different picture entirely, and running anyway is how the
    // graph kept coming back as a grid however the layout above it was tuned.
    //
    // `breathe` normally makes room before this runs, so hitting this ceiling
    // means the layout itself came out wrong. Saying so is more use than
    // silently crystallising it.
    let violations = 0;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const d = Math.hypot(items[j].p.x - items[i].p.x, items[j].p.y - items[i].p.y);
        if (d < items[i].r + items[j].r + gap) violations++;
      }
    }
    if (violations > items.length) {
      console.warn(
        `[strata] skipping the overlap pass: ${violations} overlapping pairs across ${items.length} nodes ` +
          `is a layout problem, and relaxing it would produce a grid.`
      );
      return;
    }

    for (let step = 0; step < iterations; step++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];
          let dx = b.p.x - a.p.x;
          let dy = b.p.y - a.p.y;
          let dist = Math.hypot(dx, dy);
          const min = a.r + b.r + gap;
          if (dist >= min) continue;
          // Exactly coincident: nothing to push along, so pick a direction.
          if (dist < 0.01) {
            const angle = (i * 2.399963) % (Math.PI * 2); // golden angle, deterministic
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            dist = 1;
          }
          const push = ((min - dist) / dist) * 0.34;
          const ox = dx * push;
          const oy = dy * push;
          a.p.x -= ox;
          a.p.y -= oy;
          b.p.x += ox;
          b.p.y += oy;
          moved = true;
        }
      }
      if (!moved) break;
    }

    cy.batch(() => {
      for (const item of items) item.node.position(item.p);
    });
  }

  // ------------------------------------------------------------ detail card

  /**
   * The inspector, summoned by right-click.
   *
   * It used to appear on left-click alongside the note opening in a tab, which
   * meant nobody ever read it: by the time it existed you were looking at an
   * editor. Now it is the only thing right-click does, which makes it a place
   * you went to on purpose — and that is what it had to be designed as.
   *
   * Three rules hold it together. It is **bounded**: a fixed maximum height
   * with the title stuck to the top, because it used to grow past the bottom
   * of the window on a well-connected note and the actions fell off the end.
   * Nothing in it **reflows late**: the compound check is asynchronous and now
   * appends one line at the bottom rather than inserting a block in the
   * middle a beat after you started reading. And its actions are **ranked** —
   * linking is the thing you came for, opening is one word, and everything
   * rare is behind one more click rather than competing at full width.
   */
  private showCard(node: NodeSingular) {
    const path = node.id();
    const data = this.graph?.nodes.find((n) => n.id === path);
    if (!data) return;

    // A ring on the node, so the card is visibly about *that* one. The style
    // already existed for `:selected` and survives drag, zoom and re-layout
    // for free — which is the whole reason the card stays in its corner
    // instead of chasing the node around the canvas.
    this.cy?.$(":selected").unselect();
    node.select();

    this.cardEl.empty();
    this.cardEl.addClass("is-open");
    this.cardEl.scrollTop = 0;

    const head = this.cardEl.createDiv({ cls: "strata-card-head" });
    head.createEl("h4", { text: data.label.replace(/^note-/, "") });
    // One line of grey text, not three pills. A pill reads as something you
    // can press, and none of these were; and saying "your own idea" rather
    // than "my-thought" means the card and the key speak one vocabulary.
    const facts = [
      KIND_LABEL[data.kind] ?? data.kind,
      data.origin ? ORIGIN_MEANING[data.origin] ?? data.origin : "",
      data.horizon ? HORIZON_MEANING[data.horizon] ?? data.horizon : "",
      data.session ? new Date(data.session.at).toISOString().slice(0, 10) : data.captured ?? "",
    ].filter(Boolean);
    head.createDiv({ cls: "strata-card-facts", text: facts.join(" · ") });

    // Connections read as sentences, not counts — and only the ones on screen.
    // Counting every layer meant a card could say "rhymes with 2" with Resonance
    // switched off, describing a graph that was not being shown.
    const byLayer = new Map<LayerId, number>();
    let hidden = 0;
    for (const edge of this.graph?.edges ?? []) {
      if (edge.source !== path && edge.target !== path) continue;
      if (!this.activeLayers.has(edge.layer)) {
        hidden++;
        continue;
      }
      byLayer.set(edge.layer, (byLayer.get(edge.layer) ?? 0) + 1);
    }
    const live = LAYERS.filter((layer) => byLayer.get(layer.id));
    if (live.length) {
      const grid = this.cardEl.createDiv({ cls: "strata-card-conn" });
      for (const layer of live) {
        const item = grid.createDiv({ cls: "strata-card-conn-item" });
        // This mark was `strata-legend-line`, a class with no rule anywhere in
        // the stylesheet — so the card's layer colours have been invisible for
        // as long as the block has existed.
        const line = item.createSpan({ cls: "strata-card-line" });
        line.style.color = tune(LAYER_COLOURS[layer.id], this.dark);
        if (layer.id === "resonance") line.addClass("is-dotted");
        else if (DASHED.has(layer.id)) line.addClass("is-dashed");
        item.createSpan({ cls: "strata-card-conn-text", text: LAYER_MEANING[layer.id] });
        item.createSpan({ cls: "strata-card-conn-n", text: String(byLayer.get(layer.id)) });
      }
    } else {
      this.cardEl.createDiv({ cls: "strata-card-sub", text: "nothing connected in the layers you have on" });
    }
    if (hidden) {
      this.cardEl.createDiv({
        cls: "strata-card-sub",
        text: `${hidden} more in layer${hidden === 1 ? "" : "s"} that are switched off`,
      });
    }

    if (data.session) {
      const session = this.plugin.data.linkedSessions[path.replace(/^session:/, "")];
      if (!session) return;
      this.cardEl.createDiv({ cls: "strata-card-sub", text: session.project.replace(/^\/Users\/[^/]+/, "~") });
      this.cardEl.createDiv({ cls: "strata-card-sub", text: `wrote ${session.wrote.length} · read ${session.read}` });

      const row = this.cardEl.createDiv({ cls: "strata-card-actions" });
      const resume = row.createEl("button", {
        cls: "strata-open is-primary",
        text: `Resume in ${PROVIDER_LABELS[session.provider ?? "claude"]}`,
      });
      resume.onclick = () => {
        // Say where it actually went. This always claimed Terminal, including
        // when it had just handed the conversation to Desktop — and said the
        // same thing when it did nothing at all.
        const where = resumeSession(session);
        new Notice(
          where === "desktop"
            ? "Opening in Claude Desktop…"
            : where === "terminal"
              ? "Opening Terminal…"
              : "That session's id does not look like an id — not running it."
        );
      };
      this.more(row, [
        // Added by hand, so removable by hand. Nothing here is permanent
        // because nothing here arrived on its own.
        ["Remove from graph", () => this.unlinkSession(session.id)],
      ]);
      return;
    }

    if (data.foreign) {
      const rel = path.replace(/^foreign:[^/]+\//, "");
      this.cardEl.createDiv({ cls: "strata-card-sub", text: `in the ${data.foreign} vault` });
      const row = this.cardEl.createDiv({ cls: "strata-card-actions" });
      const jump = row.createEl("button", { cls: "strata-open is-ghost", text: `Open in ${data.foreign}` });
      // Obsidian's own cross-vault mechanism, which is why bridges are written
      // as <Vault>/<path> in the first place.
      jump.onclick = () =>
        window.open(
          `obsidian://open?vault=${encodeURIComponent(data.foreign as string)}&file=${encodeURIComponent(rel.replace(/\.md$/, ""))}`
        );
      // Bridges are the only edge this node can have, and they are written on
      // the other side — so offering the picker here is the difference between
      // a Work page you can look at and one you can attach to something.
      this.linkPicker(path, row);
      return;
    }

    // The Suggested layer is the one layer that exists to be *acted on* — two
    // notes that share topics and have never been linked. The card was only
    // reporting it ("could link to 1") and the button that does anything about
    // it lived on the edge: a dashed hairline you have to hit exactly, in a
    // layer that is usually one edge wide. Offer the action where the sentence
    // already is.
    if (this.activeLayers.has("suggested")) {
      const suggestions = (this.graph?.edges ?? []).filter(
        (edge) => edge.layer === "suggested" && (edge.source === path || edge.target === path)
      );
      if (suggestions.length) {
        const box = this.cardEl.createDiv({ cls: "strata-card-suggests" });
        box.createDiv({ cls: "strata-card-sub", text: "shares topics, never linked" });
        const draw = (limit: number) => {
          for (const el of Array.from(box.querySelectorAll(".strata-card-suggest, .strata-card-more-line"))) el.remove();
          for (const edge of suggestions.slice(0, limit)) {
            const otherId = edge.source === path ? edge.target : edge.source;
            const other = this.graph?.nodes.find((n) => n.id === otherId);
            if (!other) continue;
            const row = box.createDiv({ cls: "strata-card-suggest" });
            row.createSpan({ cls: "strata-card-suggest-name", text: other.label.replace(/^note-/, "") });
            // Two full-width buttons per suggestion pushed everything else off
            // the card. The words move into the tooltip; the targets stay.
            const yes = row.createEl("button", { cls: "strata-icon", text: "+" });
            this.explain(yes, `Write the link to ${other.label.replace(/^note-/, "")}`);
            yes.onclick = () => void this.writeLink(path, otherId, other.label);
            const no = row.createEl("button", { cls: "strata-icon is-quiet", text: "×" });
            this.explain(no, "Not really — stop suggesting this pair");
            no.onclick = () => {
              this.plugin.dismiss(path, otherId);
              this.hideCard();
              this.render();
            };
          }
          if (suggestions.length > limit) {
            const more = box.createDiv({
              cls: "strata-card-more-line",
              text: `${suggestions.length - limit} more`,
            });
            more.onclick = () => draw(suggestions.length);
          }
        };
        draw(3);
      }
    }

    const row = this.cardEl.createDiv({ cls: "strata-card-actions" });
    this.linkPicker(path, row);
    const open = row.createEl("button", { cls: "strata-open is-ghost", text: "Open" });
    this.explain(open, "Open the page in the reading pane.");
    open.onclick = () => this.openFile(path);

    const rare: [string, () => void][] = [];
    // Merging is a two-file decision with an archive step, so it lives on the
    // queue where both passages sit side by side. From here, the way there.
    const echoes = byLayer.get("echo") ?? 0;
    if (echoes) rare.push([`Merge in Findings (${echoes})`, () => this.showFindings("echo")]);
    rare.push(["Copy path", () => void navigator.clipboard.writeText(path)]);
    this.more(row, rare);

    void this.showCompound(path);
  }

  /**
   * The rare actions, behind one dot-dot-dot.
   *
   * The rule for what goes in here is *rarely wanted*, not *card got full*.
   * Everything below is something worth having and not worth a full-width
   * button competing with the one action you actually came for.
   */
  private more(row: HTMLElement, items: [string, () => void][]) {
    if (!items.length) return;
    const btn = row.createEl("button", { cls: "strata-open is-more", text: "⋯" });
    this.explain(btn, "Everything else you can do with this page.");
    let open: HTMLElement | null = null;
    btn.onclick = () => {
      if (open) {
        open.remove();
        open = null;
        btn.removeClass("is-on");
        return;
      }
      // Expanded in place, never a popover. One surface is the whole premise
      // of this view; a menu floating over the graph is a second one.
      open = this.cardEl.createDiv({ cls: "strata-card-more" });
      btn.addClass("is-on");
      for (const [label, run] of items) {
        const item = open.createDiv({ cls: "strata-card-more-item", text: label });
        item.onclick = run;
      }
    };
  }

  /**
   * "This is several notes."
   *
   * One idea per atom is the rule, and nothing has ever been able to check it.
   * In a real vault a handful of the longest notes hold a large share of the
   * text and a great many headed sections between them. Those are documents
   * wearing an atom's frontmatter, and no amount of embedding repairs one — it
   * only makes the note similar to five different things at once.
   *
   * Reported, never done. Splitting rewrites prose, and prose is the one thing
   * that is yours.
   */
  private async showCompound(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.cachedRead(file);
    const found = compound(raw);
    if (!found) return;
    // The card may have moved on while the read was in flight.
    if (!this.cardEl.hasClass("is-open")) return;

    // One line, appended at the bottom, that opens the rest on click.
    //
    // This used to insert the whole block — heading, character count, twelve
    // section names and two buttons — a beat after the card appeared, which
    // meant the card visibly grew and everything you were reading moved. A
    // late arrival belongs at the end and belongs small.
    const line = this.cardEl.createDiv({
      cls: "strata-card-more-line is-compound",
      text: `${found.sections} ideas in one note ›`,
    });
    const box = this.cardEl.createDiv({ cls: "strata-compound" });
    line.onclick = () => {
      box.toggleClass("is-open", !box.hasClass("is-open"));
      line.setText(`${found.sections} ideas in one note ${box.hasClass("is-open") ? "⌄" : "›"}`);
    };
    box.createDiv({
      cls: "strata-card-sub",
      text: found.marked
        ? `${(found.chars / 1000).toFixed(1)}k characters, and you already marked ${found.marked} of the seams yourself.`
        : `${(found.chars / 1000).toFixed(1)}k characters. One idea per atom is the law this breaks.`,
    });

    const list = box.createDiv({ cls: "strata-compound-list" });
    const seen = new Set<string>();
    for (const seg of segment(raw)) {
      if (!seg.heading || seen.has(seg.heading)) continue;
      seen.add(seg.heading);
      list.createDiv({ cls: "strata-compound-section", text: seg.heading });
      if (seen.size >= 4) break;
    }
    if (found.sections > seen.size) {
      list.createDiv({ cls: "strata-card-sub", text: `and ${found.sections - seen.size} more` });
    }
    const split = box.createEl("button", { cls: "strata-open", text: "Split into atoms" });
    split.onclick = () => {
      this.hideCard();
      this.plugin.split(file);
    };
    box.createDiv({
      cls: "strata-card-sub strata-compound-foot",
      text: "Every passage moves verbatim, and the original is kept whole in Full/.",
    });
  }

  /** The card for a proposed link: what it would connect, and the button that does it. */
  private showSuggestion(edge: EdgeSingular) {
    const from = edge.source();
    const to = edge.target();
    const shared = ((from.data("topics") as string[]) ?? []).filter((topic) =>
      ((to.data("topics") as string[]) ?? []).includes(topic)
    );

    this.cardEl.empty();
    this.cardEl.addClass("is-open");
    this.cardEl.createEl("h4", { text: "Missing link" });
    this.cardEl.createDiv({ cls: "strata-card-sub", text: `${from.data("label")} ↔ ${to.data("label")}` });
    this.cardEl.createDiv({
      cls: "strata-card-sub",
      text: `share ${shared.length} topics, link to each other from neither`,
    });

    const write = this.cardEl.createEl("button", { cls: "strata-open", text: "Write the link" });
    write.onclick = () => void this.writeLink(from.id(), to.id(), to.data("label") as string);

    const no = this.cardEl.createEl("button", { cls: "strata-open strata-open-quiet", text: "Not really" });
    no.onclick = () => {
      this.plugin.dismiss(from.id(), to.id());
      this.hideCard();
    };
  }

  /**
   * The card for something the model noticed.
   *
   * It has to show its working. A number on its own is not a reason, and a
   * proposal you cannot interrogate is one you either accept on faith or
   * ignore — so the shared language goes on the card next to the score, and
   * both notes are one click away. The model gets to point; it does not get to
   * decide, and nothing here writes to the vault unless you press the button.
   */
  private showSemantic(edge: EdgeSingular) {
    const from = edge.source();
    const to = edge.target();
    const isEcho = edge.data("layer") === "echo";
    const sim = (edge.data("similarity") as number) ?? 0;
    const match = this.plugin.index?.match(from.id(), to.id()) ?? null;

    this.cardEl.empty();
    this.cardEl.addClass("is-open");
    this.cardEl.createEl("h4", { text: isEcho ? "Said twice" : "Rhymes" });

    const pair = this.cardEl.createDiv({ cls: "strata-card-pair" });
    for (const node of [from, to]) {
      const row = pair.createEl("button", { cls: "strata-card-pairrow", text: node.data("label") as string });
      row.onclick = () => this.openFile(node.id());
    }

    const meta = this.cardEl.createDiv({ cls: "strata-card-meta" });
    meta.createSpan({ cls: "strata-tag", text: `${Math.round(sim * 100)}% alike` });
    const shared = ((from.data("topics") as string[]) ?? []).filter((t) =>
      ((to.data("topics") as string[]) ?? []).includes(t)
    ).length;
    meta.createSpan({ cls: "strata-tag", text: shared ? `${shared} shared topics` : "no shared topic" });

    this.cardEl.createDiv({
      cls: "strata-card-sub",
      text: isEcho
        ? "Near-identical. Either one of these should absorb the other, or they are deliberately separate and should say so."
        : "Different topics, related language. The connection your tags could not have found.",
    });

    // The passages themselves, not a score. This is the difference between a
    // proposal you can judge and one you have to take on trust.
    if (match) {
      const quotes = this.cardEl.createDiv({ cls: "strata-card-quotes" });
      for (const [node, side] of [
        [from, match.a],
        [to, match.b],
      ] as const) {
        const block = quotes.createDiv({ cls: "strata-quote" });
        if (side.heading) block.addClass("is-linked");
        block.createDiv({
          cls: "strata-quote-from",
          text: side.heading
            ? `${node.data("label")} — ${side.heading}`
            : (node.data("label") as string),
        });
        block.createDiv({ cls: "strata-quote-text", text: side.preview });
        block.onclick = () => this.openAt(node.id(), side.heading);
      }
    }

    // What the relation actually is, not merely that there is one. Similarity
    // is symmetric and mute; two notes that disagree are worth a different
    // action from two that repeat each other.
    if (match) {
      const key = pairKey(from.id(), to.id());
      const known = this.plugin.data.aspects[key];
      const slot = this.cardEl.createDiv({ cls: "strata-aspect" });
      const paint = (relation: keyof typeof RELATION_LABEL, because: string) => {
        slot.empty();
        slot.addClass("is-read");
        slot.createSpan({ cls: "strata-aspect-verdict", text: RELATION_LABEL[relation] });
        if (because) slot.createSpan({ cls: "strata-aspect-why", text: because });
      };
      if (known) {
        paint(known.relation, known.because);
      } else {
        const ask = slot.createEl("button", { cls: "strata-chip strata-chip-plain", text: "What kind of link?" });
        this.explain(
          ask,
          "Read the two passages with the local model and name the relation — same claim, deeper, applied, or pulling against each other. One call, and it is a reading rather than a verdict."
        );
        ask.onclick = () => {
          ask.setText("Reading…");
          ask.disabled = true;
          void (async () => {
            const verdict = await judge(
              this.plugin.data.semantic.host,
              this.plugin.data.writer,
              match.a.preview,
              match.b.preview
            );
            if (!verdict) {
              ask.setText("Could not read it");
              return;
            }
            this.plugin.data.aspects[key] = verdict;
            this.plugin.queueSave();
            paint(verdict.relation, verdict.because);
          })();
        };
      }
    }

    const write = this.cardEl.createEl("button", { cls: "strata-open", text: "Write the link" });
    write.onclick = () => void this.writeLink(from.id(), to.id(), to.data("label") as string);

    const no = this.cardEl.createEl("button", { cls: "strata-open strata-open-quiet", text: "Not really" });
    no.onclick = () => {
      this.plugin.dismiss(from.id(), to.id());
      this.hideCard();
    };
  }

  /** Additive and visible — the wiring is the system's, the claim stays yours. */
  private async writeLink(fromPath: string, toPath: string, _label: string) {
    await this.connect(fromPath, toPath);
  }

  /**
   * "Link to…" — the way to connect two pages the machine never proposed.
   *
   * Deliberately a field rather than a list of everything: at a couple of
   * hundred nodes a dropdown is a scroll, and the note you want is one you
   * already have a word
   * for. It matches on the same normalised name the Find box uses, so a query
   * types the same here as it does there.
   *
   * What it will not do is create the other end. Every row is a page that
   * already exists, because "link to a note that isn't there yet" is a capture,
   * and capture asks questions this box has no business answering.
   */
  private linkPicker(fromPath: string, row: HTMLElement) {
    const start = row.createEl("button", { cls: "strata-open is-primary", text: "Link to…" });
    this.explain(start, "Join this page to another one, whether or not anything suggested it.");

    start.onclick = () => {
      start.remove();
      // The field takes the whole action row, then the list grows under the
      // card. Replacing the button in place means the thing you clicked is
      // the thing you are now typing into, with nothing else moving.
      const box = this.cardEl.createDiv({ cls: "strata-linker" });
      const field = box.createEl("input", { cls: "strata-linker-input", type: "text" });
      field.placeholder = "which page?";
      const list = box.createDiv({ cls: "strata-linker-list" });
      box.createDiv({
        cls: "strata-card-sub",
        text: "or hold shift and click a node",
      });

      // Everything already joined to this page, so the list can say so instead
      // of offering a link that will come back as "already linked".
      const joined = new Set<string>();
      for (const edge of this.graph?.edges ?? []) {
        if (edge.source === fromPath) joined.add(edge.target);
        else if (edge.target === fromPath) joined.add(edge.source);
      }

      let picked = 0;
      const draw = () => {
        const query = field.value.trim().toLowerCase().replace(/[-_]+/g, " ");
        list.empty();
        if (!query) return;
        const hits = (this.graph?.nodes ?? [])
          .filter((node) => {
            if (node.id === fromPath || node.id.startsWith("session:")) return false;
            const name = node.label.toLowerCase().replace(/^note-/, "").replace(/[-_]+/g, " ");
            return name.includes(query);
          })
          // A page already connected sorts last: still reachable, never in the
          // way of the one you are actually looking for.
          .sort((a, b) => Number(joined.has(a.id)) - Number(joined.has(b.id)))
          .slice(0, 7);
        picked = Math.min(picked, Math.max(0, hits.length - 1));
        hits.forEach((node, i) => {
          const row = list.createDiv({ cls: `strata-linker-row${i === picked ? " is-on" : ""}` });
          row.createSpan({ cls: "strata-linker-name", text: node.label.replace(/^note-/, "") });
          if (node.foreign) row.createSpan({ cls: "strata-tag", text: node.foreign });
          else if (node.kind !== "note") row.createSpan({ cls: "strata-tag", text: node.kind });
          if (joined.has(node.id)) row.createSpan({ cls: "strata-tag is-quiet", text: "linked" });
          row.onmouseenter = () => {
            picked = i;
            for (const [j, el] of Array.from(list.children).entries()) el.toggleClass("is-on", j === i);
          };
          row.onclick = () => void this.connect(fromPath, node.id);
        });
      };

      field.oninput = draw;
      field.onkeydown = (e) => {
        const rows = list.children.length;
        if (e.key === "Escape") {
          this.hideCard();
          return;
        }
        if (!rows) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          picked = (picked + (e.key === "ArrowDown" ? 1 : rows - 1)) % rows;
          for (const [j, el] of Array.from(list.children).entries()) el.toggleClass("is-on", j === picked);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          (list.children[picked] as HTMLElement | undefined)?.click();
        }
      };
      field.focus();
    };
  }

  private nameOf(id: string): string {
    return this.graph?.nodes.find((n) => n.id === id)?.label.replace(/^note-/, "") ?? id;
  }

  /**
   * Join two pages, whichever kind they are.
   *
   * Strata could only ever write a link it had suggested itself, which is the
   * wrong way round — the suggestions are set arithmetic over shared topics,
   * and the connection worth making is usually the one the schema could not
   * have derived. So this takes any two nodes and works out what a link
   * between them even *is*:
   *
   *   two notes here      a wikilink under `## Related`, appended
   *   one of them in Work a `bridges:` string, because no wikilink crosses
   *   anything with a session   refused, below
   *
   * Always additive, always on this vault's side, and it reports "already
   * linked" rather than silently doing nothing — the failure that makes a
   * button feel broken.
   */
  private async connect(fromPath: string, toPath: string): Promise<void> {
    if (fromPath === toPath) return;
    const foreign = (id: string) => id.startsWith("foreign:");

    // A session is not a page. It joins the notes it actually wrote, and that
    // list is yours — nothing here gets to add to it sideways.
    if (fromPath.startsWith("session:") || toPath.startsWith("session:")) {
      new Notice("A session joins the notes it wrote. That list is yours, not something to link into.");
      return;
    }
    if (foreign(fromPath) && foreign(toPath)) {
      new Notice("Both of these live in Work. Link them there — Strata only writes to the vault Obsidian has open.");
      return;
    }

    const here = foreign(fromPath) ? toPath : fromPath;
    const there = foreign(fromPath) ? fromPath : toPath;
    try {
      const wrote = foreign(there)
        ? await bridgeTo(this.app, here, there.slice("foreign:".length))
        : await linkTo(this.app, here, there);
      new Notice(
        wrote
          ? `${this.nameOf(here)} → ${this.nameOf(there)}${foreign(there) ? " (bridge)" : ""}`
          : `Already linked to ${this.nameOf(there)}`
      );
    } catch (err) {
      console.error("[strata] link failed", err);
      new Notice("Could not write that link. Nothing was changed.");
      return;
    }
    this.render();
    // Stay on the page you were linking *from*. The new edge is on its card a
    // moment later, and the next shift-click links the same page to something
    // else — which is how this actually gets used: one note you have just
    // realised belongs to three others, not one link and a fresh start.
    const again = this.cy?.getElementById(here);
    if (again?.nonempty()) {
      this.pinned = here;
      this.showCard(again as NodeSingular);
    } else {
      this.hideCard();
    }
  }

  private hideCard() {
    this.cardEl.removeClass("is-open");
    this.cy?.$(":selected").unselect();
  }

  /** Open a node's file in its own tab, leaving the graph where it is. */
  /**
   * One reading pane, reused.
   *
   * Every open was `getLeaf("tab")` — a *new* tab every time. Since clicking a
   * node opens the note, browsing the graph for a minute left a row of tabs
   * nobody asked for. Strata keeps the one it opened and reuses it, so reading
   * is a pane that updates rather than a pile that grows. Close it and the next
   * click makes another. It never takes over a pane you opened yourself:
   * hijacking the note you were reading is a worse failure than one extra tab.
   */
  private reader: WorkspaceLeaf | null = null;

  private readerLeaf(): WorkspaceLeaf {
    if (this.reader && this.app.workspace.getLeavesOfType("markdown").includes(this.reader)) {
      return this.reader;
    }
    this.reader = this.app.workspace.getLeaf("tab");
    return this.reader;
  }

  private openFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.readerLeaf().openFile(file);
  }

  /**
   * Open a file at the passage that actually matched.
   *
   * An edge between two long notes says almost nothing on its own — the claim
   * is about one paragraph in each, and the index has known which paragraph
   * since it started embedding passages instead of whole notes. This is that
   * knowledge finally reaching the click: `openLinkText` on `path#heading`
   * makes Obsidian scroll to the heading and flash it, so the connection lands
   * on the sentence rather than on a file to go hunting through.
   *
   * A passage with no heading falls back to the top of the file, which is the
   * honest answer — there is nothing to point at.
   */
  private openAt(path: string, heading: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !heading) return this.openFile(path);
    const anchor = anchorFor(this.app.metadataCache.getFileCache(file)?.headings ?? [], heading);
    if (!anchor) return this.openFile(path);
    const leaf = this.readerLeaf();
    void leaf.openFile(file).then(() => leaf.setEphemeralState({ subpath: `#${anchor}` }));
  }
}
