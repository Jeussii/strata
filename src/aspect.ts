import { generate } from "./ollama";

/**
 * What two passages have to do with each other.
 *
 * Echo and Resonance answer "are these related", which is a similarity
 * question, and similarity is symmetric and mute. It cannot tell agreement from
 * contradiction — and contradiction is the interesting half, because two notes
 * that disagree are a thing to resolve rather than a thing to admire.
 *
 * **This was meant to be a two-vote check and is deliberately not one.** The
 * plan came from an earlier run in which qwen3:4b called better than a third
 * of the resonance pairs a contradiction, which looked like over-eagerness
 * worth guarding against. Both guards were built and both made it worse:
 *
 *   - Framed as a sceptical challenge ("someone claims these contradict, check
 *     it; differing in emphasis is not a contradiction"), it answered `false`
 *     on a pair that plainly conflicts and relabelled it elaboration. Telling a
 *     4B model to be sceptical does not make it discerning, it makes it
 *     agreeable — it takes the invitation to say no.
 *   - Framed neutrally ("could a person act on both at once"), it answered
 *     `false` five times out of five on the same pair, rationalising that "both
 *     can coexist with flexibility".
 *
 * The relation question itself, meanwhile, answered `tension` five times out of
 * five on that pair, and got all five relation types right on hand-written
 * controls — a contradiction, an agreement, an elaboration, an application and
 * an unrelated pair. The first instrument was the good one, and the second vote
 * was only ever going to overrule it.
 *
 * So: one call, and the verdict is presented as a reading rather than a fact.
 * `because` carries the model's own reason precisely so the claim can be
 * checked against the passages shown beside it, which is the only guard that
 * actually held.
 *
 * Confidence is not requested. An earlier run answered "high" on all but a
 * couple of pairs, and a number that never varies carries no information while
 * inviting trust.
 *
 * **The model was the thing worth changing, not the prompt.** Re-measured on
 * five hand-written controls at five repetitions each, this same prompt scores
 * 10/25 on qwen3:4b and 20/25 on qwen3:8b — and the 4b's failures were not
 * spread evenly, it called `tension` and `unrelated` wrong every single time.
 * Those two are the whole point of the layer: similarity already finds the
 * pairs, and the only reason to ask a model is to learn which of them disagree.
 * See `writer` in main.ts for the full table, including why the 30B
 * mixture-of-experts scored like the 4b.
 */

export type Relation = "same-claim" | "elaborates" | "applies" | "tension" | "unrelated";

export interface Aspect {
  relation: Relation;
  /** Under 20 words, naming the actual point of contact. */
  because: string;
}

const RELATIONS: Relation[] = ["same-claim", "elaborates", "applies", "tension", "unrelated"];

/** Stable across the two orderings, so a pair is judged once however it is read. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const JUDGE = (a: string, b: string) => `You compare two passages from one person's personal notes and name the RELATION between them. Not their topic. Not their similarity. The relation.

same-claim   — both assert the same thing. Merging them would lose nothing.
elaborates   — B develops, specifies, or gives the mechanism for A. Same direction, more depth.
applies      — one is a principle, the other is that principle used on a concrete situation.
tension      — they pull against each other. Different answers to the same question, or a claim and its own counterexample.
unrelated    — shared vocabulary, different subject. The match is an artefact.

Judge only what the passages say.

PASSAGE A:
${a}

PASSAGE B:
${b}

Reply with JSON only: {"relation": "...", "because": "under 20 words, naming the specific point of contact"}`;

function parse(reply: string): { relation?: string; because?: string } {
  try {
    return JSON.parse(reply) as { relation?: string; because?: string };
  } catch {
    return {};
  }
}

/**
 * Judge one pair. Returns null when the model is unreachable, which on a laptop
 * is the normal state rather than an error, or when it answers with something
 * outside the five relations — a label that is not one of them is not a sixth
 * kind of relation, it is a failed call.
 */
export async function judge(
  host: string,
  model: string,
  a: string,
  b: string
): Promise<Aspect | null> {
  let reply;
  try {
    reply = parse(await generate(host, model, JUDGE(a, b), 160));
  } catch {
    return null;
  }
  const claimed = String(reply.relation ?? "") as Relation;
  if (!RELATIONS.includes(claimed)) return null;
  return { relation: claimed, because: String(reply.because ?? "").slice(0, 160) };
}

/** How each relation reads on a card. */
export const RELATION_LABEL: Record<Relation, string> = {
  "same-claim": "says the same thing",
  elaborates: "goes deeper",
  applies: "applies it",
  tension: "pulls against it",
  unrelated: "not actually related",
};
