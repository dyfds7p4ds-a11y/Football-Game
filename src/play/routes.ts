/**
 * Route tree expansion: turns a named route + depth into absolute waypoints
 * for a receiver lined up at `start`. "Outside" is away from the ball.
 */
import type { RouteAssignment, RouteType } from '../data/types';
import { clamp, type Vec2 } from '../core/vec';
import { FIELD } from './field';

export interface Route {
  type: RouteType;
  points: Vec2[];
  /** After the last waypoint: keep running in the last direction, or settle. */
  continues: boolean;
  delay: number;
  /** Receiver stays in to block (block / check) or fakes a handoff. */
  blocks: boolean;
}

const DEFAULT_DEPTH: Partial<Record<RouteType, number>> = {
  slant: 2, out: 6, in: 12, post: 12, corner: 12, curl: 12, hitch: 6, comeback: 15, drag: 2,
};

const CONTINUES: Partial<Record<RouteType, boolean>> = {
  go: true, slant: true, in: true, post: true, corner: true, wheel: true, drag: true, seam: true,
  angle: true,
};

export function buildRoute(a: RouteAssignment, start: Vec2, ballX: number): Route {
  const o = a.dir ?? (Math.sign(start.x - ballX) || 1); // outside direction
  const i = -o;
  const d = a.depth ?? DEFAULT_DEPTH[a.route] ?? 10;
  const { x, y } = start;
  const losY = Math.round(start.y + 0.5); // receivers start just behind the LOS
  const P = (px: number, py: number): Vec2 => ({
    x: clamp(px, -FIELD.halfWidth + 1, FIELD.halfWidth - 1),
    y: py,
  });
  let pts: Vec2[];
  switch (a.route) {
    case 'go': pts = [P(x + o * 0.6, losY + 6), P(x + o * 1.2, losY + 60)]; break;
    case 'seam': pts = [P(x + i * 0.5, losY + 6), P(x + i * 1.5, losY + 60)]; break;
    case 'slant': pts = [P(x, losY + d), P(x + i * 14, losY + d + 11)]; break;
    case 'out': pts = [P(x, losY + d), P(x + o * 20, losY + d - 0.5)]; break;
    case 'in': pts = [P(x, losY + d), P(x + i * 30, losY + d)]; break;
    case 'post': pts = [P(x, losY + d), P(x + i * 13, losY + d + 30)]; break;
    case 'corner': pts = [P(x, losY + d), P(x + o * 14, losY + d + 16)]; break;
    case 'curl': pts = [P(x, losY + d), P(x + i * 1.5, losY + d - 2)]; break;
    case 'hitch': pts = [P(x, losY + d), P(x, losY + d - 1)]; break;
    case 'comeback': pts = [P(x, losY + d), P(x + o * 3, losY + d - 3)]; break;
    case 'flat': pts = [P(x + o * 2.5, losY + 1.5), P(x + o * 11, losY + 3)]; break;
    case 'wheel': pts = [P(x + o * 5, losY + 1), P(x + o * 8, losY + 6), P(x + o * 8.5, losY + 60)]; break;
    case 'drag': pts = [P(x, losY + d), P(x + i * 36, losY + d + 1)]; break;
    case 'bubble': pts = [P(x + o * 2.5, y - 1.5), P(x + o * 5, y - 0.5)]; break;
    case 'swing': pts = [P(x + o * 3, y + 0.5), P(x + o * 8, losY + 1.5), P(x + o * 11, losY + 3)]; break;
    case 'screen': pts = [P(x + o * 2.5, y + 0.5), P(x + o * 5, losY - 1)]; break;
    case 'angle': pts = [P(x + o * 3, losY + 1), P(x + i * 5, losY + 7)]; break;
    case 'block':
    case 'check':
    case 'fake':
      pts = [];
      break;
  }
  return {
    type: a.route,
    points: pts,
    continues: CONTINUES[a.route] ?? false,
    delay: a.delay ?? 0,
    blocks: a.route === 'block' || a.route === 'check' || a.route === 'fake',
  };
}
