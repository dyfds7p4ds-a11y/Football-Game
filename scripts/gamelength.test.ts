// Game length probe (Phase 3c): BALANCE=gamelength npx vitest run --silent=false
import { it } from 'vitest';
import { simulateGameLength } from '../tests/gameHarness';
it('game length', () => {
  for (const q of [3, 5, 8, 12, 15]) {
    const games = Array.from({ length: 20 }, (_, i) => simulateGameLength(q, i + 1));
    const avg = (k: 'plays' | 'secondsPerPlay' | 'clockStops' | 'realMinutes' | 'kicks') => games.reduce((t, g) => t + g[k], 0) / games.length;
    console.log(`${q} min quarters`.padEnd(16), `plays/game ${avg('plays').toFixed(1)}`.padEnd(18), `clock s/play ${avg('secondsPerPlay').toFixed(1)}`.padEnd(18),
      `clock stops/game ${avg('clockStops').toFixed(1)}`.padEnd(22), `kicks ${avg('kicks').toFixed(1)}`.padEnd(12), `est. real ${avg('realMinutes').toFixed(1)} min`);
  }
}, 60000);
