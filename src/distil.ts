import { Segment } from "./segment";
import { generate } from "./ollama";

/**
 * Asking the local model what a passage is.
 *
 * The model fills in a form. It does not decide anything: every field it
 * returns is a suggestion sitting in an editable control, and the split does
 * not happen until you press the button. That division is deliberate —
 * naming an idea and filing it are exactly the judgments a 4B model is weakest
 * at and you are strongest at, so it does the typing and you do the thinking.
 *
 * Two guards, both because the model was measured getting these wrong:
 *
 *   Topics are filtered against the vault. Asked to choose from the topics
 *   that already exist, it invented two of its own on two passages out of
 *   eight. An invented topic is exactly what the schema forbids, so anything
 *   not already in `Topics/` is dropped rather than created.
 *
 *   It is never asked whether a passage is worth keeping. That judgment was
 *   tested and it was bad at it — it marked a named mental model as filler
 *   while its own explanation described a real idea. Everything is kept by
 *   default and you drop what is connective tissue.
 */

export interface Proposal {
  title: string;
  topics: string[];
  horizon: string;
}

const DEFAULT_MODEL = "qwen3:8b";

function prompt(passage: Segment, noteTitle: string, topics: string[]): string {
  const body = passage.text.slice(0, 1600);
  return [
    "Below is one passage from a personal knowledge vault. It will become a single atomic note.",
    "",
    "Choose topics ONLY from this list, copied exactly:",
    ...topics.map((t) => `- ${t}`),
    "",
    `The passage comes from a note called "${noteTitle}".`,
    passage.heading ? `Its heading is "${passage.heading}".` : "",
    "",
    "Passage:",
    body,
    "",
    'Reply with ONLY a JSON object: {"title": "...", "topics": ["..."], "horizon": "timeless" or "situational"}',
    "",
    "title: 3-7 words naming the idea itself, not the heading. No colon, no quotes.",
    "topics: 1 to 3, copied character-for-character from the list above.",
    'horizon: "timeless" if it would still hold in ten years; "situational" if it describes a particular moment, plan or period.',
  ]
    .filter(Boolean)
    .join("\n");
}

export async function propose(
  host: string,
  model: string,
  passage: Segment,
  noteTitle: string,
  topics: string[]
): Promise<Proposal> {
  const known = new Set(topics);
  const fallback: Proposal = {
    title: passage.heading || noteTitle,
    topics: [],
    horizon: "",
  };

  let raw: string;
  try {
    raw = await generate(host, model || DEFAULT_MODEL, prompt(passage, noteTitle, topics));
  } catch (err) {
    console.error("[strata] the model could not be reached", err);
    return fallback;
  }

  let parsed: { title?: unknown; topics?: unknown; horizon?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    console.error("[strata] unparseable proposal", raw.slice(0, 200));
    return fallback;
  }

  const title =
    typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim().replace(/[:"']/g, "").slice(0, 70)
      : fallback.title;

  const proposed = Array.isArray(parsed.topics) ? parsed.topics : [];
  const filtered = proposed
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => known.has(t))
    .slice(0, 3);

  const horizon =
    parsed.horizon === "timeless" || parsed.horizon === "situational" ? parsed.horizon : "";

  return { title, topics: filtered, horizon };
}
