'use strict';
// Teams, Positionen und Spieler-Attribute

const ATTRS = ['SPD', 'AGI', 'STR', 'HND', 'THR', 'ACC', 'BLK', 'TKL', 'COV', 'KCK'];

const ATTR_INFO = {
  SPD: 'Speed: Topspeed',
  AGI: 'Agilität: Antritt, Cuts',
  STR: 'Stärke: Blocks lösen',
  HND: 'Hände: Fangsicherheit',
  THR: 'Wurfkraft: Tempo, Weite',
  ACC: 'Genauigkeit: Präzision',
  BLK: 'Blocken: Blocks halten',
  TKL: 'Tackling: Tackle-Quote',
  COV: 'Coverage: Deckung, INT',
  KCK: 'Kicken: FG & Punts',
};

// Basiswerte je Position
const POS_BASE = {
  QB: { SPD: 58, AGI: 62, STR: 52, HND: 50, THR: 80, ACC: 78, BLK: 20, TKL: 20, COV: 15, KCK: 25 },
  RB: { SPD: 85, AGI: 85, STR: 72, HND: 66, THR: 30, ACC: 30, BLK: 52, TKL: 30, COV: 20, KCK: 20 },
  WR: { SPD: 87, AGI: 85, STR: 52, HND: 80, THR: 25, ACC: 25, BLK: 42, TKL: 25, COV: 25, KCK: 20 },
  TE: { SPD: 72, AGI: 66, STR: 76, HND: 74, THR: 20, ACC: 20, BLK: 70, TKL: 30, COV: 20, KCK: 15 },
  OL: { SPD: 44, AGI: 46, STR: 85, HND: 30, THR: 10, ACC: 10, BLK: 80, TKL: 30, COV: 10, KCK: 10 },
  DL: { SPD: 66, AGI: 64, STR: 82, HND: 40, THR: 10, ACC: 10, BLK: 30, TKL: 78, COV: 25, KCK: 10 },
  LB: { SPD: 76, AGI: 72, STR: 74, HND: 55, THR: 10, ACC: 10, BLK: 40, TKL: 80, COV: 64, KCK: 10 },
  CB: { SPD: 88, AGI: 86, STR: 50, HND: 62, THR: 10, ACC: 10, BLK: 30, TKL: 62, COV: 80, KCK: 10 },
  S:  { SPD: 84, AGI: 78, STR: 62, HND: 60, THR: 10, ACC: 10, BLK: 35, TKL: 76, COV: 76, KCK: 10 },
  K:  { SPD: 50, AGI: 50, STR: 40, HND: 40, THR: 30, ACC: 40, BLK: 10, TKL: 20, COV: 10, KCK: 80 },
};

// Attribute, die für die Position zählen (Gesamtwertung + Hervorhebung im Kader)
const KEY_ATTRS = {
  QB: ['THR', 'ACC', 'SPD'],
  RB: ['SPD', 'AGI', 'STR', 'HND'],
  WR: ['SPD', 'HND', 'AGI'],
  TE: ['HND', 'BLK', 'STR', 'SPD'],
  OL: ['BLK', 'STR'],
  DL: ['STR', 'TKL', 'AGI'],
  LB: ['TKL', 'COV', 'SPD', 'STR'],
  CB: ['COV', 'SPD', 'AGI'],
  S:  ['COV', 'TKL', 'SPD'],
  K:  ['KCK'],
};

const OFF_ROLES = ['QB', 'RB', 'WR1', 'WR2', 'WR3', 'TE', 'LT', 'LG', 'C', 'RG', 'RT'];
const DEF_ROLES = ['LE', 'LDT', 'RDT', 'RE', 'WLB', 'MLB', 'SLB', 'LCB', 'RCB', 'FS', 'SS'];

const ROLE_POS = {
  QB: 'QB', RB: 'RB', WR1: 'WR', WR2: 'WR', WR3: 'WR', TE: 'TE',
  LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL',
  LE: 'DL', LDT: 'DL', RDT: 'DL', RE: 'DL',
  WLB: 'LB', MLB: 'LB', SLB: 'LB',
  LCB: 'CB', RCB: 'CB', FS: 'S', SS: 'S', K: 'K',
};

const ROLE_LABEL = {
  WR1: 'WR', WR2: 'WR', WR3: 'SL', LDT: 'DT', RDT: 'DT',
};

const NUM_RANGES = {
  QB: [1, 19], RB: [20, 49], WR: [10, 19, 80, 89], TE: [80, 89], OL: [60, 79],
  DL: [90, 99], LB: [40, 59], CB: [20, 39], S: [20, 49], K: [1, 9],
};

