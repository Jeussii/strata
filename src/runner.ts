import type { Doc } from "./docs";
import { SemanticIndex, SemanticSettings } from "./semantic";
import { probe } from "./ollama";

/**
 * Reading the vault without anyone noticing.
 *
 * The rule this exists to enforce: **opening the graph never waits on a model.**
 * The first version indexed in one long await, which meant a cold vault sat
 * there doing nothing visible while a few hundred embeddings went through. That
 * is the wrong trade — the graph is useful without the semantic layers, so it
 * should appear immediately and gain them as they arrive.
 *
 * So the work is broken to one note per slot and scheduled on idle. Each note is
 * a handful of passages, which is a single round trip to a local model: tens of
 * milliseconds, between frames, invisible. The queue survives being paused and
 * picks up where it stopped, because it is keyed on files rather than an offset.
 *
 * It backs off rather than failing loudly. Ollama not running is the normal
 * state of a laptop, not an error worth a dialog — the runner sleeps and tries
 * again, and only says something when you asked for the pass yourself.
 */

/** Long enough that a burst of typing wins the CPU, short enough to finish. */
const IDLE_TIMEOUT = 2000;
const GAP_MS = 120;
const BACKOFF_MS = 90_000;
const MAX_FAILURES = 3;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export interface RunnerState {
  running: boolean;
  done: number;
  total: number;
  /** set when the model could not be reached, so the UI can say why nothing happened */
  blocked: string | null;
}

export class IndexRunner {
  private index: SemanticIndex;
  private settings: () => SemanticSettings;

  private queue: Doc[] = [];
  private done = 0;
  private total = 0;
  private active = false;
  private stopped = false;
  private failures = 0;
  private blocked: string | null = null;
  private timer: number | null = null;
  private idle: number | null = null;
  private dirty = false;

  onChange: (() => void) | null = null;

  constructor(index: SemanticIndex, settings: () => SemanticSettings) {
    this.index = index;
    this.settings = settings;
  }

  get state(): RunnerState {
    return { running: this.active, done: this.done, total: this.total, blocked: this.blocked };
  }

  /**
   * Queue work. Files already queued are not queued twice, so this is safe to
   * call from a file-change handler as often as it fires.
   */
  enqueue(files: Doc[]): void {
    const known = new Set(this.queue.map((f) => f.key));
    let added = 0;
    for (const file of files) {
      if (known.has(file.key)) continue;
      this.queue.push(file);
      added++;
    }
    if (!added) return;
    this.total += added;
    this.onChange?.();
    if (!this.active) this.start();
  }

  start(): void {
    if (this.active || !this.queue.length) return;
    this.stopped = false;
    this.active = true;
    this.blocked = null;
    this.failures = 0;
    this.onChange?.();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.active = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    const w = window as IdleWindow;
    if (this.idle !== null && w.cancelIdleCallback) w.cancelIdleCallback(this.idle);
    this.timer = null;
    this.idle = null;
    void this.flush();
    this.onChange?.();
  }

  /** Drop everything pending — the model changed, or the index was deleted. */
  reset(): void {
    this.stop();
    this.queue = [];
    this.done = 0;
    this.total = 0;
    this.dirty = false;
    this.onChange?.();
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.index.save();
    } catch (err) {
      console.error("[strata] could not save the index", err);
    }
  }

  /**
   * Wait for a quiet moment, then take one note.
   *
   * `requestIdleCallback` with a timeout is the whole trick: it yields to
   * anything the user is doing, but the timeout guarantees the pass still
   * finishes on a busy machine rather than starving forever.
   */
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = window.setTimeout(() => {
      const w = window as IdleWindow;
      if (w.requestIdleCallback) {
        this.idle = w.requestIdleCallback(() => void this.step(), { timeout: IDLE_TIMEOUT });
      } else {
        void this.step();
      }
    }, delay);
  }

  private async step(): Promise<void> {
    if (this.stopped) return;

    const file = this.queue[0];
    if (!file) {
      this.active = false;
      this.done = 0;
      this.total = 0;
      await this.flush();
      this.onChange?.();
      return;
    }

    try {
      await this.index.ingest(file, this.settings());
      this.queue.shift();
      this.done++;
      this.dirty = true;
      this.failures = 0;
      // Save periodically, so killing Obsidian mid-pass does not throw away
      // twenty minutes of embedding.
      if (this.done % 25 === 0) await this.flush();
      this.onChange?.();
      this.schedule(GAP_MS);
    } catch (err) {
      // Deleted or renamed while it sat in the queue. Not a failure, and not a
      // reason to back off — the sweep will re-enumerate what is actually there.
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file|not found/i.test(message)) {
        this.queue.shift();
        this.done++;
        this.schedule(0);
        return;
      }
      this.failures++;
      const status = await probe(this.settings().host);
      this.blocked = status.up
        ? err instanceof Error
          ? err.message
          : String(err)
        : "waiting for Ollama";
      this.onChange?.();

      if (!status.up) {
        // Not an error condition. A laptop without Ollama running is the normal
        // case, and the right response is to sleep, not to complain.
        this.schedule(BACKOFF_MS);
        return;
      }
      if (this.failures < MAX_FAILURES) {
        this.schedule(BACKOFF_MS);
        return;
      }
      // The model is up and this particular file still will not go through.
      // Drop it rather than stall: leaving it at the head of the queue blocks
      // every note behind it, permanently, for one bad file.
      console.error(`[strata] skipping ${file.key} after ${this.failures} failures`, err);
      this.queue.shift();
      this.done++;
      this.failures = 0;
      this.onChange?.();
      this.schedule(GAP_MS);
    }
  }
}
