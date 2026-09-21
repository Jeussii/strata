import { App, Modal, Notice, TFile } from "obsidian";
import { SessionMeta } from "./sessions";
import { today } from "./write";

/**
 * The other kind of session.
 *
 * Claude Code leaves transcripts on this machine, so a session node can be
 * discovered, parsed, and joined to the notes it actually wrote. Gemini and
 * ChatGPT leave nothing: the conversation lives on someone else's server behind
 * a login, and there is no file to read.
 *
 * So the door is different, and honestly so. Nothing is scraped, nothing is
 * inferred — you name the chat, paste its URL, and pick the notes it
 * produced. That last part is the whole value: a session node with no edges is
 * a dot, and what makes the sessions layer worth having is the line from a
 * conversation to the thinking that came out of it.
 *
 * It is more typing than the Claude Code picker, and that asymmetry is a fact
 * about the platforms rather than a gap in the design.
 */

export class WebChatModal extends Modal {
  private onDone: (meta: SessionMeta) => void;

  private provider: "gemini" | "chatgpt" = "gemini";
  private title = "";
  private url = "";
  private date = today();
  private chosen = new Set<string>();

  private notes: TFile[];
  private chipsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private hitsEl!: HTMLElement;

  constructor(app: App, onDone: (meta: SessionMeta) => void) {
    super(app);
    this.onDone = onDone;
    this.notes = app.vault
      .getMarkdownFiles()
      .filter((f) => {
        const folder = f.parent?.name ?? "";
        return folder !== "Topics" && folder !== "Sources" && folder !== "Full";
      })
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("strata-capture-modal");
    contentEl.empty();
    contentEl.createEl("h3", { text: "Add a web chat" });
    contentEl.createDiv({
      cls: "strata-capture-hint",
      text: "Gemini and ChatGPT keep their transcripts on their own servers, so this one is filled in by hand.",
    });

    const row = contentEl.createDiv({ cls: "strata-capture-row" });

    const provider = row.createEl("select", { cls: "strata-select" });
    for (const [value, label] of [
      ["gemini", "Gemini"],
      ["chatgpt", "ChatGPT"],
    ] as const) {
      provider.createEl("option", { value, text: label });
    }
    provider.onchange = () => (this.provider = provider.value as "gemini" | "chatgpt");

    const when = row.createEl("input", { cls: "strata-select", type: "date" });
    when.value = this.date;
    when.onchange = () => (this.date = when.value || today());

    const title = contentEl.createEl("input", { cls: "strata-split-title", type: "text" });
    title.placeholder = "What the conversation was about";
    title.oninput = () => (this.title = title.value);

    const url = contentEl.createEl("input", { cls: "strata-split-title", type: "text" });
    url.placeholder = "Share link (optional, but it is the only way back)";
    url.oninput = () => (this.url = url.value.trim());

    contentEl.createDiv({ cls: "strata-capture-newlabel", text: "Notes this conversation produced" });
    this.searchEl = contentEl.createEl("input", { cls: "strata-search", type: "text" });
    this.searchEl.placeholder = "Find a note…";
    this.searchEl.oninput = () => this.drawHits();

    this.hitsEl = contentEl.createDiv({ cls: "strata-webchat-hits" });
    this.chipsEl = contentEl.createDiv({ cls: "strata-capture-chips" });
    this.drawHits();
    this.drawChips();

    const add = contentEl.createEl("button", { cls: "strata-open", text: "Add to the graph" });
    add.onclick = () => this.commit();
    title.focus();
  }

  private drawHits() {
    this.hitsEl.empty();
    const query = this.searchEl.value.trim().toLowerCase();
    if (!query) return;
    const hits = this.notes
      .filter((f) => f.basename.toLowerCase().includes(query) && !this.chosen.has(f.path))
      .slice(0, 6);
    for (const file of hits) {
      const btn = this.hitsEl.createEl("button", {
        cls: "strata-find-name",
        text: file.basename.replace(/^note-/, ""),
      });
      btn.onclick = () => {
        this.chosen.add(file.path);
        this.searchEl.value = "";
        this.drawHits();
        this.drawChips();
      };
    }
  }

  private drawChips() {
    this.chipsEl.empty();
    for (const path of this.chosen) {
      const name = path.split("/").pop()?.replace(/\.md$/, "").replace(/^note-/, "") ?? path;
      const chip = this.chipsEl.createEl("button", { cls: "strata-word is-removable", text: `${name}  ×` });
      chip.onclick = () => {
        this.chosen.delete(path);
        this.drawChips();
        this.drawHits();
      };
    }
  }

  private commit() {
    const title = this.title.trim();
    if (!title) {
      new Notice("Give the conversation a name.");
      return;
    }
    if (!this.chosen.size) {
      new Notice("Pick at least one note, or the session has nothing to connect to.");
      return;
    }
    const at = Date.parse(`${this.date}T12:00:00`);
    this.onDone({
      // Prefixed so a hand-added chat can never collide with a Claude Code
      // session id, and the date keeps two chats on one topic apart.
      id: `web-${this.provider}-${this.date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
      file: this.url,
      project: this.url || `${this.provider} chat`,
      title,
      at: Number.isNaN(at) ? Date.now() : at,
      provider: this.provider,
      wrote: [...this.chosen],
      read: 0,
    });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
