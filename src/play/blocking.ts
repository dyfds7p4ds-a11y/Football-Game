/**
 * Offensive-line blocking (pure). Phase 3b replaces the fixed "quick loss"
 * roll with matchup-driven blocks:
 *
 * - `assignProtection()` gives every pass blocker a responsibility: pass set
 *   on a rusher, double team, or chip and release (a back on a `check` route).
 * - `planRunBlocks()` gives every run blocker a target and a drive direction
 *   from the play's run design (zone, gap, power, toss, draw); gap schemes
 *   double the point-of-attack lineman and climb to a linebacker.
 * - `blockQuality()` turns ratings into a -1..1 matchup grade, and
 *   `holdTime()` turns that grade into how long the block holds. Strong
 *   matchups hold for a long time, weak ones lose early; noise only varies
 *   reps around that value.
 * - `pickLane()` scores the gaps of a run design by how open the blocks
 *   made them, so the carrier hits the lane the line actually created.
 *
 * Tunables: `data/blocking.json`.
 */
import type { Rng } from '../core/rng';
import type { Ratings, RunDesign } from '../data/types';
import blockingJson from '../data/blocking.json';

export const BLOCKING = blockingJson;

export type BlockRole = 'passSet' | 'runBlock' | 'double' | 'chip';
export type BlockMode = 'pass' | 'run' | 'chip';
export type RunScheme = NonNullable<RunDesign['scheme']>;

export interface BlockAssignment {
  blocker: number;
  role: BlockRole;
  /** Defender id (null: no one to block yet, pick up whoever comes). */
  target: number | null;
  /** Gap schemes: time the second man of a double team climbs to `climbTo`. */
  climbAt?: number;
  climbTo?: number | null;
  /** Lateral drive direction for run blocks (-1 / +1, 0 = straight ahead). */
  drive?: number;
}

/** What the assignment code needs to know about a player. */
export interface Unit {
  id: number;
  x: number;
  y: number;
  /** OL, or an eligible who stays in (`kind`: 'block' = pure, 'check' = chip and release). */
  kind: 'ol' | 'block' | 'check' | 'def';
  /** Defenders: rushing the passer (pass) or in the box (run). */
  rushing?: boolean;
  /** Defenders: linebacker (climb target). */
  lb?: boolean;
}

const weighted = (r: Ratings, w: Record<string, number>) => {
  let s = 0;
  let n = 0;
  for (const [k, v] of Object.entries(w)) {
    s += (r[k as keyof Ratings] ?? 50) * v;
    n += v;
  }
  return s / n;
};

/**
 * Matchup grade from the blocker's view: +1 the blocker dominates, -1 the
 * defender does. Pass, run and chip blocks weight different ratings.
 */
export function blockQuality(blk: Ratings, def: Ratings, mode: BlockMode): number {
  const q = BLOCKING.quality;
  const b = weighted(blk, mode === 'run' ? q.runBlockWeights : q.passBlockWeights);
  const d = weighted(def, mode === 'run' ? q.runDefWeights : q.passRushWeights);
  return Math.max(-1, Math.min(1, (b - d) / q.scale));
}

export interface HoldOptions {
  mode: BlockMode;
  /** Difficulty `passRush` multiplier (stronger rush = shorter holds). */
  passRush: number;
  /** Rep-to-rep variance draw; omit for the expected hold time. */
  rng?: Rng;
}

/** Seconds a single block holds before the defender gets off it (doubles: see `progressRate`). */
export function holdTime(quality: number, o: HoldOptions): number {
  const h = BLOCKING.hold;
  const base = o.mode === 'pass' ? h.passBase : o.mode === 'run' ? h.runBase : h.chipBase;
  const noise = o.rng ? Math.exp(o.rng.normal() * h.noiseSigma) : 1;
  const k = o.mode === 'run' ? h.runQualityExp : h.qualityExp;
  const t = (base * Math.exp(k * quality) * noise) / Math.max(0.2, o.passRush);
  return Math.max(h.min, Math.min(h.max, t));
}

/**
 * How fast an engagement uses up its hold time: a double team slows it
 * down, a QB who holds the ball past the grace period speeds it up.
 */
export function progressRate(engagers: number, holdPressure = 1): number {
  return (engagers >= 2 ? 1 / BLOCKING.hold.doubleFactor : 1) * holdPressure;
}

const near = (a: Unit, b: Unit) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Pass protection. Rushers are taken inside-out by the nearest free lineman
 * within `olReach` (pass set). A blitzer the protection recognized is picked
 * up by a back on his side, else by sliding the line toward him (the spare
 * lineman starts the slide), else by a back crossing the formation. A
 * blitzer the protection did not see comes free. Free linemen double the
 * nearest rusher close to the QB. A back on a `check` route with no one to
 * pick up chips the nearest edge rusher on his side, then releases.
 */
