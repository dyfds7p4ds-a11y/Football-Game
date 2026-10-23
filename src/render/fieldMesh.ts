/**
 * Field, surroundings and on-field markers. The playing surface is one canvas
 * texture painted once per game: natural grass with mowing stripes and
 * noise, worn patches between the hashes, slightly worn paint. The stadium
 * bowl lives in stadium.ts. Static geometry is placed in the user team's
 * frame (never flipped); markers take world positions from SceneView.
 */
import * as THREE from 'three';
import { FIELD } from '../play/field';
import type { EligibleSlot, TeamData } from '../data/types';
import { PALETTE } from './palette';
import { Stadium } from './stadium';
import MARKERS from '../data/markers.json';

const PX = 24; // texture pixels per yard

/** Field frame -> world, ignoring the frame flip (the field itself never moves). */
const fw = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

export const SLOT_COLORS: Record<EligibleSlot, number> = { WR1: 0xffd23f, WR2: 0x4ea8ff, WR3: 0xff8c42, RB: 0xf1faee, TE: 0xc77dff };

const downTextures = new Map<number, THREE.CanvasTexture>();
/** Phase 3d: the down box face: a black number on orange ('' before a series). */
function downTexture(down: number): THREE.CanvasTexture {
  const hit = downTextures.get(down);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = MARKERS.color;
  g.fillRect(0, 0, 64, 64);
  if (down > 0) {
    g.fillStyle = '#111';
    g.font = 'bold 48px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(down), 32, 35);
  }
  const tex = new THREE.CanvasTexture(c);
  downTextures.set(down, tex);
  return tex;
}

export class FieldView {
  readonly group = new THREE.Group();
  private texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private losLine: THREE.Mesh;
  private fdLine: THREE.Mesh;
  private targetRing: THREE.Mesh;
  private receiverRings = new Map<EligibleSlot, THREE.Mesh>();
  private flags: THREE.Group[] = [];
  private stadium: Stadium | null = null;
  private lastTeams = '';

