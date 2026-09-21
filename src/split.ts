import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import { Segment, bodyOf, segment } from "./segment";
import { Proposal, propose } from "./distil";
import { Original, composeAtom, slugify, today, uniqueName } from "./atom";

/**
 * Turning one note that is secretly several notes into several notes.
 *
 * In a real vault a handful of the longest notes hold a large share of the text
 * and a great many headed sections between them.
 * `note-a-long-unsplit-document` is one file containing ten separately-titled
 * ideas, two of which are named mental models, filed under two topics. The rule
 * has been broken silently the whole time, because nothing could check it.
 *
 * The rules this screen holds to:
 *
 *   **Passages move verbatim.** Not one sentence is reworded, reordered or
 *   summarised. That is what keeps `origin: my-thought` true of the atoms —
 *   they are still your words, filed better.
 *
 *   **Nothing happens without the button.** The model pre-fills a form; every
 *   field is editable and every passage can be dropped or merged into its
 *   neighbour. The split is one explicit action on one note at a time.
 *
 *   **The original survives whole.** It moves to `Vault/Full/`, which is not a
 *   node and is never embedded, and every atom points back at it with `full:`.
 *   Nothing is deleted, so the original is always recoverable.
 */

export type Disposition = "atom" | "merge" | "drop";

interface Row {
  passage: Segment;
  state: Disposition;
  title: string;
  topics: Set<string>;
  horizon: string;
  el?: HTMLElement;
}

