import type { Doc } from "./docs";
import { segment } from "./segment";

/**
 * The words half of search.
 *
 * The semantic index answers "what is this about" and cannot answer "where did
 * I write this". A name, a course code, the title of an article — an embedding
 * of any of them lands near everything loosely on the subject, and the page
 * that literally carries the word ranks wherever its prose happens to fall.
 * This is plain BM25 over the same passages the vectors are cut from, with the
 * page title counted in every passage, so a page can always be found by what
 * it is called.
 *
 * Built from the raw text, not the template-stripped text the vectors see:
 * a recurring answer like "Leg day" is noise for similarity and exactly what a
 * keyword search is for.
 */

export interface WordHit {
  path: string;
  heading: string;
  preview: string;
  score: number;
  /**
   * How much of the query's distinctive vocabulary this passage holds: the sum
   * of the inverse document frequencies of the query words it contains, over
   * the sum for all of them. 1.0 is every word; a passage holding only "the"
   * and "day" from a long question scores near zero however often it says them.
   */
  coverage: number;
}

interface Passage {
  path: string;
  heading: string;
  preview: string;
  length: number;
}

const K1 = 1.2;
const B = 0.75;
const PREVIEW = 240;
/** How many vocabulary words the half-typed last word may stand for. */
const PREFIX_FANOUT = 20;

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
}

export class LexicalIndex {
  private passages: Passage[] = [];
  private postings = new Map<string, [number, number][]>();
  private avg = 1;

  static async build(docs: Doc[]): Promise<LexicalIndex> {
    const index = new LexicalIndex();
    let total = 0;
    for (const doc of docs) {
      let raw: string;
      try {
        raw = await doc.read();
      } catch {
        continue;
      }
      const title = tokens(doc.title);
      for (const seg of segment(raw)) {
        const words = [...title, ...tokens(seg.heading), ...tokens(seg.text)];
        if (!words.length) continue;
        const at = index.passages.length;
        index.passages.push({ path: doc.key, heading: seg.heading, preview: seg.text.slice(0, PREVIEW), length: words.length });
        total += words.length;
        const tf = new Map<string, number>();
        for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
        for (const [w, n] of tf) {
          const list = index.postings.get(w) ?? [];
          list.push([at, n]);
          index.postings.set(w, list);
        }
      }
    }
    index.avg = index.passages.length ? total / index.passages.length : 1;
    return index;
  }

  get size(): number {
    return this.passages.length;
  }

  /**
   * Best passage per page, best page first.
   *
   * The last word of the query also matches as a prefix, because the box
   * searches as you type and "hust" is a perfectly good way to be halfway
   * through asking for Hustle.
   */
  search(query: string, limit = 20): WordHit[] {
    const words = [...new Set(tokens(query))];
    if (!words.length || !this.passages.length) return [];
    const N = this.passages.length;
    const idf = (term: string) => {
      const n = this.postings.get(term)?.length ?? 0;
      return n ? Math.log(1 + (N - n + 0.5) / (n + 0.5)) : 0;
    };

    // Each typed word, and the vocabulary that counts as having it.
    const last = words[words.length - 1];
    const accepts = words.map((w) => new Map<string, number>([[w, 1]]));
    if (last.length >= 3 && !/\s$/.test(query)) {
      let n = 0;
      for (const term of this.postings.keys()) {
        if (term !== last && term.startsWith(last)) {
          // A completion counts for less than the word as typed.
          accepts[accepts.length - 1].set(term, 0.6);
          if (++n >= PREFIX_FANOUT) break;
        }
      }
    }
    // What a word is worth: its own rarity, or its rarest completion's.
    const worth = accepts.map((terms) => Math.max(...[...terms.keys()].map(idf)));
    const total = worth.reduce((a, b) => a + b, 0) || 1;

    const scores = new Map<number, number>();
    const held = new Map<number, number>();
    accepts.forEach((terms, i) => {
      const credited = new Set<number>();
      for (const [term, weight] of terms) {
        const list = this.postings.get(term);
        if (!list) continue;
        const w = idf(term);
        for (const [at, tf] of list) {
          const len = this.passages[at].length;
          const s = (weight * w * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / this.avg));
          scores.set(at, (scores.get(at) ?? 0) + s);
          if (!credited.has(at)) {
            credited.add(at);
            held.set(at, (held.get(at) ?? 0) + weight * worth[i]);
          }
        }
      }
    });

    const best = new Map<string, WordHit>();
    for (const [at, score] of scores) {
      const p = this.passages[at];
      const coverage = Math.min(1, (held.get(at) ?? 0) / total);
      const have = best.get(p.path);
      if (!have || coverage > have.coverage || (coverage === have.coverage && score > have.score)) {
        best.set(p.path, { path: p.path, heading: p.heading, preview: p.preview, score, coverage });
      }
    }
    return [...best.values()]
      .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
      .slice(0, limit);
  }
}
