'use strict';
// Formationen und Playbook.
// Koordinaten: [dx, dy] relativ zur Line of Scrimmage (dx > 0 = Richtung gegnerische Endzone)
// und zur Feldmitte (dy < 0 = oben). Routen: [dx, dIn] relativ zur Startposition,
// dIn > 0 = Richtung Feldmitte.

const OL_POS = { LT: [-0.8, -3.0], LG: [-0.8, -1.5], C: [-0.8, 0], RG: [-0.8, 1.5], RT: [-0.8, 3.0] };

const FORMATIONS = {
  singleback: Object.assign({ QB: [-1.4, 0], RB: [-6, 0], TE: [-0.9, 4.6], WR1: [-0.9, -20], WR2: [-0.9, 20], WR3: [-1.6, -11] }, OL_POS),
  shotgun: Object.assign({ QB: [-5, 0], RB: [-5, 2.2], TE: [-0.9, 4.6], WR1: [-0.9, -20], WR2: [-0.9, 20], WR3: [-1.6, -11] }, OL_POS),
};

const RUN_PLAYS = [
  {
    id: 'dive', name: 'HB DIVE', kind: 'run', formation: 'singleback', block: 'drive',
    desc: 'Schneller Handoff, der RB sticht direkt durch die Mitte (A-Gap). Wenig Risiko, kurze sichere Yards.',
    qbMesh: [-2.2, 0.4], rbPath: [[-2.4, 0.8], [2, 0.8], [9, 0.8]],
  },
  {
    id: 'power', name: 'POWER', kind: 'run', formation: 'singleback', block: 'drive',
    pull: { LG: [[-1.8, 1.5], [-0.6, 3.8], [2.5, 4.2]] },
    desc: 'Der linke Guard zieht nach rechts und führt den RB durchs Off-Tackle-Loch. Kraft-Lauf zur TE-Seite.',
    qbMesh: [-3, 1.0], rbPath: [[-3.2, 1.6], [0, 3.8], [2.5, 4.2], [10, 4.4]],
  },
  {
    id: 'toss', name: 'TOSS SWEEP', kind: 'run', formation: 'singleback', block: 'reach', toss: true,
    desc: 'Pitch zum RB, der außen ums Ende läuft. Mit Speed sind riesige Gewinne drin, gegen schnelle Defense drohen Verluste.',
    rbPath: [[-5.5, 7], [-3, 13], [3, 16], [12, 16]],
  },
  {
    id: 'counter', name: 'COUNTER', kind: 'run', formation: 'singleback', block: 'drive',
    pull: { LG: [[-1.8, 0.5], [-0.8, 2.6], [2.2, 3]] },
    desc: 'Fake-Schritt nach links, dann Cut nach rechts hinter dem ziehenden Guard. Lässt aggressive Linebacker ins Leere laufen.',
    qbMesh: [-2.8, -0.3], rbPath: [[-5.2, -1.6], [-3.0, 0], [0, 2.6], [3, 3], [10, 3]],
  },
];

const PASS_PLAYS = [
  {
    id: 'slant', name: 'SLANT / FLAT', kind: 'pass', formation: 'shotgun',
    desc: 'Schnelle Slants außen, Flat aus dem Slot, TE-Stick. Ideal gegen Blitz und weiche Coverage. Schnell werfen!',
    routes: {
      WR1: { pts: [[3, 0], [9, 6]], end: 'go' },
      WR2: { pts: [[3, 0], [9, 6]], end: 'go' },
      WR3: { pts: [[2, -2], [3, -9]], end: 'go' },
      TE: { pts: [[5, 0], [5, 1]], end: 'sit' },
    },
  },
  {
    id: 'smash', name: 'SMASH', kind: 'pass', formation: 'shotgun',
    desc: 'Hitch außen, Corner-Route dahinter, RB ins Flat. Bringt den Cornerback in Cover 2 in die Zwickmühle.',
    routes: {
      WR1: { pts: [[6, 0], [5, 0.5]], end: 'sit' },
      WR2: { pts: [[6, 0], [5, 0.5]], end: 'sit' },
      WR3: { pts: [[11, 0], [17, -7]], end: 'go' },
      TE: { pts: [[11, 0], [17, -7]], end: 'go' },
      RB: { pts: [[1, -4], [3, -12]], end: 'go' },
    },
  },
  {
    id: 'verts', name: 'FOUR VERTS', kind: 'pass', formation: 'shotgun',
    desc: 'Vier Receiver laufen tief, RB als Check-Down. Big-Play-Konzept gegen Mann-Deckung, braucht Zeit in der Pocket.',
    routes: {
      WR1: { pts: [[30, 0]], end: 'go' },
      WR2: { pts: [[30, 0]], end: 'go' },
      WR3: { pts: [[4, 1.5], [30, 2]], end: 'go' },
      TE: { pts: [[4, -2], [30, -3]], end: 'go' },
      RB: { pts: [[0, -3], [2, -6]], end: 'sit' },
    },
  },
  {
    id: 'mesh', name: 'MESH', kind: 'pass', formation: 'shotgun',
    desc: 'Zwei flache Crossing-Routes kreuzen sich in der Mitte, dahinter Dig und Post. Killer gegen Manndeckung.',
    routes: {
      WR3: { pts: [[2, 0], [2.5, 24]], end: 'go' },
      TE: { pts: [[3, 0], [3.5, 22]], end: 'go' },
      WR1: { pts: [[12, 0], [12, 10]], end: 'go' },
      WR2: { pts: [[10, 0], [20, 7]], end: 'go' },
    },
  },
];

