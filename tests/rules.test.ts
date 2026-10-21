import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { applyPlay, attemptFieldGoal, delayOfGame, fieldGoalProbability, punt } from '../src/game/rules';
import { downText, newGame, type GameState } from '../src/game/state';

const g0 = (): GameState => newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 300, seed: 1 });
const at = (s: Partial<GameState>): GameState => ({ ...g0(), ...s });

describe('play resolution rules', () => {
  it('short gain advances the down', () => {
    const r = applyPlay(at({ ballY: 25, down: 1, toGo: 10 }), { outcome: 'tackle', endY: 29, endX: 3 });
    expect(r.state.down).toBe(2);
    expect(r.state.toGo).toBe(6);
    expect(r.state.ballY).toBe(29);
    expect(r.stop).toBe('inbounds');
  });

  it('reaching the line to gain is a first down', () => {
    const r = applyPlay(at({ ballY: 25, down: 3, toGo: 4 }), { outcome: 'outOfBounds', endY: 30, endX: 27 });
    expect(r.state.down).toBe(1);
    expect(r.state.toGo).toBe(10);
    expect(r.headline).toBe('FIRST DOWN');
    expect(r.stop).toBe('outOfBounds');
    expect(Math.abs(r.state.ballX)).toBeLessThan(7); // re-spotted on the hash
  });

  it('first down inside the 10 is goal to go', () => {
    const r = applyPlay(at({ ballY: 85, down: 2, toGo: 3 }), { outcome: 'tackle', endY: 94, endX: 0 });
    expect(r.state.toGo).toBe(6);
    expect(downText(r.state)).toBe('1st & Goal');
  });

  it('incomplete pass keeps the spot and costs a down', () => {
    const r = applyPlay(at({ ballY: 40, down: 2, toGo: 7 }), { outcome: 'incomplete', endY: 40, endX: 0 });
    expect(r.state.down).toBe(3);
    expect(r.state.ballY).toBe(40);
    expect(r.stop).toBe('incomplete');
  });

  it('failing on 4th down turns the ball over at the spot', () => {
    const r = applyPlay(at({ ballY: 60, down: 4, toGo: 3 }), { outcome: 'tackle', endY: 61, endX: 0 });
    expect(r.possessionChanged).toBe(true);
    expect(r.state.possession).toBe('away');
    expect(r.state.ballY).toBe(39);
    expect(r.state.down).toBe(1);
  });

  it('touchdown scores 7 and gives the opponent the ball at its 25', () => {
    const r = applyPlay(at({ ballY: 90 }), { outcome: 'touchdown', endY: 100, endX: 0 });
    expect(r.state.score.home).toBe(7);
    expect(r.state.possession).toBe('away');
    expect(r.state.ballY).toBe(25);
    expect(r.stop).toBe('score');
  });

  it('safety gives the defense 2 points and the ball', () => {
    const r = applyPlay(at({ ballY: 3 }), { outcome: 'safety', endY: -1, endX: 0 });
    expect(r.state.score.away).toBe(2);
    expect(r.state.possession).toBe('away');
  });

  it('interception flips the field; in the end zone it is a touchback', () => {
    const r = applyPlay(at({ ballY: 30 }), { outcome: 'interception', endY: 70, endX: 0 });
    expect(r.state.possession).toBe('away');
    expect(r.state.ballY).toBe(30);
    expect(r.stop).toBe('turnover');
    const tb = applyPlay(at({ ballY: 80 }), { outcome: 'interception', endY: 104, endX: 0 });
    expect(tb.state.ballY).toBe(25);
  });

  it('sack loses yards', () => {
    const r = applyPlay(at({ ballY: 30, down: 1, toGo: 10 }), { outcome: 'sack', endY: 23, endX: 0 });
    expect(r.state.ballY).toBe(23);
    expect(r.state.toGo).toBe(17);
    expect(r.headline).toBe('SACK');
  });

  it('delay of game is 5 yards or half the distance', () => {
    expect(delayOfGame(at({ ballY: 30, toGo: 10 })).state.ballY).toBe(25);
    expect(delayOfGame(at({ ballY: 30, toGo: 10 })).state.toGo).toBe(15);
    expect(delayOfGame(at({ ballY: 4, toGo: 10 })).state.ballY).toBe(2);
  });

  it('field goals get harder with distance and score 3', () => {
    expect(fieldGoalProbability(25)).toBeGreaterThan(fieldGoalProbability(50));
    let made = 0;
    for (let i = 0; i < 20; i++) {
      const r = attemptFieldGoal(at({ ballY: 90 }), new Rng(i));
      if (r.good) {
        made++;
        expect(r.state.score.home).toBe(3);
      }
      expect(r.state.possession).toBe('away');
    }
    expect(made).toBeGreaterThan(15);
  });

  it('punts change possession with sensible field position', () => {
    for (let i = 0; i < 20; i++) {
      const r = punt(at({ ballY: 30, down: 4 }), new Rng(i));
      expect(r.state.possession).toBe('away');
      expect(r.state.ballY).toBeGreaterThanOrEqual(20);
      expect(r.state.ballY).toBeLessThan(50);
    }
  });
});
