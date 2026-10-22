import { describe, expect, it } from 'vitest';
import { DIFFICULTY } from '../src/data';
import { readDelay } from '../src/play/coverage';
import { kickZone } from '../src/play/kicking';

describe('difficulty covers the Phase 2 systems', () => {
  const { easy, normal, hard } = DIFFICULTY;

  it('coverage reads get faster and better from Easy to Hard', () => {
    expect(easy.coverageRead).toBeLessThan(normal.coverageRead);
    expect(normal.coverageRead).toBeLessThan(hard.coverageRead);
    expect(readDelay(easy.coverageRead)).toBeGreaterThan(readDelay(hard.coverageRead));
  });

  it('pocket pressure and tackling strength grow with difficulty', () => {
    expect(easy.pocketPressure).toBeLessThan(normal.pocketPressure);
    expect(normal.pocketPressure).toBeLessThan(hard.pocketPressure);
    expect(easy.tackling).toBeLessThan(normal.tackling);
    expect(normal.tackling).toBeLessThan(hard.tackling);
  });

  it('special-teams timing windows shrink with difficulty', () => {
    expect(easy.kickWindow).toBeGreaterThan(normal.kickWindow);
    expect(normal.kickWindow).toBeGreaterThan(hard.kickWindow);
    expect(kickZone('fieldGoal', easy.kickWindow, 40).halfWidth).toBeGreaterThan(kickZone('fieldGoal', hard.kickWindow, 40).halfWidth);
  });
});