/** The original's own frontmatter, which the atoms inherit rather than invent. */
function readOriginal(app: App, file: TFile): Original {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const link = (raw: unknown): string => {
    if (typeof raw !== "string") return "";
    const m = raw.trim().match(/^\[\[([^\]|#]+)/);
    return (m ? m[1] : raw).trim();
  };
  const list = Array.isArray(fm.topics) ? fm.topics : fm.topics ? [fm.topics] : [];
  return {
    origin: typeof fm.origin === "string" ? fm.origin : "my-thought",
    source: link(fm.source),
    captured: fm.captured ? String(fm.captured) : today(),
    topics: list.map(link).filter(Boolean),
  };
}

export class SplitModal extends Modal {
  private file: TFile;
  private rows: Row[] = [];
  private original: Original;
  private topics: string[];
  private host: string;
  private model: string;
  private onDone: () => void;

  private listEl!: HTMLElement;
  private askBtn!: HTMLButtonElement;
  private footEl!: HTMLElement;
  private busy = false;

  constructor(
    app: App,
    file: TFile,
    settings: { host: string; model: string },
    onDone: () => void
  ) {
    super(app);
    this.file = file;
    this.host = settings.host;
    this.model = settings.model;
    this.onDone = onDone;
    this.original = readOriginal(app, file);
    this.topics = app.vault
      .getMarkdownFiles()
      .filter((f) => f.parent?.name === "Topics")
      .map((f) => f.basename)
      .sort((a, b) => a.localeCompare(b));
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("strata-split-modal");
    contentEl.empty();

    const raw = await this.app.vault.cachedRead(this.file);
    const passages = segment(raw);
    this.rows = passages.map((passage) => ({
      passage,
      state: "atom" as Disposition,
      title: passage.heading || this.file.basename.replace(/^note-/, "").replace(/-/g, " "),
      // Seeded from the original's own topics, so a split with no model running
      // still produces schema-valid atoms.
      topics: new Set(this.original.topics),
      horizon: "",
    }));

    const head = contentEl.createDiv({ cls: "strata-split-head" });
    head.createEl("h3", { text: this.file.basename.replace(/^note-/, "") });
    head.createDiv({
      cls: "strata-split-sub",
      text: `${passages.length} passages · ${(bodyOf(raw).length / 1000).toFixed(1)}k characters · currently ${
        this.original.topics.length
      } topic${this.original.topics.length === 1 ? "" : "s"}`,
    });

    const actions = head.createDiv({ cls: "strata-split-actions" });
    this.askBtn = actions.createEl("button", { cls: "strata-chip strata-chip-plain", text: "Ask the model" });
    this.askBtn.onclick = () => void this.ask();

    this.listEl = contentEl.createDiv({ cls: "strata-split-list" });
    this.drawRows();

    this.footEl = contentEl.createDiv({ cls: "strata-split-foot" });
    this.drawFoot();
  }

  private drawRows() {
    this.listEl.empty();
    this.rows.forEach((row, i) => {
      const el = this.listEl.createDiv({ cls: `strata-split-row is-${row.state}` });
      row.el = el;

      const bar = el.createDiv({ cls: "strata-split-bar" });
      const states: [Disposition, string, string][] = [
        ["atom", "Atom", "Becomes its own note."],
        ["merge", "Merge up", "Joins the atom above instead of standing alone."],
        ["drop", "Drop", "Connective text, not an idea. Stays in the archived original."],
      ];
      for (const [state, label, hint] of states) {
        // Merging into nothing is not a state; the first passage cannot merge up.
        if (state === "merge" && i === 0) continue;
        const btn = bar.createEl("button", {
          cls: `strata-split-state${row.state === state ? " is-on" : ""}`,
          text: label,
        });
        btn.title = hint;
        btn.onclick = () => {
          row.state = state;
          this.drawRows();
          this.drawFoot();
        };
      }

      if (row.passage.heading) {
        bar.createSpan({ cls: "strata-split-heading", text: row.passage.heading });
      }

      if (row.state === "atom") {
        const fields = el.createDiv({ cls: "strata-split-fields" });
        const title = fields.createEl("input", { cls: "strata-split-title", type: "text" });
        title.value = row.title;
        title.placeholder = "what this idea is called";
        title.oninput = () => {
          row.title = title.value;
          this.drawFoot();
        };

        const horizon = fields.createEl("select", { cls: "strata-select" });
        for (const [value, label] of [
          ["", "not yet decided"],
          ["timeless", "timeless"],
          ["situational", "situational"],
        ] as const) {
          horizon.createEl("option", { value, text: label });
        }
        horizon.value = row.horizon;
        horizon.onchange = () => (row.horizon = horizon.value);

        const picker = fields.createEl("select", { cls: "strata-select" });
        picker.createEl("option", { value: "", text: "add topic…" });
        for (const topic of this.topics) picker.createEl("option", { value: topic, text: topic });
        picker.onchange = () => {
          if (picker.value) row.topics.add(picker.value);
          picker.value = "";
          this.drawRows();
          this.drawFoot();
        };

        const chips = el.createDiv({ cls: "strata-capture-chips" });
        for (const topic of row.topics) {
          const chip = chips.createEl("button", { cls: "strata-word is-removable", text: `${topic}  ×` });
          chip.onclick = () => {
            row.topics.delete(topic);
            this.drawRows();
            this.drawFoot();
          };
        }
      }

      el.createDiv({ cls: "strata-split-text", text: row.passage.text });
    });
  }

  private groups(): Row[][] {
    const out: Row[][] = [];
    for (const row of this.rows) {
      if (row.state === "drop") continue;
      // A merge with nothing above it — because everything above was dropped —
      // has to stand on its own, or the passage would vanish without being
      // dropped and the count would quietly lie.
      if (row.state === "merge" && out.length) {
        out[out.length - 1].push(row);
        continue;
      }
      out.push([row]);
    }
    return out;
  }

  private drawFoot() {
    this.footEl.empty();
    const groups = this.groups();
    const dropped = this.rows.filter((r) => r.state === "drop").length;
    const untagged = groups.filter((g) => g[0].topics.size === 0).length;

    // Who points at this note today. Their links follow it into the archive,
    // which is a real consequence and gets said out loud rather than discovered.
    const inbound = Object.entries(this.app.metadataCache.resolvedLinks).filter(
      ([from, targets]) => from !== this.file.path && this.file.path in targets
    ).length;

    const lines = [
      `${groups.length} atom${groups.length === 1 ? "" : "s"}` + (dropped ? `, ${dropped} dropped` : ""),
      `the original moves to Vault/Full/ and every atom points back at it`,
    ];
    if (inbound) {
      lines.push(`${inbound} note${inbound === 1 ? "" : "s"} link here — those links will follow it into the archive`);
    }
    for (const line of lines) this.footEl.createDiv({ cls: "strata-split-note", text: line });

    const go = this.footEl.createEl("button", { cls: "strata-open", text: `Split into ${groups.length}` });
    go.disabled = this.busy || groups.length === 0 || untagged > 0;
    if (untagged) {
      this.footEl.createDiv({
        cls: "strata-split-note is-warn",
        text: `${untagged} atom${untagged === 1 ? " has" : "s have"} no topic. An atom with nothing to be about is not an atom.`,
      });
    }
    go.onclick = () => void this.run();
  }

  private async ask() {
    if (this.busy) return;
    this.busy = true;
    this.askBtn.addClass("is-working");
    const targets = this.rows.filter((r) => r.state === "atom");
    const noteTitle = this.file.basename.replace(/^note-/, "").replace(/-/g, " ");

    try {
      let done = 0;
      for (const row of targets) {
        this.askBtn.setText(`Reading ${++done}/${targets.length}`);
        const p: Proposal = await propose(this.host, this.model, row.passage, noteTitle, this.topics);
        row.title = p.title || row.title;
        row.horizon = p.horizon;
        // Union, not replacement: the original's own topics were a deliberate
        // choice and the model does not get to overrule them.
        for (const topic of p.topics) row.topics.add(topic);
      }
      this.drawRows();
    } catch (err) {
      console.error("[strata] proposals failed", err);
      new Notice("Could not reach the local model. The fields are still yours to fill.");
    } finally {
      this.busy = false;
      this.askBtn.removeClass("is-working");
      this.askBtn.setText("Ask the model");
      this.drawFoot();
    }
  }

  private async run() {
    if (this.busy) return;
    const groups = this.groups();
    if (!groups.length) return;
    this.busy = true;

    try {
      const used = new Set(this.app.vault.getMarkdownFiles().map((f) => f.basename.toLowerCase()));
      const folder = this.file.parent?.path ?? "Notes";

      // Resolved before any atom is written, because every atom's `full:` link
      // points at it and a colliding name would make that link ambiguous.
      used.delete(this.file.basename.toLowerCase());
      const archiveName = uniqueName(this.file.basename.replace(/^note-/, ""), used);
      const created: string[] = [];

      // The original moves first.
      //
      // It has to: an atom's title often slugifies to the original's own name —
      // the first passage of `note-a-long-unsplit-document` is "A Long Unsplit
      // Document" — and creating it while the original still sits at that path
      // fails outright. Moving first frees the name, makes every `full:` link
      // resolve immediately, and leaves the whole original safe in the archive
      // if anything downstream throws.
      if (!this.app.vault.getAbstractFileByPath("Full")) {
        await this.app.vault.createFolder("Full");
      }
      const archivePath = normalizePath(`Full/${archiveName}.md`);
      await this.app.fileManager.renameFile(this.file, archivePath);

      // An archive is not a node: it keeps its provenance and loses its wiring.
      const moved = this.app.vault.getAbstractFileByPath(archivePath);
      if (moved instanceof TFile) {
        await this.app.fileManager.processFrontMatter(moved, (fm) => {
          fm.type = "full";
          fm.captured = this.original.captured;
          if (this.original.source) fm.source = `[[${this.original.source}]]`;
          for (const key of ["topics", "origin", "horizon", "full", "bridges"]) delete fm[key];
        });
      }

      for (const group of groups) {
        const lead = group[0];
        const base = uniqueName(`note-${slugify(lead.title)}`, used);
        await this.app.vault.create(
          normalizePath(`${folder}/${base}.md`),
          composeAtom({
            title: lead.title,
            topics: [...lead.topics],
            horizon: lead.horizon,
            body: group.map((r) => r.passage.raw).join("\n\n"),
            original: this.original,
            archive: archiveName,
          })
        );
        created.push(base);
      }

      new Notice(`Split into ${created.length} atoms. The original is in Vault/Full/.`);
      this.onDone();
      this.close();
    } catch (err) {
      console.error("[strata] split failed", err);
      new Notice(`Split failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