const LAST_NAMES = [
  'Becker', 'Hall', 'Schmidt', 'Carter', 'Wagner', 'Brooks', 'Hoffmann', 'Reed',
  'Krüger', 'Mason', 'Vogel', 'Hayes', 'Neumann', 'Price', 'Fischer', 'Coleman',
  'Wolf', 'Bryant', 'Braun', 'Foster', 'Lange', 'Hughes', 'Richter', 'Ward',
  'Keller', 'Grant', 'Werner', 'Bennett', 'Zimmer', 'Porter', 'Hahn', 'Ellis',
  'Frank', 'Barnes', 'Berg', 'Woods', 'Roth', 'Long', 'Jung', 'Dixon',
  'Sommer', 'Tucker', 'Kraus', 'Perry', 'Seidel', 'Gray', 'Kuhn', 'Stone',
];
const INITIALS = 'ABCDEFGHJKLMNOPRSTW';

const TEAMS = [
  {
    id: 'hogs', name: 'THUNDER HOGS', short: 'HOGS',
    primary: '#b8322a', secondary: '#f4d35e', helmet: '#f4d35e', pants: '#f2f2f2',
    style: 'Lauf-Team: brutale O-Line und ein Power-Back.',
    runBias: 0.62, seed: 1101,
    mods: { OL: 7, RB: 8, TE: 5, QB: -6, WR: -5, DL: 1, LB: 3, CB: -3, S: 0, K: 0 },
  },
  {
    id: 'hawks', name: 'NEON HAWKS', short: 'HAWKS',
    primary: '#1a9fb3', secondary: '#ff4fa3', helmet: '#eaeaea', pants: '#1b2a4a',
    style: 'Pass-Team: Kanonen-QB und blitzschnelle Receiver.',
    runBias: 0.38, seed: 2202,
    mods: { QB: 10, WR: 8, OL: -4, RB: -2, TE: 0, DL: -3, LB: -3, CB: 2, S: -1, K: 3 },
  },
  {
    id: 'wolves', name: 'IRON WOLVES', short: 'WOLVES',
    primary: '#4a4a64', secondary: '#c9c9d9', helmet: '#2a2a3a', pants: '#c9c9d9',
    style: 'Defense-Team: harte D-Line und klebrige Secondary.',
    runBias: 0.5, seed: 3303,
    mods: { DL: 8, LB: 6, CB: 6, S: 5, QB: -4, WR: -3, OL: 0, RB: 0, TE: -2, K: -3 },
  },
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function calcOvr(pos, attrs) {
  const keys = KEY_ATTRS[pos];
  return Math.round(keys.reduce((s, k) => s + attrs[k], 0) / keys.length);
}

function buildTeam(def) {
  const rng = mulberry32(def.seed);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const usedNums = new Set();
  const usedNames = new Set();
  const roster = {};

  const pickNum = (pos) => {
    const r = NUM_RANGES[pos];
    for (let i = 0; i < 200; i++) {
      const pair = r.length > 2 && rng() < 0.5 ? 2 : 0;
      const n = ri(r[pair], r[pair + 1]);
      if (!usedNums.has(n)) { usedNums.add(n); return n; }
    }
    return ri(1, 99);
  };
  const pickName = () => {
    for (let i = 0; i < 200; i++) {
      const n = INITIALS[ri(0, INITIALS.length - 1)] + '. ' + LAST_NAMES[ri(0, LAST_NAMES.length - 1)];
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return 'J. Doe';
  };

  for (const role of OFF_ROLES.concat(DEF_ROLES, ['K'])) {
    const pos = ROLE_POS[role];
    const base = POS_BASE[pos];
    const mod = def.mods[pos] || 0;
    const attrs = {};
    for (const a of ATTRS) {
      const key = KEY_ATTRS[pos].includes(a);
      const v = base[a] + (key ? mod + ri(-6, 6) : ri(-8, 8));
      attrs[a] = Math.max(20, Math.min(99, v));
    }
    roster[role] = {
      role, pos, attrs,
      label: ROLE_LABEL[role] || role,
      num: pickNum(pos),
      name: pickName(),
      ovr: calcOvr(pos, attrs),
    };
  }

  const avg = (roles) => Math.round(roles.reduce((s, r) => s + roster[r].ovr, 0) / roles.length);
  const ratings = {
    LAUF: avg(['RB', 'LT', 'LG', 'C', 'RG', 'RT', 'TE']),
    PASS: avg(['QB', 'QB', 'WR1', 'WR2', 'WR3', 'TE']),
    DEF: avg(DEF_ROLES),
    KICK: roster.K.ovr,
  };
  return Object.assign({}, def, { roster, ratings });
}
