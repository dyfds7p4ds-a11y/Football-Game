/**
 * Simulated CPU offensive drives (Phase 1 placeholder: the user does not play
 * defense yet). Each play is resolved from team grades + difficulty with the
 * seeded RNG, and runs through the same rules/clock code as user plays, so
 * Phase 2 can swap this for an interactive defensive PlaySim per snap.
 */
import type { Rng } from '../core/rng';
import { clamp } from '../core/vec';
import { getTeam, teamGrades } from '../data';
import type { DifficultyConfig } from '../data/types';
import { snapClock, tickClock } from './clock';
import { afterPlay, checkQuarter, type Break } from './flow';
import { applyPlay, attemptFieldGoal, fieldGoalDistance, punt, type RulesResult } from './rules';
import { ballOnText, downText, other, type GameState } from './state';
import { crowdEdge, updateCrowd } from './crowd';
import { penaltyState } from './penalties';
import { PENALTIES, makeFoul } from '../play/penalties';
import { chooseConversion, quickConversion } from './conversion';
import { callTimeout, cpuWantsTimeout } from './timeouts';

export interface DriveEntry {
  clock: string;
  situation: string;
  text: string;
}

export interface DriveSummary {
  state: GameState;
  entries: DriveEntry[];
  headline: string;
  brk: Break;
  /** The drive stopped at a punt: the app plays it (kick + user return). */
  pendingPunt: boolean;
}

export interface DriveOptions {
  /** Stop at punts so the user can return them (Phase 2); false = instant formula. */
  interactivePunts?: boolean;
  /** Home-field crowd edge (setting). */
  crowdEffect?: boolean;
  /** Penalty chance scale (0 = off). */
  penalties?: number;
}

