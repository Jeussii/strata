import type { LayerId } from "./model";

/**
 * The layout, as one simulation.
 *
 * What was here before was four mechanisms in a trenchcoat: fcose for the
 * connected part, a hand-placed golden-angle annulus for everything else, a
 * uniform rescale to make room, and an overlap relaxation to clean up after.
 * Every layout bug this project has had came from a seam between two of them —
 * most recently the grid, which was fcose packing zero-degree nodes into a tidy
 * rectangle because the code handed it nodes whose only edges were on a layer
 * that happened to be switched off.
 *
 * A single force simulation has no seams. It is also, not coincidentally, what
 * Obsidian's own graph does, and the reason that graph reads well: a note pulled
 * by many links ends up in the middle without anyone computing centrality,
 * because many springs balancing is what "middle" means.
 *
 * The model is d3-force's, including the two details that make it behave:
 *
 *   - repulsion falls off as 1/d², not 1/d³. Cubed looks plausible and blows the
 *     graph to a 10^6 px span within a hundred ticks.
 *   - each spring is divided by the smaller of its two endpoints' degrees, so a
 *     hub is not whipped around by any single one of its forty links.
 *
 * One thing here is not Obsidian's, and it is the part that answers "connected
 * in the middle, the rest around it": a node with no edges at all is pulled to
 * the centre less hard than one with any. Obsidian pulls everything in equally,
 * which leaves half the unconnected nodes sitting *inside* the mass, filling
 * its holes; weakening their pull moves every one of them out to a ring —
 * measured, the orphans settle in a band outside the core's 90th percentile
 * with none left inside. Hub centrality is unaffected and stays at Obsidian's
 * own -0.36, because that comes from the springs, not from this.
 *
 * The test is deliberately `degree === 0` and not a slope over degree. Grading
 * it was the first attempt and it was wrong on a real graph in a way a
 * synthetic one cannot show: a second vault is a genuine second component —
 * one project plus the entries that serve it, joined to the knowledge vault by
 * a couple of bridges — and its entries are degree 1. A slope gives exactly
 * those nodes the
 * weakest pull, so the whole component drifted 1,860px off and left the screen.
 * A degree-1 node inside a component is not loose. It is attached.
 *
 * With the binary test there is no instability to tune around: the core holds
 * at a ~350px span across the entire range of `loose`, and the ring simply
 * moves further out as it drops (332px at 1.0, 1,167px at 0.05). The slider is
 * bounded only to keep the ring on screen.
 */

export interface ForceSettings {
  /** Pull toward the middle. Obsidian's "Centre force". */
  centre: number;
  /** How hard every node pushes every other. Obsidian's "Repel force". */
  repel: number;
  /** Spring strength along an edge. Obsidian's "Link force". */
  link: number;
  /** Rest length of a spring, in pixels. Obsidian's "Link distance". */
  distance: number;
  /**
   * How much less a node with *no* edges is pulled to the centre. 1 is
   * Obsidian's behaviour — no difference at all, and orphans mix into the mass.
   */
  loose: number;
}

export const DEFAULT_FORCES: ForceSettings = {
  centre: 0.5,
  repel: 10.31,
  link: 1,
  distance: 250,
  loose: 0.6,
};

/** Not a stability limit — just the point where the ring leaves the viewport. */
export const LOOSE_FLOOR = 0.15;

/**
 * How hard each layer pulls.
 *
 * A link you wrote and a similarity the embedder proposed are not the same
 * kind of claim, so they should not tug on the shape with the same strength.
 * Resonance is the loosest by a distance: a real vault has more resonance
 * edges than authored links, and without damping the arrangement
 * starts describing what the model guessed rather than what you built.
 *
 * Measured, this is a refinement rather than a rescue — damping moves the
 * authored picture by 17% of the graph width instead of 20%. The degree-divided
 * spring was already absorbing most of it.
 */
export const LAYER_PULL: Record<LayerId, number> = {
  links: 1,
  topics: 1,
  source: 1,
  hierarchy: 1,
  serves: 1,
  bridges: 1,
  sessions: 1,
  suggested: 0.5,
  echo: 0.35,
  resonance: 0.15,
};

export interface Placed {
  id: string;
  x: number;
  y: number;
}

export interface Spring {
  source: string;
  target: string;
  layer: LayerId;
}

const ITERATIONS = 600;
/** d3's velocityDecay of 0.4, expressed as what survives each tick. */
const FRICTION = 0.6;
/** Repulsion has a reach. Without one, anything that escapes never comes back. */
const REPEL_REACH = 1200;
/** Two nodes on the same pixel have no direction to separate along. */
const MIN_DIST_SQ = 4;
/**
 * Temperature for a burst. Warm enough that a slider visibly moves the graph,
 * cool enough that it eases rather than throws — a full-alpha burst on an
 * already-settled layout looks like an explosion, not an adjustment.
 */
const BURST_ALPHA = 0.12;

/**
 * Run to equilibrium and stop.
 *
 * Obsidian leaves its simulation warm and re-heats it on every drag, which is
 * the constant drifting nobody asked for. This converges once and freezes;
 * nothing moves again until Re-layout is pressed.
 *
 * Positions are mutated in place. `fresh` starts from a phyllotaxis spiral —
 * even, unstructured, and deterministic, so Re-layout twice on an unchanged
 * graph gives the same answer. Otherwise the current arrangement is the starting
 * point and this relaxes it rather than rolling a new one.
 */