const SPECIAL_PLAYS = [
  { id: 'punt', name: 'PUNT', kind: 'punt', desc: 'Ball weit wegkicken und den Gegner tief in seine Hälfte drängen.' },
  { id: 'fg', name: 'FIELD GOAL', kind: 'fg', desc: 'Kick durch die Stangen für 3 Punkte. Trefferchance hängt von Distanz und KCK ab.' },
];

// Grundaufstellung der 4-3 Defense: [Tiefe, dy]
const DEF_ALIGN = {
  LE: [1.0, -4.2], LDT: [1.0, -0.9], RDT: [1.0, 0.9], RE: [1.0, 5.6],
  WLB: [5, -6], MLB: [5, 0], SLB: [5, 5.5],
  LCB: [6, -20], RCB: [6, 20], FS: [13, -6], SS: [12, 8],
};

const RUSH4 = { LE: { t: 'rush' }, LDT: { t: 'rush' }, RDT: { t: 'rush' }, RE: { t: 'rush' } };

const DEF_PLAYS = [
  {
    id: 'cov2', name: 'COVER 2', tag: 'ZONE',
    desc: 'Zwei Safeties teilen sich die Tiefe, CBs sichern die Flats, LBs die Mitte. Stark gegen lange Pässe, Lücken zwischen den Zonen.',
    align: { FS: [13, -12], SS: [13, 12], LCB: [5, -19], RCB: [5, 19] },
    assign: Object.assign({}, RUSH4, {
      LCB: { t: 'zone', x: 5, y: -17, r: 7 }, RCB: { t: 'zone', x: 5, y: 17, r: 7 },
      WLB: { t: 'zone', x: 9, y: -8, r: 6.5 }, MLB: { t: 'zone', x: 10, y: 0, r: 6 }, SLB: { t: 'zone', x: 9, y: 8, r: 6.5 },
      FS: { t: 'zone', x: 19, y: -12, r: 13 }, SS: { t: 'zone', x: 19, y: 12, r: 13 },
    }),
  },
  {
    id: 'cov3', name: 'COVER 3', tag: 'ZONE',
    desc: 'Drei tiefe Drittel (2 CBs + FS), vier Zonen darunter. Solide Allround-Defense mit Schwächen in Flats und Seams.',
    align: { LCB: [7, -19], RCB: [7, 19], FS: [14, 0], SS: [7, 9] },
    assign: Object.assign({}, RUSH4, {
      LCB: { t: 'zone', x: 16, y: -17, r: 9 }, RCB: { t: 'zone', x: 16, y: 17, r: 9 }, FS: { t: 'zone', x: 20, y: 0, r: 10 },
      WLB: { t: 'zone', x: 6, y: -14, r: 6 }, MLB: { t: 'zone', x: 9, y: -3, r: 6 },
      SLB: { t: 'zone', x: 9, y: 5, r: 6 }, SS: { t: 'zone', x: 6, y: 14, r: 6 },
    }),
  },
  {
    id: 'cov1', name: 'COVER 1', tag: 'MANN',
    desc: 'Manndeckung mit einem tiefen Free Safety als Absicherung, MLB als Robber. Stark gegen kurze Pässe, braucht gute CBs.',
    align: { LCB: [2, -20], RCB: [2, 20], FS: [15, 0], SS: [5, 5.5], SLB: [4, 2.2], WLB: [4, -10] },
    assign: Object.assign({}, RUSH4, {
      LCB: { t: 'man', on: 'WR1' }, RCB: { t: 'man', on: 'WR2' }, WLB: { t: 'man', on: 'WR3' },
      SS: { t: 'man', on: 'TE' }, SLB: { t: 'man', on: 'RB' },
      MLB: { t: 'zone', x: 6, y: 0, r: 7 }, FS: { t: 'zone', x: 18, y: 0, r: 16 },
    }),
  },
  {
    id: 'blitz', name: 'BLITZ', tag: 'COVER 0',
    desc: 'Sechs Rusher, Manndeckung ohne tiefe Hilfe. Bringt schnell Druck und Sacks, aber ein verpasster Tackle heißt oft Touchdown.',
    align: { LCB: [2, -20], RCB: [2, 20], FS: [6, -11], SS: [5, 5.5], WLB: [3, -2.5], MLB: [3, 2.5], SLB: [4, 2.2] },
    assign: Object.assign({}, RUSH4, {
      WLB: { t: 'rush' }, MLB: { t: 'rush' },
      LCB: { t: 'man', on: 'WR1' }, RCB: { t: 'man', on: 'WR2' }, FS: { t: 'man', on: 'WR3' },
      SS: { t: 'man', on: 'TE' }, SLB: { t: 'man', on: 'RB' },
    }),
  },
];