  constructor(renderer: THREE.WebGLRenderer) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(FIELD.halfWidth * 2 * PX);
    this.canvas.height = 120 * PX;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD.halfWidth * 2, 120),
      new THREE.MeshLambertMaterial({ map: this.texture }),
    );
    field.rotation.x = -Math.PI / 2;
    field.position.copy(fw(0, 50));
    field.receiveShadow = true;
    this.group.add(field);

    // Grass apron, then a darker sideline area out to the stands.
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.halfWidth * 2 + 14, 136), new THREE.MeshLambertMaterial({ map: this.grassTexture(PALETTE.grassOuter, 8) }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.copy(fw(0, 50, -0.01));
    apron.receiveShadow = true;
    this.group.add(apron);
    const surround = new THREE.Mesh(new THREE.PlaneGeometry(200, 260), new THREE.MeshLambertMaterial({ color: 0x4a4f45 }));
    surround.rotation.x = -Math.PI / 2;
    surround.position.copy(fw(0, 50, -0.03));
    this.group.add(surround);

    this.buildSidelines();
    this.buildGoalposts();

    const lineGeo = new THREE.PlaneGeometry(FIELD.halfWidth * 2, 0.22);
    this.losLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: PALETTE.los, transparent: true, opacity: 0.8 }));
    this.fdLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: PALETTE.firstDown, transparent: true, opacity: 0.85 }));
    for (const l of [this.losLine, this.fdLine]) {
      l.rotation.x = -Math.PI / 2;
      l.renderOrder = 1;
      this.group.add(l);
    }

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.1, 28),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.group.add(this.targetRing);

    // One marker ring per eligible receiver, so the QB sees every option at once.
    for (const slot of Object.keys(SLOT_COLORS) as EligibleSlot[]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.72, 24),
        new THREE.MeshBasicMaterial({ color: SLOT_COLORS[slot], transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      ring.renderOrder = 2;
      this.receiverRings.set(slot, ring);
      this.group.add(ring);
    }
  }

  setMarkers(los: number, firstDown: number | null, down: number | null = null) {
    this.losLine.position.copy(fw(0, los, 0.015));
    this.fdLine.visible = firstDown !== null && firstDown < FIELD.length;
    if (firstDown !== null) this.fdLine.position.copy(fw(0, firstDown, 0.016));
    this.setChains(los, firstDown, down);
  }

  showMarkers(v: boolean) {
    this.losLine.visible = v;
    this.fdLine.visible = v && this.fdLine.visible;
    this.chains.visible = v;
  }

  // ------------------------------------------------------------ Phase 3d: sideline down markers

  private chains = new THREE.Group();
  private downBox: THREE.Group | null = null;
  private rearPole: THREE.Group | null = null;
  private frontPole: THREE.Group | null = null;
  private chain: THREE.Mesh | null = null;
  private downFaces: THREE.MeshBasicMaterial[] = [];
  private shownDown = -1;

  private buildChains() {
    const M = MARKERS;
    const orange = new THREE.MeshLambertMaterial({ color: new THREE.Color(M.color) });
    const stick = new THREE.CylinderGeometry(0.035, 0.035, M.poleHeight, 8).translate(0, M.poleHeight / 2, 0);
    const pole = (top: THREE.Object3D) => {
      const g = new THREE.Group();
      const p = new THREE.Mesh(stick, orange);
      p.castShadow = true;
      top.position.y = M.poleHeight;
      g.add(p, top);
      this.chains.add(g);
      return g;
    };
    // Chain poles: an orange plate on top; down box: a four-sided box with the down on every face.
    const plate = () => new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.3, 0.06), orange);
    this.rearPole = pole(plate());
    this.frontPole = pole(plate());
    const box = new THREE.Group();
    const faceGeo = new THREE.PlaneGeometry(0.42, 0.42);
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      this.downFaces.push(mat);
      const f = new THREE.Mesh(faceGeo, mat);
      f.rotation.y = (i * Math.PI) / 2;
      f.position.set(Math.sin((i * Math.PI) / 2) * 0.215, 0, Math.cos((i * Math.PI) / 2) * 0.215);
      box.add(f);
    }
    this.downBox = pole(box);
    this.chain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1), new THREE.MeshLambertMaterial({ color: 0xc0c0c0 }));
    this.chains.add(this.chain);
    this.group.add(this.chains);
  }

  private setChains(los: number, firstDown: number | null, down: number | null) {
    if (!this.downBox) this.buildChains();
    const x = -(FIELD.halfWidth + MARKERS.sidelineOffset);
    this.downBox!.position.copy(fw(x, los, 0));
    const series = firstDown !== null && firstDown < FIELD.length;
    for (const o of [this.rearPole!, this.frontPole!, this.chain!]) o.visible = series;
    if (series) {
      const rear = firstDown! - 10;
      this.rearPole!.position.copy(fw(x, rear, 0));
      this.frontPole!.position.copy(fw(x, firstDown!, 0));
      this.chain!.position.copy(fw(x, (rear + firstDown!) / 2, 0.45));
      this.chain!.scale.z = 10;
    }
    const d = down ?? 0;
    if (d !== this.shownDown) {
      this.shownDown = d;
      const tex = downTexture(d);
      for (const m of this.downFaces) {
        m.map = tex;
        m.needsUpdate = true;
      }
    }
  }

  setTargetRing(pos: THREE.Vector3 | null, t: number) {
    this.targetRing.visible = !!pos;
    if (pos) {
      this.targetRing.position.set(pos.x, 0.03, pos.z);
      const s = 1 + Math.sin(t * 8) * 0.12;
      this.targetRing.scale.set(s, s, s);
    }
  }

  /** Receiver marker rings (world positions; null hides). */
  setReceiverRing(slot: EligibleSlot, pos: THREE.Vector3 | null, dim = false) {
    const r = this.receiverRings.get(slot)!;
    r.visible = !!pos;
    if (pos) {
      r.position.set(pos.x, 0.025, pos.z);
      (r.material as THREE.MeshBasicMaterial).opacity = dim ? 0.3 : 0.75;
    }
  }

  hideReceiverRings() {
    for (const r of this.receiverRings.values()) r.visible = false;
  }

  /** Penalty flags: position (world) + whether it is still in the air (flutter). */
  setFlags(flags: { pos: THREE.Vector3; flying: boolean; spin: number }[]) {
    while (this.flags.length < flags.length) {
      const g = new THREE.Group();
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.32), new THREE.MeshLambertMaterial({ color: 0xffd400, side: THREE.DoubleSide }));
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshLambertMaterial({ color: 0xf0c000 }));
      knot.position.set(0, 0, 0);
      cloth.position.set(0.12, 0.02, 0);
      g.add(cloth, knot);
      g.userData.cloth = cloth;
      this.flags.push(g);
      this.group.add(g);
    }
    this.flags.forEach((g, i) => {
      const f = flags[i];
      g.visible = !!f;
      if (!f) return;
      g.position.copy(f.pos);
      const cloth = g.userData.cloth as THREE.Mesh;
      if (f.flying) {
        g.rotation.set(f.spin, f.spin * 1.7, 0.3);
      } else {
        g.position.y = 0.04;
        g.rotation.set(0, i * 1.3, 0);
        cloth.rotation.set(-Math.PI / 2, 0, 0);
      }
    });
  }

  setCrowd(time: number, energy: number) {
    this.stadium?.update(time, energy);
  }

  /** Redraw the field texture and rebuild the crowd in the colors of both teams. */
  paint(own: TeamData, opp: TeamData) {
    const key = `${own.id}|${opp.id}`;
    if (key === this.lastTeams) return;
    this.lastTeams = key;
    this.paintField(own, opp);
    if (this.stadium) {
      this.group.remove(this.stadium.group);
      this.stadium.dispose();
    }
    this.stadium = new Stadium([own.colors.primary, own.colors.secondary], [opp.colors.primary]);
    this.group.add(this.stadium.group);
  }

  private paintField(own: TeamData, opp: TeamData) {
    const c = this.canvas.getContext('2d')!;
    const Wd = this.canvas.width;
    const H = this.canvas.height;
    // Canvas top = field y 110, bottom = field y -10.
    const yPix = (y: number) => H - (y + 10) * PX;
    const xPix = (x: number) => (x + FIELD.halfWidth) * PX;

    // Mowing stripes every 5 yards, kept subtle.
    for (let y = -10; y < 110; y += 5) {
      c.fillStyle = (Math.floor(y / 5) % 2 === 0) ? PALETTE.grassA : PALETTE.grassB;
      c.fillRect(0, yPix(y + 5), Wd, 5 * PX);
    }
    // Worn turf between the hashes (where most snaps happen) and in front of the posts.
    const wear = (x: number, y: number, rx: number, ry: number, a: number) => {
      c.save();
      c.translate(xPix(x), yPix(y));
      c.scale(1, ry / rx);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, rx * PX);
      g.addColorStop(0, `rgba(140, 128, 80, ${a})`);
      g.addColorStop(1, 'rgba(140, 128, 80, 0)');
      c.fillStyle = g;
      c.fillRect(-rx * PX, -rx * PX, 2 * rx * PX, 2 * rx * PX);
      c.restore();
    };
    for (let y = 15; y <= 85; y += 10) wear(0, y, 7, 4, 0.16);
    wear(0, 3, 9, 4, 0.2);
    wear(0, 97, 9, 4, 0.2);

    const endzone = (team: TeamData, y0: number, flip: boolean) => {
      c.save();
      c.globalAlpha = 0.88;
      c.fillStyle = team.colors.primary;
      c.fillRect(0, yPix(y0 + 10), Wd, 10 * PX);
      c.restore();
      c.save();
      c.translate(Wd / 2, yPix(y0 + 5));
      if (flip) c.rotate(Math.PI);
      c.fillStyle = team.colors.secondary;
      c.font = `bold ${Math.round(6 * PX)}px "Arial Black", Impact, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(team.name.toUpperCase(), 0, 0, Wd * 0.86);
      c.restore();
    };
    endzone(own, -10, true);
    endzone(opp, 100, false);

    c.fillStyle = PALETTE.line;
    c.strokeStyle = PALETTE.line;
    const line = (y: number, w = 3) => c.fillRect(0, yPix(y) - w / 2, Wd, w);
    for (let y = 0; y <= 100; y += 5) line(y, y % 50 === 0 ? 6 : 4);
    for (let y = 1; y < 100; y++) {
      if (y % 5 === 0) continue;
      for (const x of [-FIELD.hash, FIELD.hash]) c.fillRect(xPix(x) - PX * 0.33, yPix(y) - 1.5, PX * 0.66, 3);
      c.fillRect(xPix(-FIELD.halfWidth + 0.4), yPix(y) - 1.5, PX * 0.66, 3);
      c.fillRect(xPix(FIELD.halfWidth - 1.06), yPix(y) - 1.5, PX * 0.66, 3);
    }
    c.lineWidth = 8;
    c.strokeRect(4, 4, Wd - 8, H - 8);
    c.font = `bold ${Math.round(2 * PX)}px "Arial Black", Impact, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let y = 10; y <= 90; y += 10) {
      const n = String(y <= 50 ? y : 100 - y);
      for (const side of [-1, 1]) {
        c.save();
        c.translate(xPix(side * (FIELD.halfWidth - 9)), yPix(y));
        c.rotate(side < 0 ? Math.PI / 2 : -Math.PI / 2);
        c.fillText(n.split('').join(' '), 0, 0);
        c.restore();
      }
    }
    // Midfield logo.
    c.save();
    c.translate(Wd / 2, yPix(50));
    c.globalAlpha = 0.9;
    c.fillStyle = own.colors.primary;
    c.beginPath();
    c.arc(0, 0, 4 * PX, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = own.colors.secondary;
    c.font = `bold ${Math.round(2.6 * PX)}px "Arial Black", Impact, sans-serif`;
    c.rotate(Math.PI);
    c.fillText(own.abbr, 0, 0);
    c.restore();

    // Grain: per-pixel noise on the grass, and worn specks in the paint.
    const img = c.getImageData(0, 0, Wd, H);
    const d = img.data;
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const isPaint = r > 200 && g > 200 && b > 180;
      const n = rnd();
      if (isPaint) {
        if (n < 0.12) {
          // Worn paint lets green through.
          d[i] = r * 0.55 + 60 * 0.45;
          d[i + 1] = g * 0.55 + 130 * 0.45;
          d[i + 2] = b * 0.55 + 55 * 0.45;
        }
      } else {
        const k = (n - 0.5) * 18 + (rnd() - 0.5) * 8;
        d[i] = clamp8(r + k * 0.6);
        d[i + 1] = clamp8(g + k);
        d[i + 2] = clamp8(b + k * 0.5);
      }
    }
    c.putImageData(img, 0, 0);
    this.texture.needsUpdate = true;
  }

  private grassTexture(base: string, repeat: number): THREE.CanvasTexture {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const g = cv.getContext('2d')!;
    g.fillStyle = base;
    g.fillRect(0, 0, 128, 128);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '20,40,10' : '120,150,80'}, ${0.08 + rnd() * 0.08})`;
      g.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat * 1.6);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private buildSidelines() {
    // Team benches and a strip of sideline paint on both sides.
    const benchMat = new THREE.MeshLambertMaterial({ color: 0x2c3440 });
    const coolerMat = new THREE.MeshLambertMaterial({ color: 0xff7b00 });
    for (const side of [-1, 1]) {
      for (let y = 32; y <= 68; y += 6) {
        const bench = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 5), benchMat);
        bench.position.copy(fw(side * (FIELD.halfWidth + 6.5), y, 0.25));
        bench.castShadow = true;
        this.group.add(bench);
      }
      const cooler = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.6, 10), coolerMat);
      cooler.position.copy(fw(side * (FIELD.halfWidth + 5.5), 50, 0.3));
      this.group.add(cooler);
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(2, 120), new THREE.MeshLambertMaterial({ color: 0xf4f1de }));
      strip.rotation.x = -Math.PI / 2;
      strip.position.copy(fw(side * (FIELD.halfWidth + 1.2), 50, 0.005));
      this.group.add(strip);
    }
  }

  private buildGoalposts() {
    const mat = new THREE.MeshLambertMaterial({ color: PALETTE.goalpost });
    const pad = new THREE.MeshLambertMaterial({ color: 0x1f3a5f });
    for (const y of [-10, 110]) {
      const g = new THREE.Group();
      const dir = y < 0 ? 1 : -1;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.33, 10), mat);
      base.position.set(0, 1.66, dir * 1.5);
      const padding = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 2, 10), pad);
      padding.position.set(0, 1, dir * 1.5);
      const neck = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 1.6), mat);
      neck.position.set(0, 3.33, dir * 0.75);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(6.17, 0.22, 0.22), mat);
      bar.position.set(0, 3.33, 0);
      g.add(base, padding, neck, bar);
      for (const sx of [-1, 1]) {
        const up = new THREE.Mesh(new THREE.BoxGeometry(0.15, 10, 0.15), mat);
        up.position.set((sx * 6.17) / 2, 3.33 + 5, 0);
        g.add(up);
      }
      g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      g.position.copy(fw(0, y));
      this.group.add(g);
    }
  }
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