export function simulateCpuDrive(start: GameState, diff: DifficultyConfig, rng: Rng, opts: DriveOptions = {}): DriveSummary {
  let s = start;
  const cpu = s.possession;
  const cpuHome = cpu === 'home';
  const off = teamGrades(getTeam(s.teams[cpu]));
  const def = teamGrades(getTeam(s.teams[other(cpu)]));
  // Crowd: the home defense rushes a little harder and the visitors jump offside more.
  const edge = crowdEdge(s.crowd, !!opts.crowdEffect && !cpuHome);
  const passEdge = clamp((off.passing / def.passDefense) * diff.cpuOffense / Math.sqrt(edge.homePressure), 0.6, 1.5);
  const runEdge = clamp((off.rushing / def.runDefense) * diff.cpuOffense, 0.6, 1.5);
  const entries: DriveEntry[] = [];
  let headline = '';
  let brk: Break = 'none';
  let pendingPunt = false;

  const stats = { ...s.stats[cpu] };
  const run = (secs: number) => {
    s = { ...s, clock: tickClock(s.clock, secs).clock };
  };

  for (let guard = 0; guard < 40; guard++) {
    const situation = `${downText(s)} at ${ballOnText(s.ballY)}`;
    const clock = `Q${s.clock.quarter} ${Math.floor(s.clock.remaining / 60)}:${String(Math.floor(s.clock.remaining % 60)).padStart(2, '0')}`;
    // Huddle / play clock time when the clock is running.
    if (s.clock.running) run(rng.range(22, 34));
    const qc = checkQuarter(s);
    if (qc.brk !== 'none') {
      s = qc.state;
      if (qc.brk !== 'quarter') {
        brk = qc.brk;
        headline = qc.brk === 'halftime' ? 'END OF HALF' : 'END OF GAME';
        break;
      }
    }
    s = { ...s, clock: snapClock(s.clock) };

    let r: RulesResult;
    let text: string;
    let gain = 0;
    let sack = false;
    let penaltyOnHome: boolean | null = null;
    const penScale = (opts.penalties ?? 0) * (cpuHome ? edge.homePenalty : edge.awayPenalty);
    if (penScale > 0 && rng.chance(PENALTIES.types.falseStart.chance * 2 * penScale)) {
      // Pre-snap false start (crowd noise makes it more likely for the visitors).
      r = { state: penaltyState(s, makeFoul('falseStart', { x: 0, y: s.ballY }, 0)), stop: 'penalty', possessionChanged: false, scored: null, headline: 'FALSE START' };
      text = 'False start, 5-yard penalty';
      penaltyOnHome = cpuHome;
    } else if (s.down === 4 && !(s.toGo <= 1 && s.ballY > 40 && s.ballY < 65) && !(s.overtime && fieldGoalDistance(s.ballY) > 52)) {
      run(rng.range(5, 7));
      if (fieldGoalDistance(s.ballY) <= 52) {
        const fg = attemptFieldGoal(s, rng);
        r = fg;
        text = fg.headline;
      } else if (opts.interactivePunts) {
        entries.push({ clock, situation, text: 'Punt formation' });
        pendingPunt = true;
        headline = 'PUNT';
        break;
      } else {
        r = punt(s, rng);
        text = r.headline;
      }
    } else {
      const passP = clamp(0.5 + (s.toGo > 7 ? 0.25 : 0) - (s.toGo <= 2 ? 0.25 : 0), 0.15, 0.9);
      let outcome: 'tackle' | 'incomplete' | 'interception' | 'touchdown' | 'sack' | 'outOfBounds';
      if (rng.chance(passP)) {
        const roll = rng.next();
        const sackP = 0.06 / passEdge * edge.homePressure;
        if (roll >= sackP) stats.passAtt++;
        if (roll < sackP) {
          stats.sacks++;
          sack = true;
          outcome = 'sack';
          gain = -rng.int(3, 9);
          text = `Sacked, loss of ${-gain}`;
        } else if (roll < sackP + 0.03 / passEdge) {
          outcome = 'interception';
          stats.turnovers++;
          gain = rng.int(5, 25);
          text = 'Pass intercepted!';
        } else if (rng.chance(clamp(0.6 * passEdge, 0.35, 0.85))) {
          gain = Math.round(clamp(6 + rng.normal() * 6 * passEdge + (rng.chance(0.08 * passEdge) ? 25 : 0), 0, 80));
          outcome = rng.chance(0.25) ? 'outOfBounds' : 'tackle';
          stats.passComp++;
          stats.passYds += Math.min(gain, 100 - s.ballY);
          text = `Pass complete for ${gain}`;
        } else {
          outcome = 'incomplete';
          text = 'Pass incomplete';
        }
        run(outcome === 'incomplete' ? rng.range(3, 6) : rng.range(5, 9));
      } else {
        gain = Math.round(clamp(3.8 * runEdge + rng.normal() * 3.5 + (rng.chance(0.05 * runEdge) ? 20 : 0), -4, 80));
        outcome = rng.chance(0.1) ? 'outOfBounds' : 'tackle';
        stats.rushAtt++;
        stats.rushYds += Math.min(gain, 100 - s.ballY);
        text = `Run for ${gain}`;
        run(rng.range(4, 7));
      }
      const endY = s.ballY + gain;
      if (outcome !== 'interception' && outcome !== 'incomplete' && endY >= 100) {
        outcome = 'touchdown';
        text = `${text.split(' for')[0]}: TOUCHDOWN`;
      }
      r = applyPlay(s, { outcome, endY: Math.min(endY, 100), endX: 0 });
      if (r.headline && outcome !== 'touchdown' && outcome !== 'incomplete') text += ` — ${r.headline.toLowerCase()}`;
      if (r.state.pendingConversion === cpu) {
        // Phase 3b: the try right after the touchdown (CPU chart), resolved without playing it.
        const kind = chooseConversion(r.state, cpu);
        const t = quickConversion(r.state, kind, rng, passEdge);
        text += ` · ${t.headline.toLowerCase()}`;
        r = { ...t, scored: { side: cpu, points: 6 + (t.scored?.points ?? 0) } };
      }
    }
    entries.push({ clock, situation, text });
    const home = (side: string) => side === 'home';
    const crowd = updateCrowd(s.crowd, {
      homeOffense: cpuHome, yards: gain, firstDown: r.headline === 'FIRST DOWN',
      score: r.scored ? { home: home(r.scored.side), points: r.scored.points } : null,
      turnover: r.possessionChanged && !r.scored && r.headline === 'INTERCEPTED', sack, penaltyOnHome,
      failedFourthDown: r.headline === 'TURNOVER ON DOWNS',
      defensiveStop: r.headline.includes('MISSED'),
    });
    const ap = afterPlay({ ...r.state, crowd }, r.stop);
    s = ap.state;
    // Late in a half the CPU offense stops the clock with a timeout.
    if (!r.possessionChanged && cpuWantsTimeout(s, cpu)) {
      s = callTimeout(s, cpu)!;
      entries.push({ clock, situation, text: `Timeout ${s.teams[cpu].toUpperCase()} (${s.timeouts[cpu]} left)` });
    }
    if (r.possessionChanged || r.scored) {
      headline = r.headline;
      if (ap.brk === 'halftime' || ap.brk === 'gameover') brk = ap.brk;
      break;
    }
    if (ap.brk === 'halftime' || ap.brk === 'gameover') {
      brk = ap.brk;
      headline = ap.brk === 'halftime' ? 'END OF HALF' : 'END OF GAME';
      break;
    }
  }
  return { state: { ...s, stats: { ...s.stats, [cpu]: stats } }, entries, headline, brk, pendingPunt };
}
