import { App, FileSystemAdapter } from "obsidian";

/**
 * AI sessions as graph nodes — added one at a time, by hand.
 *
 * An earlier version scanned every transcript under ~/.claude/projects and put
 * whatever it found on the canvas. That was wrong in the same way an automatic
 * capture pipeline is wrong: it produces a landfill, not a graph. Nothing here
 * discovers anything on its own any more. A session is picked, and only then is
 * its transcript parsed and its node created.
 *
 * Two operations, deliberately unequal in cost:
 *
 *   listSessions()  cheap. Reads the head of each transcript for a title, to
 *                   feed the picker. Touches a few hundred KB, not the whole store.
 *   parseSession()  expensive, and runs for exactly one file: the chosen one.
 */

export type Provider = "claude" | "gemini" | "chatgpt";

export interface SessionRef {
  id: string;
  file: string;
  project: string;
  title: string;
  at: number;
  provider: Provider;
}

export interface SessionMeta extends SessionRef {
  /** vault-relative paths this session actually wrote to */
  wrote: string[];
  /** how many vault files it merely read, for context */
  read: number;
  /**
   * What the conversation was about.
   *
   * Derived, not declared — a transcript has no frontmatter to put topics in.
   * Where possible it is *fact* rather than inference: the union of the topics
   * carried by the notes the session actually wrote. A conversation that
   * produced five atoms is about whatever those five atoms are about, and no
   * classifier is needed to say so — which matters, because measured against
   * notes already filed by hand, every classifier gets topic assignment wrong
   * more often than right.
   */
  topics?: string[];
}

const HEAD_BYTES = 128 * 1024;

/** Only tool inputs carry `file_path`, so this never fires on prose. */
const FILE_PATH = /"file_path":"((?:[^"\\]|\\.)*)"/g;
/** A tool name close in front of a file_path is what separates writing from reading. */
const WRITER = /"name":"(Write|Edit|MultiEdit|NotebookEdit)"/;
const LOOKBACK = 300;

/**
 * Node builtins, the way an Obsidian desktop plugin gets them. `await import()`
 * compiles to esbuild's CommonJS interop shim and hides the module under
 * `.default`; a dynamic `import(variable)` cannot be resolved at build time at
 * all. Electron's `require` is the thing that works.
 */
function nodeModule<T>(name: string): T {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (!req) throw new Error(`Strata needs Electron's require to load ${name}`);
  return req(name) as T;
}

function projectsRoot(): string | null {
  const home = process.env.HOME;
  return home ? `${home}/.claude/projects` : null;
}

/** The first real user message, which is as close to a title as a session has. */
/**
 * What the session is called.
 *
 * Claude Code writes its own title into the transcript — `custom-title` when
 * you renamed it, `ai-title` otherwise — and both are far better than what
 * this used to do, which was quote the opening words of the first prompt. A
 * session called "Can you have a look at the thi…" tells you nothing; the same
 * session's real title is "Rewrite the export pipeline".
 *
 * Preference order is deliberate: your name for it beats the model's name for
 * it, and either beats guessing from the prose. The first prompt survives only
 * as a last resort, and a recent transcript nearly always has a title, so it
 * should rarely fire.
 */
function titleFrom(head: string): string {
  let ai = "";
  let custom = "";
  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "custom-title" && !custom) {
        custom = String(parsed.customTitle ?? parsed.title ?? "").trim();
      } else if (parsed.type === "ai-title" && !ai) {
        ai = String(parsed.aiTitle ?? parsed.title ?? "").trim();
      }
    } catch {
      continue;
    }
  }
  const named = custom || ai;
  if (named) return named.length > 72 ? `${named.slice(0, 69)}…` : named;

  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "user") continue;
    const message = parsed.message as { content?: unknown } | undefined;
    const content = message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const block = content.find(
        (b) => b && typeof b === "object" && (b as { type?: string }).type === "text"
      ) as { text?: string } | undefined;
      text = block?.text ?? "";
    }
    text = text.trim();
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) continue;
    return text.length > 64 ? `${text.slice(0, 61)}…` : text;
  }
  return "untitled session";
}

