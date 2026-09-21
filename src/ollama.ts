import { requestUrl } from "obsidian";

/**
 * The local model, and nothing else.
 *
 * Every call here goes to a process on this machine. No key, no account, no
 * request that leaves the laptop — which is the whole point: a second brain is
 * the last thing that should be posted to someone else's server, and a system
 * that needs an API key is a system that stops working when a bill goes unpaid.
 *
 * Routed through Obsidian's `requestUrl` rather than `fetch` because the plugin
 * runs on the `app://obsidian.md` origin and Ollama's CORS allowlist does not
 * include it. `requestUrl` goes out through the main process, where CORS does
 * not apply.
 */

export const DEFAULT_HOST = "http://localhost:11434";

export interface OllamaStatus {
  up: boolean;
  models: string[];
  error?: string;
}

export async function probe(host: string): Promise<OllamaStatus> {
  try {
    const res = await requestUrl({ url: `${host}/api/tags`, method: "GET", throw: false });
    if (res.status !== 200) return { up: false, models: [], error: `HTTP ${res.status}` };
    const models = (res.json?.models ?? []) as { name: string }[];
    return { up: true, models: models.map((m) => m.name) };
  } catch (err) {
    return { up: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Embed a batch.
 *
 * `/api/embed` takes a list and returns one vector per input, so the cost of a
 * batch is one round trip rather than one per note. Vectors come back
 * unnormalised; normalising here means cosine similarity is a plain dot product
 * everywhere downstream.
 */
export async function embed(host: string, model: string, inputs: string[]): Promise<Float32Array[]> {
  const res = await requestUrl({
    url: `${host}/api/embed`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: inputs }),
    throw: false,
  });
  if (res.status !== 200) {
    throw new Error(`Ollama returned ${res.status}: ${String(res.text).slice(0, 200)}`);
  }
  const raw = res.json?.embeddings as number[][] | undefined;
  if (!raw || raw.length !== inputs.length) {
    throw new Error(`Ollama returned ${raw?.length ?? 0} vectors for ${inputs.length} inputs`);
  }
  return raw.map(normalise);
}

function normalise(v: number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const m = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / m;
  return out;
}

/** Both vectors are unit length, so cosine is the dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Ask the local model for one small, structured answer.
 *
 * `format: "json"` constrains the decoder rather than hoping the prompt is
 * obeyed, and `think: false` suppresses qwen3's reasoning block — which is
 * otherwise emitted before the JSON and makes the response unparseable.
 * Temperature is low because none of these are creative tasks.
 */
export async function generate(
  host: string,
  model: string,
  prompt: string,
  maxTokens = 240
): Promise<string> {
  const res = await requestUrl({
    url: `${host}/api/generate`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0.1, num_predict: maxTokens },
    }),
    throw: false,
  });
  if (res.status !== 200) {
    throw new Error(`Ollama returned ${res.status}: ${String(res.text).slice(0, 200)}`);
  }
  return String(res.json?.response ?? "");
}
