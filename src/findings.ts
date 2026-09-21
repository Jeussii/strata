import { App, Notice, TFile } from "obsidian";
import type StrataPlugin from "./main";
import { GEdge, anchorFor, buildGraph, suggestLinks } from "./model";
import { compound } from "./segment";
import { linkTo, mergeInto } from "./write";
import { SessionRef, listSessions } from "./sessions";

/**
 * The other half of Strata: a list, on purpose — living inside the graph.
 *
 * Echo drawn on a canvas is a handful of unconnected pairs floating in
 * hundreds of nodes, which is a picture of nothing. The same pairs as rows —
 * both titles, both matching passages, and a button — is a morning's work you
 * can actually
 * do. Some findings are shaped like a graph and some are shaped like a queue.
 *
 * This used to be a second tab, its own `ItemView`, and it never once rendered:
 * Obsidian 1.13.7 constructed the view and then never opened it — no `onload`,
 * no `onOpen`, `containerEl` never attached to the document — while the graph
 * view registered on the adjacent line loaded every time. Nothing threw; the
 * pane was simply blank forever.
 *
 * So it is not a view any more. It is a panel inside the one view that does
 * load, which removes the dependency on the lifecycle that was broken and is
 * the better arrangement regardless: the graph and the queue are two readings
 * of the same findings, and having them side by side means acting on a pair
 * and watching the shape change is one motion instead of two tabs.
 *
 *   **The canvas** — the structure you wrote. What is connected to what, and why.
 *   **This panel** — what the system noticed, and the one action for each.
 *
 * Everything here is one click from being resolved, and nothing here resolves
 * itself.
 */

export type Tab = "overview" | "echo" | "resonance" | "compound" | "horizon" | "sessions";

interface Pair {
  a: string;
  b: string;
  score: number;
}

interface Compound {
  path: string;
  sections: number;
  chars: number;
  marked: number;
}

const TABS: { id: Tab; label: string; blurb: string }[] = [
  {
    id: "overview",
    label: "Overview",
    blurb: "What the vault is asking you for, and roughly how much of it there is.",
  },
  { id: "echo", label: "Said twice", blurb: "Near-identical notes. Merge them, or link them and keep both on purpose." },
  {
    id: "resonance",
    label: "Rhymes",
    blurb: "Notes that say related things without sharing a topic — the connection your tags could not find.",
  },
  {
    id: "compound",
    label: "Several ideas",
    blurb: "Notes holding more than one idea. One idea per atom is the law these break.",
  },
  { id: "horizon", label: "No horizon", blurb: "Not yet marked as a lasting truth or a description of a moment." },
  {
    id: "sessions",
    label: "Sessions",
    blurb:
      "AI conversations on this machine that are not in the graph. Nothing here is added on its own — tick what belongs and add it.",
  },
];

export class FindingsPanel {
  private app: App;
  private plugin: StrataPlugin;
  private host: HTMLElement;

  private tab: Tab = "overview";
  private headEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private blurbEl!: HTMLElement;
  private listEl!: HTMLElement;
  private built = false;

  private echo: Pair[] = [];
  private resonance: Pair[] = [];
  private compounds: Compound[] = [];
  private horizonless: TFile[] = [];
  /**
   * Sessions are loaded when the tab is first opened, not during `scan`.
   *
   * Reading the head of every transcript on disk is cheap but it is not free,
   * and it has nothing to do with the vault scan the other four tabs need.
   */
  private sessions: SessionRef[] = [];
  private sessionsState: "cold" | "loading" | "ready" = "cold";
  private picked = new Set<string>();
  private sessionFilter = "";
  private scanning = false;
  private scanned = false;
  private pending = false;
  private failure: string | null = null;

  /** Fired whenever the counts change, so the toolbar chip can say how many. */
  onCounts: (() => void) | null = null;
  /** Set by the view: actually link the chosen sessions and redraw the graph. */
  onLinkSessions: ((refs: SessionRef[]) => Promise<void>) | null = null;

  constructor(app: App, plugin: StrataPlugin, host: HTMLElement) {
    this.app = app;
    this.plugin = plugin;
    this.host = host;
  }

