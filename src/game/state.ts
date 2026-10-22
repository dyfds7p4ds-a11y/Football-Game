import { createClock, type ClockState } from './clock';
import type { Difficulty } from '../data/types';
import { emptyTendencies, type Tendencies } from '../play/defenseCalls';
import { crowdStart } from './crowd';

export type TeamSide = 'home' | 'away';
export const other = (s: TeamSide): TeamSide => (s === 'home' ? 'away' : 'home');

export interface TeamStats {
  passAtt: number;
  passComp: number;
  passYds: number;
  rushAtt: number;
  rushYds: number;
  turnovers: number;
  sacks: number;
}

export const emptyStats = (): TeamStats => ({ passAtt: 0, passComp: 0, passYds: 0, rushAtt: 0, rushYds: 0, turnovers: 0, sacks: 0 });

/**
 * Whole-game state. Plain data so it can be serialized (save games in
 * Phase 3) and unit-tested. `ballY` is always measured in the frame of the
 * team in possession (0 = own goal line, 100 = opponent goal line).
 */
export interface GameState {
  teams: Record<TeamSide, string>;
  /** The side the human plays. Phase 1: user always controls this team's offense. */
  userSide: TeamSide;
  difficulty: Difficulty;
  score: Record<TeamSide, number>;
  possession: TeamSide;
  ballY: number;
  ballX: number;
  down: number;
  toGo: number;
  clock: ClockState;
  timeouts: Record<TeamSide, number>;
  openingReceiver: TeamSide;
  stats: Record<TeamSide, TeamStats>;
  tendencies: Tendencies;
  over: boolean;
  seed: number;
  /** The side that must kick off before the next snap (Phase 2 special teams); null = none. */
  pendingKickoff: TeamSide | null;
  /** Crowd pulse 0..100 (home crowd's energy). */
  crowd: number;
}

export interface NewGameOptions {
  home: string;
  away: string;
  userSide: TeamSide;
  difficulty: Difficulty;
  quarterLength: number;
  seed: number;
}

export function newGame(o: NewGameOptions): GameState {
  return {
    teams: { home: o.home, away: o.away },
    userSide: o.userSide,
    difficulty: o.difficulty,
    score: { home: 0, away: 0 },
    possession: o.userSide,
    ballY: 25,
    ballX: 0,
    down: 1,
    toGo: 10,
    clock: createClock(o.quarterLength),
    timeouts: { home: 3, away: 3 },
    openingReceiver: o.userSide,
    stats: { home: emptyStats(), away: emptyStats() },
    tendencies: emptyTendencies(),
    over: false,
    seed: o.seed,
    // Opening kickoff: the CPU kicks to the user's team.
    pendingKickoff: other(o.userSide),
    crowd: crowdStart(),
  };
}

export function isGoalToGo(s: GameState): boolean {
  return s.ballY + s.toGo >= 100;
}

/** "3rd & 7", "1st & Goal" */
export function downText(s: GameState): string {
  const ord = ['1st', '2nd', '3rd', '4th'][Math.min(3, s.down - 1)];
  return `${ord} & ${isGoalToGo(s) ? 'Goal' : Math.max(1, Math.round(s.toGo))}`;
}

/** "OWN 25", "OPP 35", "50" */
export function ballOnText(y: number): string {
  const r = Math.round(y);
  if (r === 50) return '50';
  return r < 50 ? `OWN ${r}` : `OPP ${100 - r}`;
}
