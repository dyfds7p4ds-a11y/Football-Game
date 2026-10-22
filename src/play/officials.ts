/**
 * On-field officials. They line up around the line of scrimmage (referee and
 * umpire in the offensive backfield behind the line, wing officials on the
 * sidelines at the line, back judge deep), move with the play while staying
 * clear of the players, and throw the penalty flags. Pure data + update; the
 * renderer draws them, PlaySim owns them.
 */
import { add, clamp, dist, len, norm, scale, sub, v2, type Vec2 } from '../core/vec';
import { FIELD } from './field';

export type OfficialRole = 'R' | 'U' | 'H' | 'L' | 'B';

export interface Official {
  role: OfficialRole;
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2;
  facing: number;
}

const SPEED = 7;
const ACCEL = 10;
const KEEP_CLEAR = 2.5;

/** Pre-snap spots (offense frame). */
export function homeSpot(role: OfficialRole, los: number, ballX: number): Vec2 {
  switch (role) {
    case 'R': return v2(ballX + 4, los - 12);
    case 'U': return v2(ballX - 3, los - 9);
    case 'H': return v2(-FIELD.halfWidth - 1.2, los);
    case 'L': return v2(FIELD.halfWidth + 1.2, los);
    case 'B': return v2(ballX * 0.5, los + 22);
  }
}

export function setupOfficials(los: number, ballX: number): Official[] {
  return (['R', 'U', 'H', 'L', 'B'] as OfficialRole[]).map((role) => {
    const p = homeSpot(role, los, ballX);
    return { role, pos: { ...p }, prevPos: { ...p }, vel: v2(), facing: role === 'B' ? Math.PI : 0 };
  });
}

export interface OfficialsContext {
  los: number;
  ballX: number;
  /** Ball position (held or in the air). */
  ball: Vec2;
  /** Ball carrier, if someone has the ball after the snap exchange. */
  carrier: Vec2 | null;
  players: readonly Vec2[];
  /** The play is dead: walk toward the ball spot. */
  dead: boolean;
}

/** Where each official wants to be right now. */
function goalFor(o: Official, c: OfficialsContext): Vec2 {
  const focus = c.carrier ?? c.ball;
  switch (o.role) {
    case 'R':
    case 'U': {
      // Trail the play from behind, a little to the side.
      const back = o.role === 'R' ? 11 : 8;
      const side = o.role === 'R' ? 4 : -3;
      return v2(focus.x * 0.6 + c.ballX * 0.4 + side, Math.min(focus.y - back, c.los - (o.role === 'R' ? 9 : 6)));
    }
    case 'H':
    case 'L': {
      const x = o.role === 'H' ? -FIELD.halfWidth - 1.2 : FIELD.halfWidth + 1.2;
      return v2(x, Math.max(c.los - 2, focus.y));
    }
    case 'B':
      return v2(focus.x * 0.5, Math.max(c.los + 18, focus.y + 12));
  }
}

export function updateOfficials(offs: Official[], c: OfficialsContext, dt: number) {
  for (const o of offs) {
    o.prevPos = { ...o.pos };
    let goal = goalFor(o, c);
    if (c.dead) goal = add(c.ball, scale(norm(sub(o.pos, c.ball)), 6));
    let want = sub(goal, o.pos);
    const l = len(want);
    want = l < 0.3 ? v2() : scale(want, Math.min(SPEED, l * 2) / l);
    // Stay out of the way of the players.
    for (const p of c.players) {
      const d = dist(p, o.pos);
      if (d < KEEP_CLEAR && d > 1e-3) want = add(want, scale(norm(sub(o.pos, p)), (KEEP_CLEAR - d) * 4));
    }
    const dv = sub(want, o.vel);
    const dl = len(dv);
    o.vel = dl > ACCEL * dt ? add(o.vel, scale(dv, (ACCEL * dt) / dl)) : want;
    o.pos = add(o.pos, scale(o.vel, dt));
    o.pos.x = clamp(o.pos.x, -FIELD.halfWidth - 4, FIELD.halfWidth + 4);
    // Officials watch the ball.
    o.facing = Math.atan2(c.ball.x - o.pos.x, c.ball.y - o.pos.y);
  }
}

/** The official best placed to see a foul at `spot`. */
export function nearestOfficial(offs: readonly Official[], spot: Vec2): number {
  let best = 0;
  offs.forEach((o, i) => {
    if (dist(o.pos, spot) < dist(offs[best].pos, spot)) best = i;
  });
  return best;
}