  // ------------------------------------------------------------- visibility

  get visible(): boolean {
    return this.host.hasClass("is-open");
  }

  show(tab?: Tab): void {
    this.mount();
    if (tab) this.tab = tab;
    this.host.addClass("is-open");
    this.draw();
    void this.scan();
  }

  hide(): void {
    this.host.removeClass("is-open");
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /**
   * What the toolbar chip counts.
   *
   * It used to be echo + resonance, which on a real vault reads "Findings 102".
   * A hundred and two of what? Rhymes is a standing pile that nobody clears —
   * counting it turns the chip into weather and teaches you to ignore it. Only
   * duplicates are a real queue: a short list where each row is one decision
   * and the list actually empties.
   */
  get outstanding(): number {
    return this.echo.length;
  }

  /**
   * Recount, but only when it would be seen.
   *
   * The scan reads roughly a hundred files and then waits on the passage
   * comparison. Doing that for a panel nobody has opened is the kind of work
   * that makes an app feel slow for no visible return.
   */
  refresh(): void {
    if (!this.visible) return;
    void this.scan();
  }

  // ------------------------------------------------------------------ shell

  private mount(): void {
    if (this.built) return;
    this.host.empty();

    this.headEl = this.host.createDiv({ cls: "strata-find-head" });
    const title = this.headEl.createDiv({ cls: "strata-find-title" });
    title.createSpan({ text: "Findings" });
    const close = title.createEl("button", { cls: "strata-find-close", text: "✕" });
    close.setAttr("aria-label", "Close findings");
    close.onclick = () => this.hide();

    this.tabsEl = this.headEl.createDiv({ cls: "strata-seg" });
    this.blurbEl = this.headEl.createDiv({ cls: "strata-find-blurb" });
    this.listEl = this.host.createDiv({ cls: "strata-find-list" });
    this.built = true;
  }

  // ------------------------------------------------------------------- scan

  /**
   * Recount everything.
   *
   * The semantic halves come from the index, which computes off-frame and may
   * not have landed yet — an empty Echo list here means "not read yet", not
   * "nothing found", so the empty state says which.
   */
  private async scan(): Promise<void> {
    // A request that arrives mid-scan is remembered rather than dropped.
    //
    // The edge pass runs off-frame; the scan spends a second reading a hundred
    // files for the compound list. When the edges landed in that window the
    // refresh was swallowed by this guard, and the empty list captured at the
    // start stood for good.
    if (this.scanning) {
      this.pending = true;
      return;
    }
    this.scanning = true;
    try {
      const graph = buildGraph(this.app);
      graph.edges.push(...suggestLinks(graph));
      const notes = this.plugin.vaultNotes();
      this.horizonless = notes.filter((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        return fm?.type === "note" && !fm?.horizon;
      });

      this.compounds = [];
      for (const file of notes) {
        const found = compound(await this.app.vault.cachedRead(file));
        if (found) this.compounds.push({ path: file.path, ...found });
      }
      this.compounds.sort((a, b) => b.chars - a.chars);

      // Asked for and waited on, rather than peeked at. Reading the graph's
      // off-frame cache meant an empty list said "nobody has computed it yet"
      // far more often than "nothing found", and the two look identical.
      const semantic: GEdge[] = this.plugin.index?.size
        ? await this.plugin.index.pairs(graph, this.plugin.data.semantic)
        : [];
      const toPair = (e: GEdge): Pair => ({ a: e.source, b: e.target, score: e.similarity ?? 0 });
      const live = (e: GEdge) => !this.plugin.isDismissed(e.source, e.target);
      this.echo = semantic
        .filter((e) => e.layer === "echo" && live(e))
        .map(toPair)
        .sort((x, y) => y.score - x.score);
      this.resonance = semantic
        .filter((e) => e.layer === "resonance" && live(e))
        .map(toPair)
        .sort((x, y) => y.score - x.score);

      this.failure = null;
    } catch (err) {
      console.error("[strata] findings scan failed", err);
      this.failure = err instanceof Error ? err.message : String(err);
    } finally {
      this.scanned = true;
      this.scanning = false;
      this.draw();
      this.onCounts?.();
      if (this.pending) {
        this.pending = false;
        void this.scan();
      }
    }
  }

  // ------------------------------------------------------------------- draw

  private count(tab: Tab): number {
    if (tab === "echo") return this.echo.length;
    if (tab === "resonance") return this.resonance.length;
    if (tab === "compound") return this.compounds.length;
    if (tab === "horizon") return this.horizonless.length;
    if (tab === "sessions") return this.unlinked().length;
    return this.echo.length;
  }

  private draw(): void {
    this.mount();
    this.tabsEl.empty();
    if (this.failure) {
      this.blurbEl.setText("");
      this.listEl.empty();
      this.listEl.createDiv({ cls: "strata-find-empty", text: `Could not read the vault: ${this.failure}` });
      const retry = this.listEl.createEl("button", { cls: "strata-open", text: "Try again" });
      retry.onclick = () => void this.scan();
      return;
    }
    for (const tab of TABS) {
      const chip = this.tabsEl.createEl("button", {
        cls: `strata-chip${this.tab === tab.id ? " is-on" : ""}`,
      });
      chip.createSpan({ cls: "strata-chip-label", text: tab.label });
      chip.createSpan({ cls: "strata-count", text: String(this.count(tab.id)) });
      chip.onclick = () => {
        this.tab = tab.id;
        this.draw();
      };
    }
    const again = this.tabsEl.createEl("button", { cls: "strata-chip strata-chip-plain", text: "Recheck" });
    again.onclick = () => void this.scan();

    const index = this.plugin.index;
    const state = !index?.size
      ? "nothing read yet"
      : this.scanned
        ? `${index.size} notes · ${index.segmentCount} passages compared`
        : `${index.size} notes read, still comparing`;
    this.blurbEl.setText(`${TABS.find((t) => t.id === this.tab)?.blurb ?? ""}  —  ${state}.`);

    this.listEl.empty();
    if (this.tab === "overview") return this.drawOverview();
    if (this.tab === "echo") return this.drawPairs(this.echo, true);
    if (this.tab === "resonance") return this.drawPairs(this.resonance, false);
    if (this.tab === "compound") return this.drawCompounds();
    if (this.tab === "horizon") return this.drawHorizonless();
    return this.drawSessions();
  }

  // --------------------------------------------------------------- sessions

  /** On this machine, not yet in the graph. */
  private unlinked(): SessionRef[] {
    const linked = this.plugin.data.linkedSessions;
    return this.sessions.filter((session) => !linked[session.id]);
  }

  /**
   * The sessions tab.
   *
   * The picker behind `+ Claude` has always worked and was almost never used:
   * almost none of the transcripts on disk are in the graph. The list was
   * never the problem — nearly all of them carry a real title. The problem is that the
   * button is one small chip among six, and that the modal links exactly one
   * session before closing, so putting twenty in means opening it twenty times.
   *
   * So: same rule, less friction. Tick several, add them in one pass. Nothing
   * is pre-ticked and nothing is suggested — membership stays yours, which is the
   * part of this that is not a UI decision.
   */
  private drawSessions(): void {
    if (this.sessionsState === "cold") {
      this.sessionsState = "loading";
      void listSessions(this.app)
        .then((all) => {
          this.sessions = all.sort((a, b) => b.at - a.at);
          this.sessionsState = "ready";
          this.onCounts?.();
          if (this.tab === "sessions") this.draw();
        })
        .catch((err) => {
          this.sessionsState = "ready";
          this.failure = err instanceof Error ? err.message : String(err);
          if (this.tab === "sessions") this.draw();
        });
    }
    if (this.sessionsState !== "ready") return this.empty("Reading the transcripts on this machine…");

    const all = this.unlinked();
    if (!all.length) {
      return this.empty(
        this.sessions.length
          ? "Every session on this machine is already in the graph."
          : "No Claude Code sessions found on this machine."
      );
    }

    const bar = this.listEl.createDiv({ cls: "strata-sess-bar" });
    const filter = bar.createEl("input", { cls: "strata-search", type: "text" });
    filter.placeholder = "Filter by title or folder…";
    filter.value = this.sessionFilter;
    filter.oninput = () => {
      this.sessionFilter = filter.value.trim().toLowerCase();
      this.drawSessionRows(rows);
      sync();
    };

    const add = bar.createEl("button", { cls: "strata-open strata-sess-add" });
    const sync = () => {
      const n = this.picked.size;
      add.setText(n ? `Add ${n} session${n === 1 ? "" : "s"}` : "Add");
      add.toggleClass("is-on", n > 0);
      add.disabled = n === 0;
    };
    add.onclick = () => {
      const chosen = all.filter((session) => this.picked.has(session.id));
      if (!chosen.length || !this.onLinkSessions) return;
      add.disabled = true;
      add.setText(`Adding ${chosen.length}…`);
      void this.onLinkSessions(chosen).then(() => {
        this.picked.clear();
        this.sessionFilter = "";
        this.draw();
      });
    };

    const rows = this.listEl.createDiv({ cls: "strata-sess-rows" });
    this.drawSessionRows(rows);
    sync();
  }

  private drawSessionRows(host: HTMLElement): void {
    host.empty();
    const q = this.sessionFilter;
    const shown = this.unlinked().filter(
      (s) => !q || `${s.title} ${s.project}`.toLowerCase().includes(q)
    );
    if (!shown.length) return void host.createDiv({ cls: "strata-find-empty", text: "Nothing matches that." });

    for (const session of shown.slice(0, 200)) {
      const row = host.createDiv({ cls: "strata-sess" });
      const box = row.createEl("input", { type: "checkbox", cls: "strata-sess-box" });
      box.checked = this.picked.has(session.id);
      const text = row.createDiv({ cls: "strata-sess-text" });
      text.createDiv({ cls: "strata-sess-title", text: session.title });
      const meta = text.createDiv({ cls: "strata-sess-meta" });
      meta.createSpan({ text: new Date(session.at).toISOString().slice(0, 10) });
      meta.createSpan({ text: session.project.replace(/^\/Users\/[^/]+/, "~") });
      const toggle = () => {
        if (this.picked.has(session.id)) this.picked.delete(session.id);
        else this.picked.add(session.id);
        box.checked = this.picked.has(session.id);
        row.toggleClass("is-picked", box.checked);
        const add = this.listEl.querySelector<HTMLButtonElement>(".strata-sess-add");
        const n = this.picked.size;
        if (add) {
          add.setText(n ? `Add ${n} session${n === 1 ? "" : "s"}` : "Add");
          add.toggleClass("is-on", n > 0);
          add.disabled = n === 0;
        }
      };
      row.toggleClass("is-picked", box.checked);
      // The whole row is the target. A 13px checkbox is not a click area.
      row.onclick = (e) => {
        if (e.target !== box) toggle();
      };
      box.onclick = () => toggle();
    }
    if (shown.length > 200) {
      host.createDiv({ cls: "strata-find-empty", text: `${shown.length - 200} more — filter to narrow it down.` });
    }
  }

  // --------------------------------------------------------------- overview

  /**
   * The front page: what is being asked of you, and how loudly.
   *
   * Five tabs each with a number is a filing cabinet, not a to-do list — you
   * have to already know which drawer is worth opening. And two of the numbers
   * are not tasks at all: Rhymes and No horizon are standing piles in the
   * hundreds that nobody clears, so listing them the same way as three
   * duplicates trains you to ignore all five.
   *
   * So they are split by what they actually are. **Decide** empties and is
   * worth opening today. **Optional** is your call and never nags. **Standing**
   * is weather: reported honestly, with a handful worth looking at, and no
   * implication that the number is supposed to reach zero.
   */
  private drawOverview(): void {
    // Sessions are loaded lazily by their own tab, and the vault scan runs
    // off-frame. Both were showing as "0 — Nothing waiting" before they had
    // looked, which is a lie of exactly the kind this panel exists to stop:
    // an unknown rendered as a settled zero. Kick the load, and say "not
    // counted yet" until it is.
    if (this.sessionsState === "cold") {
      this.sessionsState = "loading";
      void listSessions(this.app)
        .then((all) => {
          this.sessions = all.sort((a, b) => b.at - a.at);
          this.sessionsState = "ready";
          this.onCounts?.();
          if (this.tab === "overview" || this.tab === "sessions") this.draw();
        })
        .catch(() => {
          this.sessionsState = "ready";
        });
    }
    const counted = this.scanned;
    const sessionsCounted = this.sessionsState === "ready";

    const rows: { kind: string; label: string; n: number; line: string; go: Tab; known: boolean }[] = [
      {
        kind: "Decide",
        label: "Said twice",
        known: counted,
        n: this.echo.length,
        line: "Near-identical notes. Merge, or link them and keep both deliberately.",
        go: "echo",
      },
      {
        kind: "Decide",
        label: "Several ideas",
        known: counted,
        n: this.compounds.length,
        line: "Notes holding more than one idea — the rule that breaks silently.",
        go: "compound",
      },
      {
        kind: "Optional",
        label: "Sessions",
        known: sessionsCounted,
        n: this.unlinked().length,
        line: "Conversations on this machine, not in the graph. Yours to pick; nothing nags.",
        go: "sessions",
      },
      {
        kind: "Standing",
        label: "Rhymes",
        known: counted,
        n: this.resonance.length,
        line: "Notes that relate without sharing a topic. A pile, not a queue — skim the top few.",
        go: "resonance",
      },
      {
        kind: "Standing",
        label: "No horizon",
        known: counted,
        n: this.horizonless.length,
        line: "Missing timeless/situational. Never guess one; fill them when you touch the note.",
        go: "horizon",
      },
    ];

    let group = "";
    for (const row of rows) {
      if (row.kind !== group) {
        group = row.kind;
        this.listEl.createDiv({ cls: "strata-over-group", text: group });
      }
      const live = row.known && row.n > 0;
      const el = this.listEl.createDiv({ cls: `strata-over${live ? "" : " is-clear"}` });
      const head = el.createDiv({ cls: "strata-over-head" });
      head.createSpan({ cls: "strata-over-n", text: row.known ? String(row.n) : "·" });
      head.createSpan({ cls: "strata-over-label", text: row.label });
      el.createDiv({
        cls: "strata-over-line",
        text: !row.known ? "Still counting…" : row.n ? row.line : "Nothing waiting.",
      });
      if (live) {
        el.onclick = () => {
          this.tab = row.go;
          this.draw();
        };
      }
    }
  }

  private name(path: string): string {
    return path.split("/").pop()?.replace(/\.md$/, "").replace(/^note-/, "") ?? path;
  }

  /** Open a file at the passage that matched, not merely at the file. */
  private openAt(path: string, heading: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !heading) return this.openFile(path);
    const anchor = anchorFor(this.app.metadataCache.getFileCache(file)?.headings ?? [], heading);
    if (!anchor) return this.openFile(path);
    void this.app.workspace.openLinkText(`${path}#${anchor}`, "", "tab");
  }

