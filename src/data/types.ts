/** Shared data types. Everything in src/data/*.json is validated against these. */

export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'OL' | 'DL' | 'LB' | 'CB' | 'S';

export type EligibleSlot = 'WR1' | 'WR2' | 'WR3' | 'RB' | 'TE';
export type OLSlot = 'LT' | 'LG' | 'C' | 'RG' | 'RT';
export type OffSlot = 'QB' | EligibleSlot | OLSlot;
export type DefSlot = 'DE1' | 'DT1' | 'DT2' | 'DE2' | 'LB1' | 'LB2' | 'CB1' | 'CB2' | 'NB' | 'FS' | 'SS';

export const ELIGIBLE: readonly EligibleSlot[] = ['WR1', 'WR2', 'WR3', 'RB', 'TE'];
export const OL_SLOTS: readonly OLSlot[] = ['LT', 'LG', 'C', 'RG', 'RT'];
export const OFF_SLOTS: readonly OffSlot[] = ['QB', ...ELIGIBLE, ...OL_SLOTS];
export const DEF_SLOTS: readonly DefSlot[] = ['DE1', 'DT1', 'DT2', 'DE2', 'LB1', 'LB2', 'CB1', 'CB2', 'NB', 'FS', 'SS'];

/** 0..100 ratings. Phase 3 (career/progression) mutates these. */
export interface Ratings {
  speed: number;
  strength: number;
  awareness: number;
  catching: number;
  throwPower: number;
  throwAccuracy: number;
  blocking: number;
  passRush: number;
  tackling: number;
  coverage: number;
}

export interface PlayerData {
  id: string;
  name: string;
  number: number;
  position: Position;
  age: number;
  ratings: Ratings;
}

export interface TeamColors {
  primary: string;
  secondary: string;
  helmet: string;
  pants: string;
}

export interface TeamData {
  id: string;
  city: string;
  name: string;
  abbr: string;
  colors: TeamColors;
  roster: PlayerData[];
  depthChart: {
    offense: Record<OffSlot, string>;
    defense: Record<DefSlot, string>;
  };
}

export type FormationId = 'under_center' | 'shotgun' | 'pistol' | 'trips';

/** Offsets from the ball spot: dx lateral, dy (negative = backfield). */
export type Formation = Record<OffSlot, [number, number]>;

export type RouteType =
  | 'go' | 'slant' | 'out' | 'in' | 'post' | 'corner' | 'curl' | 'hitch' | 'comeback'
  | 'flat' | 'wheel' | 'drag' | 'seam' | 'bubble' | 'screen' | 'swing' | 'angle'
  | 'block' | 'check' | 'fake';

export interface RouteAssignment {
  route: RouteType;
  /** Stem depth in yards (route-specific default if omitted). */
  depth?: number;
  /** Seconds to wait after the snap before releasing. */
  delay?: number;
  /** Force direction: +1 = toward +x (right), -1 = left. Defaults to "outside". */
  dir?: 1 | -1;
}

export type PlayCategory = 'run' | 'short' | 'medium' | 'deep' | 'screen' | 'playaction';

export interface RunDesign {
  /** Lateral aim point relative to the ball (gap), in yards. */
  aim: number;
  /** 'handoff' meshes with the QB, 'toss' pitches the ball outside. */
  style: 'handoff' | 'toss';
  /** Phase 3b: blocking scheme (play/blocking.ts). Derived from style and aim when missing. */
  scheme?: 'inside' | 'zone' | 'power' | 'toss' | 'draw';
}

/** Screen design: who catches it, which blockers release, and the timing window. */
export interface ScreenDesign {
  target: EligibleSlot;
  /** Side the screen goes to: +1 = right, -1 = left. */
  side: 1 | -1;
  /** Seconds after the snap when the screen linemen release to the outside. */
  release: number;
  /** Linemen that release and lead the screen. */
  linemen: OLSlot[];
  /** Receivers who stalk-block for it. */
  stalk?: EligibleSlot[];
  /** [open, close] seconds after the snap: the throw must be released in this window. */
  window: [number, number];
}

export interface PlayData {
  id: string;
  name: string;
  category: PlayCategory;
  formation: FormationId;
  description: string;
  routes: Record<EligibleSlot, RouteAssignment>;
  run?: RunDesign;
  playAction?: boolean;
  screen?: ScreenDesign;
  /** Hint shown on the play card. */
  primary?: EligibleSlot;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyConfig {
  label: string;
  /** Seconds a defender lags behind what the offense actually does. */
  reactionTime: number;
  /** Random positional error (yards) added to coverage targets. */
  coverageError: number;
  /** Multiplier on pass-rush push and block-shedding. */
  passRush: number;
  /** Multiplier on tackle success. */
  tackling: number;
  /** Multiplier on contested-catch / interception skill. */
  ballSkills: number;
  /** How long linebackers bite on play-action (s). */
  playActionBite: number;
  /** 0 = random defensive calls, 1 = fully reads offensive tendencies. */
  callIntelligence: number;
  /** Width multiplier of the throw-timing sweet spot. */
  throwWindow: number;
  /** CPU offense strength multiplier for simulated drives. */
  cpuOffense: number;
  /** 0..1 quality of the defense's route-concept reads (read speed, picking the right help). */
  coverageRead: number;
  /** Multiplier on edge/back-side pressure and on blockers losing their man over time. */
  pocketPressure: number;
  /** Width multiplier of the special-teams timing zones (punt, field goal, kickoff). */
  kickWindow: number;
  /** Multiplier on every foul chance (data/penalties.json); keeps flags rare. */
  penaltyRate: number;
}
