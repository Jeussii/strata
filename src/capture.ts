import { App, Modal, Notice, TFile, debounce, normalizePath } from "obsidian";
import { Passage, SemanticIndex, SemanticSettings } from "./semantic";
import { shape, slugify } from "./atom";
import { appendTo, today } from "./write";

/**
 * Capture, with the duplicate check in front of it.
 *
 * One idea per atom, and nothing fabricated — but neither rule says anything
 * about the same idea arriving twice. In a vault of a couple of hundred notes
 * it is easy to end up with pairs of near-identical notes, filed under
 * different topics and never linked. Every one of those is a capture that
 * should have been an extension.
 *
 * So the model is asked *before* anything is written, not after. Not "what is
 * this like" but "have I already said this" — and if the answer is yes, the
 * cheapest correct action is to grow the note that already exists rather than
 * add a second copy of it to the graph.
 *
 * The write is **append-only and dated.** That is the compromise the revised
 * vault law needs: a body may accrete, but nothing already in it is ever
 * rewritten, so `origin` keeps meaning what it meant and a note still records
 * what was thought on the day it was thought. The dated entries make that
 * history legible without leaving Obsidian.
 */

export interface CaptureResult {
  path: string;
  created: boolean;
}

export class CaptureModal extends Modal {
  private index: SemanticIndex;
  private settings: SemanticSettings;
  private onDone: (result: CaptureResult) => void;

  private text = "";
  private hits: Passage[] = [];
  private checking = false;
  private topics: string[] = [];
  private chosen = new Set<string>();
  private origin = "my-thought";
  private horizon = "";
  private resultsEl!: HTMLElement;
  private folder = "Notes";

  constructor(
    app: App,
    index: SemanticIndex,
    settings: SemanticSettings,
    onDone: (result: CaptureResult) => void
  ) {
    super(app);
    this.index = index;
    this.settings = settings;
    this.onDone = onDone;
    this.topics = app.vault
      .getMarkdownFiles()
      .filter((f) => f.parent?.name === "Topics")
      .map((f) => f.basename)
      .sort((a, b) => a.localeCompare(b));
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("strata-capture-modal");
    contentEl.empty();
    contentEl.createEl("h3", { text: "Capture" });

    const input = contentEl.createEl("textarea", { cls: "strata-capture-input" });
    input.placeholder = "The thought, the quote, the passage…";
    input.rows = 7;

    this.resultsEl = contentEl.createDiv({ cls: "strata-capture-results" });
    this.renderIdle("Type, and the vault will say whether it already knows this.");

    // Debounced hard: every check is an embedding call, and there is no reason
    // to make one per keystroke.
    const check = debounce(() => void this.check(), 700, false);
    input.oninput = () => {
      this.text = input.value;
      if (this.text.trim().length < 24) {
        this.hits = [];
        this.renderIdle("Type, and the vault will say whether it already knows this.");
        return;
      }
      this.renderIdle("Checking…");
      check();
    };

    input.focus();
    this.buildNewAtom(contentEl);
  }

  private renderIdle(message: string) {
    this.resultsEl.empty();
    this.resultsEl.createDiv({ cls: "strata-capture-hint", text: message });
  }