  private openFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
  }

  private empty(message: string): void {
    this.listEl.createDiv({ cls: "strata-find-empty", text: message });
  }

  private drawPairs(pairs: Pair[], isEcho: boolean): void {
    if (!pairs.length) {
      const index = this.plugin.index;
      if (!index?.size) {
        return this.empty('The local model has not read the vault yet. Press "Re-read" above, then come back.');
      }
      // Edges are computed off-frame, so "none yet" and "none at all" are
      // different answers and the difference matters here.
      if (!this.scanned) {
        return this.empty(`Comparing ${index.segmentCount} passages… this fills itself in.`);
      }
      return this.empty(
        isEcho
          ? "Nothing is written twice. That is the good outcome."
          : "No unlinked rhymes left — everything the model found, you have already connected."
      );
    }

    for (const pair of pairs) {
      const row = this.listEl.createDiv({ cls: "strata-find-row" });

      const head = row.createDiv({ cls: "strata-find-rowhead" });
      for (const path of [pair.a, pair.b]) {
        const btn = head.createEl("button", { cls: "strata-find-name", text: this.name(path) });
        btn.onclick = () => this.openFile(path);
      }
      head.createSpan({ cls: "strata-tag", text: `${Math.round(pair.score * 100)}%` });

      // The passages that actually matched. Without them this is a number
      // asking to be believed.
      const match = this.plugin.index?.match(pair.a, pair.b);
      if (match) {
        const quotes = row.createDiv({ cls: "strata-card-quotes" });
        for (const [path, side] of [
          [pair.a, match.a],
          [pair.b, match.b],
        ] as const) {
          const block = quotes.createDiv({ cls: "strata-quote" });
          if (side.heading) block.addClass("is-linked");
          block.createDiv({
            cls: "strata-quote-from",
            text: side.heading ? `${this.name(path)} — ${side.heading}` : this.name(path),
          });
          block.createDiv({ cls: "strata-quote-text", text: side.preview });
          block.onclick = () => this.openAt(path, side.heading);
        }
      }

      const actions = row.createDiv({ cls: "strata-find-actions" });

      if (isEcho) {
        // Which one survives is a real decision and not one the model can make,
        // so both directions are offered rather than a single "Merge".
        for (const [keep, absorb] of [
          [pair.a, pair.b],
          [pair.b, pair.a],
        ] as const) {
          const btn = actions.createEl("button", {
            cls: "strata-open",
            text: `Keep ${this.name(keep)}`,
          });
          btn.onclick = () => {
            void (async () => {
              btn.setAttr("disabled", "true");
              try {
                const repointed = await mergeInto(this.app, keep, absorb);
                new Notice(
                  `${this.name(absorb)} merged into ${this.name(keep)} and archived` +
                    (repointed ? `, and ${repointed} note${repointed > 1 ? "s" : ""} repointed at it.` : ".")
                );
                this.plugin.sweep();
                await this.scan();
              } catch (err) {
                console.error("[strata] merge failed", err);
                new Notice(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
                btn.removeAttribute("disabled");
              }
            })();
          };
        }
      } else {
        const link = actions.createEl("button", { cls: "strata-open", text: "Link them" });
        link.onclick = () => {
          void (async () => {
            const wrote = await linkTo(this.app, pair.a, pair.b);
            new Notice(wrote ? `Linked ${this.name(pair.a)} to ${this.name(pair.b)}` : "Already linked");
            await this.scan();
          })();
        };
      }

      const no = actions.createEl("button", { cls: "strata-open strata-open-quiet", text: "Not really" });
      no.onclick = () => this.plugin.dismiss(pair.a, pair.b);
    }
  }

  private drawCompounds(): void {
    if (!this.compounds.length) return this.empty("Every note holds one idea. Nothing to split.");
    for (const item of this.compounds) {
      const row = this.listEl.createDiv({ cls: "strata-find-row" });
      const head = row.createDiv({ cls: "strata-find-rowhead" });
      const btn = head.createEl("button", { cls: "strata-find-name", text: this.name(item.path) });
      btn.onclick = () => this.openFile(item.path);
      head.createSpan({ cls: "strata-tag", text: `${item.sections} ideas` });
      head.createSpan({ cls: "strata-tag", text: `${(item.chars / 1000).toFixed(1)}k` });
      if (item.marked) {
        head.createSpan({ cls: "strata-tag", text: `${item.marked} seams you marked` });
      }

      const actions = row.createDiv({ cls: "strata-find-actions" });
      const split = actions.createEl("button", { cls: "strata-open", text: "Split into atoms" });
      split.onclick = () => {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) this.plugin.split(file);
      };
    }
  }

  private drawHorizonless(): void {
    if (!this.horizonless.length) return this.empty("Every note has a horizon.");
    // Deliberately open-only. Guessing a horizon is the one thing the schema
    // forbids outright: unset is a visible maintenance item, wrong is invisible
    // damage, so this lists them and hands each one to you.
    for (const file of this.horizonless) {
      const row = this.listEl.createDiv({ cls: "strata-find-row is-compact" });
      const head = row.createDiv({ cls: "strata-find-rowhead" });
      const btn = head.createEl("button", { cls: "strata-find-name", text: this.name(file.path) });
      btn.onclick = () => this.openFile(file.path);
      const captured = this.app.metadataCache.getFileCache(file)?.frontmatter?.captured;
      if (captured) head.createSpan({ cls: "strata-tag", text: String(captured) });
    }
  }
}
