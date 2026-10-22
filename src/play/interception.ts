/**
 * Interception timing window for a user-controlled defender (pure). The JUMP
 * button starts a lunge that peaks `jump.peakAt` seconds later; how close that
 * peak is to the ball's arrival decides the grade. The grade only shifts the
 * odds inside resolveCatch (breakup, interception, reach); it never decides
 * the outcome by itself. Tunables in data/defenseControl.json.
 */
import defenseJson from '../data/defenseControl.json';

export type JumpGrade = 'perfect' | 'good' | 'mistimed' | 'none';

export interface TimingEffect {
  breakup: number;
  int: number;
  reach: number;
}

export const DEF_CONTROL = defenseJson as {
  moveSpeed: number;
  jump: { duration: number; peakAt: number; height: number; lunge: number; cooldown: number };
  window: { perfect: number; good: number; mistimed: number };
  effects: Record<JumpGrade, TimingEffect>;
  tackle: { diveFactor: number; diveRange: number };
  presnapAutoSnap: number;
};

/**
 * Grade a jump against the ball's arrival. `jumpT` is when the button was
 * pressed (null: no jump), `arriveT` when the ball reaches the catch point.
 */
export function jumpTiming(jumpT: number | null, arriveT: number): { grade: JumpGrade; offset: number } {
  if (jumpT === null) return { grade: 'none', offset: Infinity };
  const offset = jumpT + DEF_CONTROL.jump.peakAt - arriveT;
  const a = Math.abs(offset);
  const w = DEF_CONTROL.window;
  if (a <= w.perfect) return { grade: 'perfect', offset };
  if (a <= w.good) return { grade: 'good', offset };
  if (a <= w.mistimed) return { grade: 'mistimed', offset };
  return { grade: 'none', offset };
}

export function timingEffect(grade: JumpGrade): TimingEffect {
  return DEF_CONTROL.effects[grade];
}

/** Height (yd) of a jumping defender `dt` seconds after the press (renderer). */
export function jumpHeight(dt: number): number {
  const j = DEF_CONTROL.jump;
  if (dt < 0 || dt > j.duration) return 0;
  return j.height * Math.sin((dt / j.duration) * Math.PI);
}
