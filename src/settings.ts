import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type StrataPlugin from "./main";
import { probe } from "./ollama";
import { DEFAULT_SEMANTIC } from "./semantic";

/**
 * The dials that decide what the semantic layers mean.
 *
 * These are exposed rather than fixed because the right numbers depend on the
 * vault: similarity from an embedding model is not calibrated in the abstract,
 * only against a particular collection of writing. The defaults here were
 * measured against a real vault, not guessed, and the copy says so — a
 * threshold you
 * cannot see is a threshold you cannot trust.
 */
export class StrataSettingTab extends PluginSettingTab {
  private plugin: StrataPlugin;

  constructor(app: App, plugin: StrataPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const s = this.plugin.data.semantic;

    containerEl.createEl("h3", { text: "Local model" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Strata reads your notes with a model running on this machine. Nothing is sent anywhere, " +
        "and there is no API key to hold.",
    });

    new Setting(containerEl)
      .setName("Ollama host")
      .setDesc("Where Ollama is listening.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SEMANTIC.host)
          .setValue(s.host)
          .onChange(async (v) => {
            s.host = v.trim() || DEFAULT_SEMANTIC.host;
            await this.plugin.saveData(this.plugin.data);
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Changing this invalidates the index: two models do not share a vector space.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SEMANTIC.model)
          .setValue(s.model)
          .onChange(async (v) => {
            s.model = v.trim() || DEFAULT_SEMANTIC.model;
            await this.plugin.saveData(this.plugin.data);
          })
      );

    new Setting(containerEl)
      .setName("Read in the background")
      .setDesc(
        "Embed notes on idle, a note at a time, as they change. Off means the vault is only read when you press the button."
      )
      .addToggle((t) =>
        t.setValue(s.background).onChange(async (v) => {
          s.background = v;
          await this.plugin.saveData(this.plugin.data);
          if (v) this.plugin.sweep();
          else this.plugin.runner?.stop();
        })
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Check that Ollama is up and the model is pulled.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const status = await probe(s.host);
          if (!status.up) {
            new Notice(`No Ollama at ${s.host}${status.error ? ` (${status.error})` : ""}`);
            return;
          }
          const has = status.models.some((m) => m === s.model || m.startsWith(`${s.model}:`));
          new Notice(
            has
              ? `Ollama is up, ${s.model} is pulled.`
              : `Ollama is up, but ${s.model} is not pulled. Run: ollama pull ${s.model}`
          );
        })
      );

    containerEl.createEl("h3", { text: "What counts as a connection" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "A note is only ever joined to a note that also ranks it among its own nearest — " +
        "otherwise your longest note becomes similar to everything and drowns the graph.",
    });

    new Setting(containerEl)
      .setName("Neighbours per note")
      .setDesc("How many nearest notes each note may claim. Higher means more edges, and more noise.")
      .addSlider((sl) =>
        sl
          .setLimits(1, 10, 1)
          .setValue(s.k)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.k = v;
            await this.plugin.saveData(this.plugin.data);
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("Resonance floor")
      .setDesc("Below this, similarity only means both notes are written in the same language. Measured default: 0.74.")
      .addSlider((sl) =>
        sl
          .setLimits(0.5, 0.95, 0.01)
          .setValue(s.floor)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.floor = Math.min(v, s.echoAt - 0.01);
            await this.plugin.saveData(this.plugin.data);
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("Echo threshold")
      .setDesc(
        "Two notes are the same note when a passage scores at least this AND half their content overlaps. " +
          "Without the second test a note that merely cites another gets called a duplicate. Measured default: 0.88."
      )
      .addSlider((sl) =>
        sl
          .setLimits(0.6, 0.99, 0.01)
          .setValue(s.echoAt)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.echoAt = Math.max(v, s.floor + 0.01);
            await this.plugin.saveData(this.plugin.data);
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("Index")
      .setDesc(`${this.plugin.index?.size ?? 0} notes, ${this.plugin.index?.segmentCount ?? 0} passages embedded.`)
      .addButton((b) =>
        b.setButtonText("Delete and start over").onClick(async () => {
          this.plugin.runner?.reset();
          await this.plugin.index?.clear();
          this.plugin.refreshViews();
          new Notice("Semantic index deleted.");
          this.display();
        })
      );
  }
}