/**
 * Where the session actually ran.
 *
 * The folder name is a lossy encoding: Claude Code replaces every separator
 * *and* every hyphen, space and tilde with `-`, so `-Users-you-Notes`
 * round-trips but a vault kept inside a sync container does not: the spaces
 * and separators in a path like `Library/Mobile Documents/…` cannot be told
 * back apart, so it decodes to a directory that does not exist. Project roots
 * decode to nothing that way, and "Resume in Claude Code" would have cd'd into
 * a missing folder.
 *
 * The transcript carries the real path in `cwd`, so that is what is used, and
 * the folder name is only the fallback for a transcript too old to have one.
 */
function cwdFrom(head: string): string | null {
  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function decodeProject(folder: string): string {
  return folder.replace(/^-/, "/").replace(/-/g, "/");
}

/** Read just the first slice of a file, rather than loading all of it. */
async function readHead(path: string, bytes: number): Promise<string> {
  const fs = nodeModule<typeof import("node:fs/promises")>("node:fs/promises");
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Every Claude Code session on this machine, newest first, for the picker.
 * Reads only the head of each transcript.
 */
export async function listSessions(app: App): Promise<SessionRef[]> {
  const root = projectsRoot();
  if (!(app.vault.adapter instanceof FileSystemAdapter) || !root) return [];

  let fs: typeof import("node:fs/promises");
  try {
    fs = nodeModule<typeof import("node:fs/promises")>("node:fs/promises");
  } catch (err) {
    console.error("[strata] no filesystem access", err);
    return [];
  }

  const out: SessionRef[] = [];
  let folders: string[];
  try {
    folders = await fs.readdir(root);
  } catch (err) {
    console.error("[strata] cannot read Claude Code projects", err);
    return [];
  }

  for (const folder of folders) {
    let files: string[];
    try {
      files = await fs.readdir(`${root}/${folder}`);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const path = `${root}/${folder}/${name}`;
      try {
        const stat = await fs.stat(path);
        const head = await readHead(path, HEAD_BYTES);
        out.push({
          id: name.replace(/\.jsonl$/, ""),
          file: path,
          project: cwdFrom(head) ?? decodeProject(folder),
          title: titleFrom(head),
          at: stat.mtimeMs,
          provider: "claude",
        });
      } catch {
        continue;
      }
    }
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}

/** Parse one chosen transcript for the vault files it wrote to. */
export async function parseSession(ref: SessionRef, known: Map<string, string>): Promise<SessionMeta> {
  const fs = nodeModule<typeof import("node:fs/promises")>("node:fs/promises");
  const raw = await fs.readFile(ref.file, "utf8");

  const wrote = new Set<string>();
  const read = new Set<string>();
  for (const match of raw.matchAll(FILE_PATH)) {
    const base = match[1].split("/").pop();
    const target = base ? known.get(base) : undefined;
    if (!target) continue;
    read.add(target);
    const before = raw.slice(Math.max(0, (match.index ?? 0) - LOOKBACK), match.index);
    if (WRITER.test(before)) wrote.add(target);
  }

  return { ...ref, wrote: [...wrote], read: read.size };
}

/**
 * Claude Desktop's own registry of the Claude Code sessions it knows about.
 *
 * Desktop keeps two ids for one conversation: its own `local_<uuid>`, and the
 * `cliSessionId` — the transcript UUID that is also the id on a Strata node.
 * The deep link only accepts the former (`session` is validated against
 * `^local_[A-Za-z0-9-]{1,64}$`, or the literal `last`), so opening a session by
 * the id we hold means going through this map first.
 *
 * A session run purely in the terminal and never opened in Desktop is not
 * in here, which is why `resumeSession` still keeps the Terminal path.
 */
function desktopRegistry(): string | null {
  const home = process.env.HOME;
  return home ? `${home}/Library/Application Support/Claude/claude-code-sessions` : null;
}

/** Desktop's `local_…` id for a CLI session, or null if it has never opened it. */
export function desktopIdFor(cliSessionId: string): string | null {
  const root = desktopRegistry();
  if (!root) return null;
  const fs = nodeModule<typeof import("node:fs")>("node:fs");
  const path = nodeModule<typeof import("node:path")>("node:path");
  try {
    // <root>/<org>/<user>/local_*.json — two levels, both opaque uuids.
    for (const org of fs.readdirSync(root)) {
      const orgDir = path.join(root, org);
      if (!fs.statSync(orgDir).isDirectory()) continue;
      for (const user of fs.readdirSync(orgDir)) {
        const userDir = path.join(orgDir, user);
        if (!fs.statSync(userDir).isDirectory()) continue;
        for (const file of fs.readdirSync(userDir)) {
          if (!file.startsWith("local_") || !file.endsWith(".json")) continue;
          try {
            const record = JSON.parse(fs.readFileSync(path.join(userDir, file), "utf8")) as {
              sessionId?: string;
              cliSessionId?: string;
            };
            if (record.cliSessionId === cliSessionId) return record.sessionId ?? file.slice(0, -5);
          } catch {
            continue; // a half-written record is not a reason to stop looking
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * What a session was about, from what it produced.
 *
 * The notes a conversation wrote already carry your own topic decisions, so
 * their union is an honest answer rather than a guess. A session legitimately
 * spans more subjects than an atom does, often many — and that is
 * not a defect to trim: a conversation *is* a session of thinking across
 * topics, and pretending otherwise would hide the connections worth having.
 *
 * A session that wrote nothing gets nothing here. Inferring topics for it from
 * its own prose is possible, and it measured well short of the standard at
 * which anything should be filed silently.
 */
export function topicsFromWrites(session: SessionMeta, topicsOf: (path: string) => string[]): string[] {
  const seen = new Set<string>();
  for (const path of session.wrote) {
    for (const topic of topicsOf(path)) {
      const name = topic.replace(/^\[\[|\]\]$/g, "").trim();
      if (name) seen.add(name);
    }
  }
  return [...seen].sort();
}

/**
 * Collapse transcripts that are the same conversation.
 *
 * Claude Code forks a new file on resume and copies the history prefix, so one
 * conversation can be several `.jsonl`s — two runs of one session, a large
 * file and a small one, are a single conversation. Two nodes for one thing is
 * not a graph, it is a double-count.
 *
 * `custom-title` is the signal, and it is written into the transcript itself so
 * this needs nothing from Claude Desktop. A deliberate branch is titled
 * `… (fork)` by Claude Code, and because the suffix makes the title differ it
 * survives as its own node without a special case. Matching on the opening
 * message would have been wrong: a fork's transcript starts at the branch
 * point, so its first message is not the original's.
 *
 * The most recent file wins, which is the continuation rather than the stub.
 */
export function dedupe(sessions: SessionMeta[]): { keep: SessionMeta[]; drop: SessionMeta[] } {
  const groups = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    const key = session.title.trim().toLowerCase();
    const list = groups.get(key);
    if (list) list.push(session);
    else groups.set(key, [session]);
  }
  const keep: SessionMeta[] = [];
  const drop: SessionMeta[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.at - a.at);
    keep.push(list[0]);
    drop.push(...list.slice(1));
  }
  return { keep, drop };
}

/**
 * The conversation inside a transcript, as markdown.
 *
 * A `.jsonl` is 95-99% not-thinking: the messages are a couple of percent of
 * the file and almost all of the rest is tool traffic — greps, file reads,
 * JSON dumps. That is exactly what the Claude
 * UI already hides, and exactly what must not be embedded: a semantic
 * layer built over tool output would rhyme file paths with file paths.
 *
 * So this keeps the readable conversation and nothing else, and renders it as
 * markdown with one heading per turn. That is not cosmetic. The heading *is*
 * the anchor, so the existing segmenter, the passage windows, the heading
 * resolution and `openLinkText` all work on a session with no changes at all —
 * a transcript becomes just another document with sections.
 *
 * Turn numbers are stable because the file is append-only: turn 12 is turn 12
 * tomorrow, whatever gets added after it.
 */
export function readable(raw: string): { turns: number; text: string } {
  const out: string[] = [];
  let turn = 0;

  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    // Subagent chatter is a different conversation happening underneath this
    // one. Real work, but not what was said or what was told.
    if (entry.isSidechain) continue;

    const content = entry.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Only prose. `tool_use` and `tool_result` blocks are dropped whole,
      // which is where almost all of the file's bulk lives.
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          text += `${(block as { text?: string }).text ?? ""}\n`;
        }
      }
    }
    text = text.trim();
    if (!text) continue;
    // Harness furniture wearing a user turn: system reminders, the local-command
    // caveat, and pasted tool output all arrive as `type: "user"`.
    if (entry.type === "user" && (text.startsWith("<") || text.startsWith("Caveat:"))) continue;

    turn++;
    out.push(`## ${turn} \u00b7 ${entry.type === "user" ? "You" : "Claude"}\n\n${text}`);
  }

  return { turns: turn, text: out.join("\n\n") };
}

/**
 * Reopen a session where it is actually readable.
 *
 * Claude Desktop first: a conversation is something to read and continue, and a
 * terminal is a poor place to do either. The Terminal path stays as the
 * fallback, because it is the only thing that works for a session Desktop has
 * never seen — and it is still the honest answer for those rather than opening
 * Desktop on the wrong conversation.
 */
/**
 * What may appear in a session id before it is put on a command line.
 *
 * The CLI id comes from a transcript filename and the Desktop id from a JSON
 * record on disk, and neither was checked. Both are opaque identifiers in
 * practice, so anything outside this set means something is wrong rather than
 * something is unusual — and the safe response to that is to not run it.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Single-quote for /bin/sh: the only metacharacter left inside is the quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literal: backslash and double quote, nothing else. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Reopen a session where it is actually readable.
 *
 * Claude Desktop first: a conversation is something to read and continue, and a
 * terminal is a poor place to do either. The Terminal path stays as the
 * fallback, because it is the only thing that works for a session Desktop has
 * never seen — and it is still the honest answer for those rather than opening
 * Desktop on the wrong conversation.
 *
 * **`execFile`, not `exec`.** `exec` hands the string to `/bin/sh`, and the
 * previous version built that string with `JSON.stringify` — which escapes
 * quotes and backslashes and leaves `$` and backticks completely alone. Inside
 * double quotes `sh` still expands both, so a directory named with a `$(...)`
 * in it, arriving here through the transcript's own `cwd` field, would have
 * been executed. Few directories are likely to be named that way; it was
 * still a command line assembled out of unvalidated file contents.
 *
 * `execFile` takes an argument vector and starts no shell, so the outer layer
 * cannot be escaped at all. The one place a shell is genuinely wanted — the
 * command Terminal is asked to run — gets a properly single-quoted path.
 */
export function resumeSession(session: SessionMeta): "desktop" | "terminal" | null {
  const { execFile } = nodeModule<typeof import("node:child_process")>("node:child_process");
  const desktop = session.provider === "claude" ? desktopIdFor(session.id) : null;
  if (desktop && SAFE_ID.test(desktop)) {
    execFile("open", [`claude://code/continue?session=${desktop}`]);
    return "desktop";
  }
  if (!SAFE_ID.test(session.id)) return null;
  const command = `cd ${shellQuote(session.project)} && claude --resume ${session.id}`;
  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`;
  execFile("osascript", ["-e", script]);
  return "terminal";
}
