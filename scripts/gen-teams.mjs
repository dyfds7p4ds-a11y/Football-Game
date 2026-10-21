// Generates src/data/teams.json with deterministic placeholder rosters.
// Run: node scripts/gen-teams.mjs   (output is committed; edit JSON freely afterwards)
import { writeFileSync } from 'node:fs';

let s = 20260101;
const rnd = () => {
  let t = (s = (s + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const r = (a, b) => Math.round(a + (b - a) * rnd());
const pick = (a) => a[Math.floor(rnd() * a.length)];

const first = ['Lukas', 'Jonas', 'Finn', 'Leon', 'Elias', 'Paul', 'Noah', 'Felix', 'Moritz', 'Tim', 'Jannik', 'Niklas',
  'Ben', 'Max', 'Erik', 'Malte', 'Ole', 'Hannes', 'Tobias', 'Marvin', 'Kevin', 'Dennis', 'Jamal', 'Darius', 'Tyrell',
  'Marcus', 'Andre', 'Kofi', 'Luca', 'Mika', 'Emil', 'Anton', 'Joel', 'Samuel', 'David', 'Aaron', 'Can', 'Deniz'];
const last = ['Becker', 'Hoffmann', 'Schulz', 'Wagner', 'Koch', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Schwarz',
  'Zimmermann', 'Braun', 'Krüger', 'Hartmann', 'Lange', 'Werner', 'Krause', 'Lehmann', 'Köhler', 'Maier', 'Brandt',
  'Vogel', 'Jung', 'Roth', 'Haas', 'Sommer', 'Graf', 'Okafor', 'Mensah', 'Johnson', 'Williams', 'Yilmaz', 'Kaya',
  'Petrović', 'Nowak', 'Jensen', 'Fischer', 'Weber'];

// Position templates: [position, slot, numberRange, rating biases]
const base = { speed: 60, strength: 60, awareness: 60, catching: 40, throwPower: 30, throwAccuracy: 30,
  blocking: 40, passRush: 40, tackling: 40, coverage: 35 };
const bias = {
  QB: { speed: 66, throwPower: 84, throwAccuracy: 80, awareness: 76 },
  RB: { speed: 88, strength: 70, catching: 66, blocking: 52 },
  WR: { speed: 90, catching: 80, awareness: 66 },
  TE: { speed: 76, strength: 76, catching: 72, blocking: 68 },
  OL: { speed: 52, strength: 84, blocking: 78, awareness: 66 },
  DL: { speed: 66, strength: 82, passRush: 76, tackling: 72 },
  LB: { speed: 78, strength: 74, tackling: 78, coverage: 62, passRush: 60, awareness: 70 },
  CB: { speed: 90, catching: 62, tackling: 62, coverage: 80, awareness: 68 },
  S: { speed: 86, catching: 60, tackling: 74, coverage: 76, awareness: 72 },
};
const offense = [
  ['QB', 'QB', [1, 19]], ['RB', 'RB', [20, 39]], ['WR', 'WR1', [80, 89]], ['WR', 'WR2', [10, 19]], ['WR', 'WR3', [80, 89]],
  ['TE', 'TE', [40, 49]], ['OL', 'LT', [70, 79]], ['OL', 'LG', [60, 69]], ['OL', 'C', [50, 59]], ['OL', 'RG', [60, 69]],
  ['OL', 'RT', [70, 79]],
];
const defense = [
  ['DL', 'DE1', [90, 99]], ['DL', 'DT1', [90, 99]], ['DL', 'DT2', [90, 99]], ['DL', 'DE2', [90, 99]],
  ['LB', 'LB1', [50, 59]], ['LB', 'LB2', [40, 49]], ['CB', 'CB1', [20, 29]], ['CB', 'CB2', [20, 29]],
  ['CB', 'NB', [30, 39]], ['S', 'FS', [20, 39]], ['S', 'SS', [20, 39]],
];
// Bench players so Phase 3 (trading / depth chart) has something to work with.
const bench = [['QB', [1, 19]], ['RB', [20, 39]], ['WR', [80, 89]], ['OL', [60, 79]], ['DL', [90, 99]], ['LB', [40, 59]], ['CB', [20, 39]]];

const teams = [
  { id: 'rheinstadt', city: 'Rheinstadt', name: 'Ritter', abbr: 'RHR', quality: 4,
    colors: { primary: '#c8102e', secondary: '#f2c14e', helmet: '#c8102e', pants: '#f4efe1' } },
  { id: 'elbtal', city: 'Elbtal', name: 'Sturmvögel', abbr: 'ELS', quality: 0,
    colors: { primary: '#1d3557', secondary: '#4ecdc4', helmet: '#1d3557', pants: '#e9edf2' } },
  { id: 'spreewald', city: 'Spreewald', name: 'Wölfe', abbr: 'SPW', quality: 2,
    colors: { primary: '#2d6a4f', secondary: '#c0c7cf', helmet: '#c0c7cf', pants: '#2d6a4f' } },
  { id: 'schwarzwald', city: 'Schwarzwald', name: 'Hirsche', abbr: 'SWH', quality: -2,
    colors: { primary: '#5c3d2e', secondary: '#f28c28', helmet: '#f28c28', pants: '#2b2b2b' } },
];

const out = teams.map((t) => {
  const used = new Set();
  const num = ([a, b]) => { let n; do { n = r(a, b); } while (used.has(n)); used.add(n); return n; };
  const roster = [];
  const depth = { offense: {}, defense: {} };
  const mk = (pos, range, starter) => {
    const ratings = {};
    for (const k of Object.keys(base)) {
      const b = (bias[pos][k] ?? base[k]) + t.quality + (starter ? 0 : -6);
      ratings[k] = Math.max(25, Math.min(99, b + r(-7, 7)));
    }
    const p = { id: `${t.id}-${roster.length + 1}`, name: `${pick(first)} ${pick(last)}`, number: num(range),
      position: pos, age: r(19, 33), ratings };
    roster.push(p);
    return p;
  };
  for (const [pos, slot, range] of offense) depth.offense[slot] = mk(pos, range, true).id;
  for (const [pos, slot, range] of defense) depth.defense[slot] = mk(pos, range, true).id;
  for (const [pos, range] of bench) mk(pos, range, false);
  const { quality, ...rest } = t;
  return { ...rest, roster, depthChart: depth };
});

writeFileSync(new URL('../src/data/teams.json', import.meta.url), JSON.stringify({ teams: out }, null, 2) + '\n');
console.log(`wrote ${out.length} teams`);