  private async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      this.hits = await this.index.nearest(this.text, this.settings, 4);
      this.renderHits();
    } catch (err) {
      console.error("[strata] duplicate check failed", err);
      this.renderIdle(
        this.index.size === 0
          ? "Nothing indexed yet, so nothing to compare against."
          : "Could not reach the local model — capture still works, the check does not."
      );
    } finally {
      this.checking = false;
    }
  }

  private renderHits() {
    this.resultsEl.empty();
    const strong = this.hits.filter((h) => h.score >= this.settings.floor);
    if (!strong.length) {
      this.resultsEl.createDiv({ cls: "strata-capture-hint is-clear", text: "Nothing like this in the vault yet." });
      return;
    }

    const top = strong[0];
    const duplicate = top.score >= this.settings.echoAt;
    this.resultsEl.createDiv({
      cls: `strata-capture-verdict${duplicate ? " is-duplicate" : ""}`,
      text: duplicate ? "You have written this already." : "Related notes already exist.",
    });

    for (const hit of strong) {
      const row = this.resultsEl.createDiv({ cls: "strata-capture-hit" });
      const head = row.createDiv({ cls: "strata-capture-hithead" });
      head.createSpan({
        cls: "strata-capture-name",
        text: hit.path.split("/").pop()?.replace(/\.md$/, "").replace(/^note-/, "") ?? hit.path,
      });
      head.createSpan({ cls: "strata-tag", text: `${Math.round(hit.score * 100)}%` });
      if (hit.heading) head.createSpan({ cls: "strata-capture-section", text: hit.heading });

      row.createDiv({ cls: "strata-capture-preview", text: hit.preview });

      const actions = row.createDiv({ cls: "strata-capture-actions" });
      const add = actions.createEl("button", { cls: "strata-open", text: "Add to this note" });
      add.onclick = () => void this.append(hit.path);
      const open = actions.createEl("button", { cls: "strata-open strata-open-quiet", text: "Open" });
      open.onclick = () => {
        const file = this.app.vault.getAbstractFileByPath(hit.path);
        if (file instanceof TFile) this.app.workspace.getLeaf("tab").openFile(file);
        this.close();
      };
    }
  }

  /** The other branch: it really is new. Frontmatter is filled in here or the atom is invalid. */
  private buildNewAtom(root: HTMLElement) {
    const box = root.createDiv({ cls: "strata-capture-new" });
    box.createDiv({ cls: "strata-capture-newlabel", text: "Or make it a new atom" });

    const row = box.createDiv({ cls: "strata-capture-row" });

    const origin = row.createEl("select", { cls: "strata-select" });
    for (const value of ["my-thought", "my-summary", "ai-summary", "quote", "highlight"]) {
      origin.createEl("option", { value, text: value });
    }
    origin.value = this.origin;
    origin.onchange = () => (this.origin = origin.value);

    const horizon = row.createEl("select", { cls: "strata-select" });
    for (const [value, label] of [
      ["", "horizon: not yet decided"],
      ["timeless", "timeless"],
      ["situational", "situational"],
    ] as const) {
      horizon.createEl("option", { value, text: label });
    }
    horizon.onchange = () => (this.horizon = horizon.value);

    const picker = row.createEl("select", { cls: "strata-select" });
    picker.createEl("option", { value: "", text: "add a topic…" });
    for (const topic of this.topics) picker.createEl("option", { value: topic, text: topic });

    const chips = box.createDiv({ cls: "strata-capture-chips" });
    const drawChips = () => {
      chips.empty();
      for (const topic of this.chosen) {
        const chip = chips.createEl("button", { cls: "strata-word is-removable", text: `${topic}  ×` });
        chip.onclick = () => {
          this.chosen.delete(topic);
          drawChips();
        };
      }
    };
    picker.onchange = () => {
      if (picker.value) this.chosen.add(picker.value);
      picker.value = "";
      drawChips();
    };

    const create = box.createEl("button", { cls: "strata-open", text: "Create atom" });
    create.onclick = () => void this.create();
  }

  private async append(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await appendTo(this.app, file, this.text);
    new Notice(`Added to ${file.basename.replace(/^note-/, "")}`);
    this.onDone({ path, created: false });
    this.close();
  }

  private async create() {
    const text = this.text.trim();
    if (text.length < 10) {
      new Notice("Nothing to capture yet.");
      return;
    }
    // The schema requires at least one topic. Refusing here is the whole
    // point: an atom with nothing to be about is not an atom.
    if (!this.chosen.size) {
      new Notice("An atom needs at least one topic.");
      return;
    }

    // `slugify` already falls back to "untitled"; the old fallback here prefixed
    // `note-` a second time and produced `note-note-2026-01-14`.
    const slug = slugify(text.split(/[.\n]/)[0] || text);
    let path = normalizePath(`${this.folder}/note-${slug}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${this.folder}/note-${slug}-${n++}.md`);
    }

    const fm = [
      "---",
      "type: note",
      `origin: ${this.origin}`,
      ...(this.horizon ? [`horizon: ${this.horizon}`] : []),
      "topics:",
      ...[...this.chosen].map((t) => `  - "[[${t}]]"`),
      `captured: ${today()}`,
      "---",
      "",
    ].join("\n");

    // Body shape follows origin, exactly as the schema says it must.
    // Shared with the split workspace: two places that shape a body by `origin`
    // would drift, and a drifted `ai-summary` presents the model's words as yours.
    const body = shape(text, this.origin);

    const file = await this.app.vault.create(path, `${fm}${body}\n`);
    new Notice(`Created ${file.basename}`);
    this.onDone({ path, created: true });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