export function assignProtection(
  blockers: Unit[], rushers: Unit[], qb: { x: number; y: number }, ballX: number,
  /** Rushers the protection has identified (blitzers it did not see stay free). Default: all. */
  recognized: (r: Unit) => boolean = () => true,
): BlockAssignment[] {
  const p = BLOCKING.protection;
  const out: BlockAssignment[] = [];
  const free = new Set(blockers.map((b) => b.id));
  const byId = new Map(blockers.map((b) => [b.id, b]));
  const order = [...rushers].sort((a, b) => Math.abs(a.x - ballX) - Math.abs(b.x - ballX));
  const taken = new Set<number>();
  const assign = (b: Unit, r: Unit) => {
    out.push({ blocker: b.id, role: 'passSet', target: r.id });
    free.delete(b.id);
    taken.add(r.id);
  };
  const pick = (r: Unit, kinds: Unit['kind'][], reach?: number) => {
    let best: Unit | null = null;
    for (const id of free) {
      const b = byId.get(id)!;
      if (!kinds.includes(b.kind)) continue;
      // A lineman can only slide so far; wide blitzers belong to the backs.
      if (Math.abs(b.x - r.x) > (reach ?? (b.kind === 'ol' ? p.olReach : p.backReach))) continue;
      if (!best || near(b, r) < near(best, r)) best = b;
    }
    return best;
  };
  // 1. Linemen take the rushers in front of them, inside-out.
  for (const r of order) {
    const b = pick(r, ['ol']);
    if (b) assign(b, r);
  }
  // 2. Rushers nobody in front can reach: a back on that side, then a slide of the line, then any back.
  for (const r of order) {
    if (taken.has(r.id) || !recognized(r)) continue;
    const side = Math.sign(r.x - ballX) || 1;
    const sameSide = pick(r, ['block', 'check'], p.backReach * 0.5);
    if (sameSide && Math.sign(sameSide.x - ballX) !== -side) {
      assign(sameSide, r);
      continue;
    }
    const spare = [...free].map((id) => byId.get(id)!).find((b) => b.kind === 'ol');
    if (spare && slide(out, byId, rushers, r, spare, side)) {
      free.delete(spare.id);
      taken.add(r.id);
      continue;
    }
    const back = pick(r, ['block', 'check']);
    if (back) assign(back, r);
  }
  for (const id of free) {
    const b = byId.get(id)!;
    if (b.kind === 'check') {
      const side = Math.sign(b.x - ballX) || 1;
      const edge = rushers
        .filter((r) => Math.sign(r.x - ballX) === side && Math.abs(r.x - ballX) > p.chipEdgeWidth && near(r, b) < p.chipRange)
        .sort((a, c) => near(a, b) - near(c, b))[0];
      out.push({ blocker: id, role: edge ? 'chip' : 'passSet', target: edge?.id ?? null });
      continue;
    }
    const r = rushers
      .filter((x) => near(x, b) < p.doubleRange && Math.hypot(x.x - qb.x, x.y - qb.y) < p.doubleMaxToQb)
      .sort((a, c) => near(a, b) - near(c, b))[0];
    out.push({ blocker: id, role: r ? 'double' : 'passSet', target: r?.id ?? null });
  }
  return out;
}

/**
 * Slide protection toward `blitzer`: the linemen from the spare man out to
 * the edge each take the next rusher toward the blitz side, the outside man
 * takes the blitzer. Returns false when the spare man is on the wrong side.
 */
function slide(out: BlockAssignment[], byId: Map<number, Unit>, rushers: Unit[], blitzer: Unit, spare: Unit, side: number): boolean {
  const rById = new Map(rushers.map((r) => [r.id, r]));
  const chain = out
    .filter((a) => byId.get(a.blocker)?.kind === 'ol' && a.target !== null)
    .filter((a) => (byId.get(a.blocker)!.x - spare.x) * side > 0)
    .sort((a, b) => (byId.get(a.blocker)!.x - byId.get(b.blocker)!.x) * side);
  if (!chain.length) {
    out.push({ blocker: spare.id, role: 'passSet', target: blitzer.id });
    return true;
  }
  // Spare takes the first man's rusher, each lineman takes the next one's, the last takes the blitzer.
  const targets = chain.map((a) => a.target!);
  out.push({ blocker: spare.id, role: 'passSet', target: targets[0] });
  chain.forEach((a, i) => (a.target = i + 1 < targets.length ? targets[i + 1] : blitzer.id));
  return rById.has(blitzer.id);
}

/** Scheme of a run design (older data without `scheme` is derived from style and aim). */
export function runScheme(run: RunDesign): RunScheme {
  if (run.scheme) return run.scheme;
  if (run.style === 'toss') return 'toss';
  return Math.abs(run.aim) > 4 ? 'zone' : 'inside';
}

/**
 * Run blocking plan. Every lineman takes the nearest box defender in front
 * of him. Playside of the aim point he drives the man outward, backside he
 * cuts him off inward, so a lane opens at the aim. Gap and power schemes
 * double the defensive lineman nearest the aim; the outside man of the
 * double climbs to the nearest linebacker at `climbAt`. Zone schemes have
 * everyone step playside (drive = run direction).
 */