export function simulate(nodes: Placed[], springs: Spring[], forces: ForceSettings, fresh: boolean, ticks?: number): void {
  const n = nodes.length;
  if (n < 2) return;
  // `ticks` runs a short burst at a constant, gentle alpha instead of a full
  // annealing schedule. That is what a slider drag wants: the arrangement on
  // screen eases toward the new balance of forces while the handle is moving,
  // rather than the graph being recomputed from scratch on every value and
  // jumping. Same forces, same code — only the temperature differs.
  const burst = ticks !== undefined;

  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) at.set(nodes[i].id, i);

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);

  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    if (fresh) {
      const r = 10 * Math.sqrt(0.5 + i);
      const a = i * GOLDEN;
      x[i] = r * Math.cos(a);
      y[i] = r * Math.sin(a);
    } else {
      x[i] = nodes[i].x;
      y[i] = nodes[i].y;
    }
  }

  // Only springs whose endpoints are both in the simulation.
  const es: number[] = [];
  const et: number[] = [];
  const ek: number[] = [];
  const degree = new Int32Array(n);
  for (const spring of springs) {
    const s = at.get(spring.source);
    const t = at.get(spring.target);
    if (s === undefined || t === undefined || s === t) continue;
    es.push(s);
    et.push(t);
    ek.push(LAYER_PULL[spring.layer] ?? 1);
    degree[s]++;
    degree[t]++;
  }
  // d3's forceLink bias: divide by the smaller endpoint, so hubs stay put.
  for (let e = 0; e < es.length; e++) {
    ek[e] = (ek[e] * forces.link) / Math.max(1, Math.min(degree[es[e]], degree[et[e]]));
  }

  // How much of the centre force each node feels. Degree is counted over the
  // edges actually being simulated, not the whole graph: soloing a layer should
  // push what is not in that layer out of the way, which is the entire reason
  // for soloing it.
  const pull = new Float64Array(n);
  const loose = Math.max(LOOSE_FLOOR, Math.min(1, forces.loose));
  for (let i = 0; i < n; i++) {
    pull[i] = forces.centre * (degree[i] === 0 ? loose : 1);
  }

  const charge = -forces.repel * 30;
  const reachSq = REPEL_REACH * REPEL_REACH;
  const rest = forces.distance;

  const steps = burst ? (ticks as number) : ITERATIONS;
  for (let step = 0; step < steps; step++) {
    const alpha = burst ? BURST_ALPHA : Math.max(0.001, Math.pow(0.001, step / ITERATIONS));

    // Repulsion, every pair. At a couple of hundred nodes an exact pass is
    // cheaper than building a quadtree. Past a thousand nodes it
    // would not be, and Barnes-Hut is the answer then.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - x[i];
        let dy = y[j] - y[i];
        let d2 = dx * dx + dy * dy;
        if (d2 > reachSq) continue;
        if (d2 < MIN_DIST_SQ) {
          // Deterministic nudge; d3 jiggles randomly, which makes Re-layout
          // irreproducible for no benefit.
          const a = i * GOLDEN;
          dx = Math.cos(a);
          dy = Math.sin(a);
          d2 = MIN_DIST_SQ;
        }
        const w = (charge * alpha) / d2;
        vx[i] += dx * w;
        vy[i] += dy * w;
        vx[j] -= dx * w;
        vy[j] -= dy * w;
      }
    }

    for (let e = 0; e < es.length; e++) {
      const s = es[e];
      const t = et[e];
      const dx = x[t] - x[s];
      const dy = y[t] - y[s];
      const d = Math.hypot(dx, dy) || 1;
      const f = ((d - rest) / d) * ek[e] * alpha;
      vx[s] += dx * f;
      vy[s] += dy * f;
      vx[t] -= dx * f;
      vy[t] -= dy * f;
    }

    for (let i = 0; i < n; i++) {
      const g = pull[i] * alpha;
      vx[i] -= x[i] * g;
      vy[i] -= y[i] * g;
    }

    for (let i = 0; i < n; i++) {
      vx[i] *= FRICTION;
      vy[i] *= FRICTION;
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }

  for (let i = 0; i < n; i++) {
    nodes[i].x = x[i];
    nodes[i].y = y[i];
  }
}

/**
 * Where the nodes that are not on the visible layer go.
 *
 * The `loose` mechanism above was built for the handful of nodes that have no
 * edges at all, and for that it works: weaken their pull and they settle into
 * a ring outside the mass. Soloing a layer then quietly reused it for a
 * completely different population. With only one sparse structural layer
 * switched on, most nodes have no visible edge, so "the ring" became five
 * sixths of the picture and the layer actually asked for was left occupying
 * **under a fifth of the canvas by area**. Measured, not guessed.
 *
 * Those two populations are not the same thing and should not share a
 * mechanism. A node with no edges anywhere is a fact about the vault and
 * belongs in the picture. A node whose edges are simply on a layer that is
 * switched off is not part of what is being looked at, and letting it into the
 * simulation means it repels the thing that is.
 *
 * So it is parked instead: placed on a golden-angle ring outside the core, in
 * one pass, touching nothing. Still there, still clickable, still countable —
 * just no longer voting on where the visible graph goes.
 */
export function park(parked: Placed[], core: Placed[]): void {
  if (!parked.length) return;

  let radius = 0;
  for (const p of core) radius = Math.max(radius, Math.hypot(p.x, p.y));
  // A clear gap, so the ring reads as "outside" rather than as a fuzzy edge of
  // the core. Floors for the case where the visible layer is a single edge.
  const inner = Math.max(radius * 1.35, radius + 160, 240);

  // Golden angle, and a radius that grows with the square root of the index, so
  // a ring of 20 and a ring of 400 both come out evenly spread instead of one
  // being a sparse circle and the other a solid band.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.max(60, inner * 0.55);
  for (let i = 0; i < parked.length; i++) {
    const r = inner + spread * Math.sqrt(i / parked.length);
    const a = i * GOLDEN;
    parked[i].x = Math.cos(a) * r;
    parked[i].y = Math.sin(a) * r;
  }
}