export function planRunBlocks(run: RunDesign, ballX: number, blockers: Unit[], defenders: Unit[]): BlockAssignment[] {
  const cfg = BLOCKING.run;
  const scheme = runScheme(run);
  const aimX = ballX + run.aim;
  const dir = Math.sign(run.aim) || 1;
  const box = defenders.filter((d) => d.rushing || d.lb);
  const front = box.filter((d) => !d.lb);
  const lbs = box.filter((d) => d.lb);
  const used = new Map<number, number>();
  const out: BlockAssignment[] = [];
  const ol = blockers.filter((b) => b.kind === 'ol').sort((a, b) => a.x - b.x);

  // Point of attack: double the front man nearest the aim with the two linemen nearest him.
  let poa: Unit | null = null;
  const doubles = new Set<number>();
  if (scheme === 'inside' || scheme === 'power') {
    poa = [...front].sort((a, b) => Math.abs(a.x - aimX) - Math.abs(b.x - aimX))[0] ?? null;
    if (poa) {
      const two = [...ol].sort((a, b) => near(a, poa!) - near(b, poa!)).slice(0, 2);
      // The man further from the aim stays on the down block; the other climbs.
      two.sort((a, b) => Math.abs(b.x - aimX) - Math.abs(a.x - aimX));
      const lb = [...lbs].sort((a, b) => Math.abs(a.x - aimX) - Math.abs(b.x - aimX))[0] ?? null;
      two.forEach((b, i) => {
        doubles.add(b.id);
        out.push({
          blocker: b.id, role: 'double', target: poa!.id, drive: -Math.sign(aimX - poa!.x) || -dir,
          climbAt: i === 1 && lb ? cfg.climbAt : undefined, climbTo: i === 1 ? lb?.id ?? null : undefined,
        });
      });
      used.set(poa.id, 2);
      if (lb) used.set(lb.id, 1);
    }
  }
  const others = blockers.filter((b) => !doubles.has(b.id));
  for (const b of others) {
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (const d of box) {
      if ((used.get(d.id) ?? 0) >= 1) continue;
      const ahead = d.y >= b.y - 1;
      if (!ahead) continue;
      const lateral = Math.abs(d.x - b.x);
      // Zone: take the man in your playside gap first.
      const lean = scheme === 'zone' || scheme === 'toss' ? (Math.sign(d.x - b.x) === dir ? -0.6 : 0.6) : 0;
      const score = lateral + Math.abs(d.y - b.y) * 0.4 + (d.lb ? 1.2 : 0) + lean;
      if (score < bestScore) {
        best = d;
        bestScore = score;
      }
    }
    if (best) used.set(best.id, 1);
    const drive = scheme === 'zone' || scheme === 'toss' ? dir : best ? (Math.sign(best.x - aimX) || -dir) : 0;
    out.push({ blocker: b.id, role: 'runBlock', target: best?.id ?? null, drive });
  }
  return out;
}

/** A defender as the carrier sees him: where he is and how his block is going. */
export interface LaneDefender {
  x: number;
  y: number;
  /** 'free' (unblocked), 'held' (blocker winning), 'even' (engaged, block under pressure). */
  state: 'free' | 'held' | 'even';
}

/** Candidate gaps for a run design, design gap first. */
export function laneCandidates(run: RunDesign, ballX: number): number[] {
  const cfg = BLOCKING.run;
  const scheme = runScheme(run);
  const aimX = ballX + run.aim;
  const n = scheme === 'zone' ? cfg.zoneGaps : scheme === 'toss' ? 0 : cfg.gapGaps;
  const out = [aimX];
  for (let i = 1; i <= n; i++) out.push(aimX - Math.sign(run.aim || 1) * cfg.gapWidth * i, aimX + Math.sign(run.aim || 1) * cfg.gapWidth * i);
  return out;
}

/** How open a gap at `gapX` is: distance to the nearest threat, held blockers count less. */
export function laneOpenness(gapX: number, los: number, defenders: LaneDefender[]): number {
  const cfg = BLOCKING.run;
  const gy = los + cfg.laneEvalDepth;
  let open = cfg.openCap;
  for (const d of defenders) {
    const w = d.state === 'free' ? 1 : d.state === 'even' ? cfg.winningWeight : cfg.blockedWeight;
    const dd = Math.hypot(d.x - gapX, (d.y - gy) * 0.7) / w;
    open = Math.min(open, dd);
  }
  return open;
}

/** Best gap for the carrier: openness plus a bias toward the designed gap. */
export function pickLane(candidates: number[], los: number, defenders: LaneDefender[]): { x: number; open: number } {
  const bias = BLOCKING.run.designBias;
  let best = { x: candidates[0], open: -Infinity, score: -Infinity };
  candidates.forEach((x, i) => {
    const open = laneOpenness(x, los, defenders);
    const score = open + (i === 0 ? bias : 0);
    if (score > best.score) best = { x, open, score };
  });
  return { x: best.x, open: best.open };
}
