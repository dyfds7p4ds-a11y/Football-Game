/**
 * Field, stadium and markers. The field is one canvas texture: cheap to draw
 * and crisp enough from the QB's eye height with anisotropic filtering.
 */
import * as THREE from 'three';
import { FIELD } from '../play/field';
import type { TeamData } from '../data/types';
import { PALETTE } from './palette';
import { toWorld } from './coords';

const PX = 24; // texture pixels per yard

export class FieldView {
  readonly group = new THREE.Group();
  private texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private losLine: THREE.Mesh;
  private fdLine: THREE.Mesh;
  private targetRing: THREE.Mesh;

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
    field.position.copy(toWorld(0, 50));
    this.group.add(field);

    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 170),
      new THREE.MeshLambertMaterial({ color: PALETTE.grassOuter }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.copy(toWorld(0, 50, -0.02));
    this.group.add(outer);

    this.buildStadium();
    this.buildGoalposts();

    const lineGeo = new THREE.PlaneGeometry(FIELD.halfWidth * 2, 0.22);
    this.losLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: PALETTE.los, transparent: true, opacity: 0.85 }));
    this.fdLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: PALETTE.firstDown, transparent: true, opacity: 0.9 }));
    for (const l of [this.losLine, this.fdLine]) {
      l.rotation.x = -Math.PI / 2;
      l.renderOrder = 1;
      this.group.add(l);
    }

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1.0, 20),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.group.add(this.targetRing);
  }

  setMarkers(los: number, firstDown: number | null) {
    this.losLine.position.copy(toWorld(0, los, 0.015));
    this.fdLine.visible = firstDown !== null && firstDown < FIELD.length;
    if (firstDown !== null) this.fdLine.position.copy(toWorld(0, firstDown, 0.016));
  }

  showMarkers(v: boolean) {
    this.losLine.visible = v;
    this.fdLine.visible = v && this.fdLine.visible;
  }

  setTargetRing(pos: THREE.Vector3 | null, t: number) {
    this.targetRing.visible = !!pos;
    if (pos) {
      this.targetRing.position.set(pos.x, 0.03, pos.z);
      const s = 1 + Math.sin(t * 8) * 0.12;
      this.targetRing.scale.set(s, s, s);
    }
  }

  /** Redraw the field texture with the endzone colors of both teams. */
  paint(own: TeamData, opp: TeamData) {
    const c = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // Canvas top = field y 110, bottom = field y -10.
    const yPix = (y: number) => H - (y + 10) * PX;
    const xPix = (x: number) => (x + FIELD.halfWidth) * PX;

    for (let y = 0; y < 100; y += 5) {
      c.fillStyle = (y / 5) % 2 === 0 ? PALETTE.grassA : PALETTE.grassB;
      c.fillRect(0, yPix(y + 5), W, 5 * PX);
    }
    const endzone = (team: TeamData, y0: number, flip: boolean) => {
      c.fillStyle = team.colors.primary;
      c.fillRect(0, yPix(y0 + 10), W, 10 * PX);
      c.save();
      c.translate(W / 2, yPix(y0 + 5));
      if (flip) c.rotate(Math.PI);
      c.fillStyle = team.colors.secondary;
      c.font = `bold ${Math.round(6 * PX)}px "Arial Black", Impact, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(team.name.toUpperCase(), 0, 0, W * 0.86);
      c.restore();
    };
    endzone(own, -10, true);
    endzone(opp, 100, false);

    c.strokeStyle = PALETTE.line;
    c.fillStyle = PALETTE.line;
    const line = (y: number, w = 3) => c.fillRect(0, yPix(y) - w / 2, W, w);
    for (let y = 0; y <= 100; y += 5) line(y, y % 50 === 0 ? 6 : 4);
    // Hash marks and sideline ticks every yard.
    for (let y = 1; y < 100; y++) {
      if (y % 5 === 0) continue;
      for (const x of [-FIELD.hash, FIELD.hash]) c.fillRect(xPix(x) - PX * 0.33, yPix(y) - 1.5, PX * 0.66, 3);
      c.fillRect(xPix(-FIELD.halfWidth + 0.4), yPix(y) - 1.5, PX * 0.66, 3);
      c.fillRect(xPix(FIELD.halfWidth - 1.06), yPix(y) - 1.5, PX * 0.66, 3);
    }
    // Sidelines / end lines.
    c.lineWidth = 8;
    c.strokeRect(4, 4, W - 8, H - 8);
    // Yard numbers (read from the sidelines).
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
    c.translate(W / 2, yPix(50));
    c.fillStyle = own.colors.primary;
    c.beginPath();
    c.arc(0, 0, 4 * PX, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = own.colors.secondary;
    c.font = `bold ${Math.round(2.6 * PX)}px "Arial Black", Impact, sans-serif`;
    c.rotate(Math.PI);
    c.fillText(own.abbr, 0, 0);
    c.restore();
    this.texture.needsUpdate = true;
  }

  private buildStadium() {
    // Crowd texture: random colored "pixels" for a retro stadium.
    const cc = document.createElement('canvas');
    cc.width = 256;
    cc.height = 64;
    const g = cc.getContext('2d')!;
    g.fillStyle = '#2b2d42';
    g.fillRect(0, 0, 256, 64);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < 64; y += 4) {
      for (let x = 0; x < 256; x += 4) {
        if (rnd() < 0.8) {
          g.fillStyle = PALETTE.crowd[Math.floor(rnd() * PALETTE.crowd.length)];
          g.fillRect(x + 1, y + 1, 2, 2);
        }
      }
    }
    const crowdTex = new THREE.CanvasTexture(cc);
    crowdTex.colorSpace = THREE.SRGBColorSpace;
    crowdTex.magFilter = THREE.NearestFilter;
    crowdTex.wrapS = THREE.RepeatWrapping;
    crowdTex.wrapT = THREE.RepeatWrapping;

    const standMat = (rx: number) => {
      const t = crowdTex.clone();
      t.needsUpdate = true;
      t.repeat.set(rx, 3);
      return new THREE.MeshLambertMaterial({ map: t });
    };
    const trim = new THREE.MeshLambertMaterial({ color: PALETTE.standsTrim });
    const makeStand = (len: number, x: number, z: number, rotY: number) => {
      const g2 = new THREE.Group();
      const slope = new THREE.Mesh(new THREE.PlaneGeometry(len, 26), standMat(len / 16));
      slope.rotation.x = -Math.PI / 2 + 0.55;
      slope.position.set(0, 11, -11);
      g2.add(slope);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 2.2, 0.6), trim);
      wall.position.set(0, 1.1, 0);
      g2.add(wall);
      g2.position.set(x, 0, z);
      g2.rotation.y = rotY;
      this.group.add(g2);
    };
    const side = FIELD.halfWidth + 7;
    makeStand(130, -side, -50, -Math.PI / 2);
    makeStand(130, side, -50, Math.PI / 2);
    makeStand(70, 0, -(110 + 8), 0);
    makeStand(70, 0, 10 + 8, Math.PI);

    // Light towers.
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555b6e });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
    for (const [x, y] of [[-1, -5], [1, -5], [-1, 105], [1, 105]] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 40, 6), poleMat);
      const pos = toWorld(x * (FIELD.halfWidth + 24), y, 20);
      pole.position.copy(pos);
      this.group.add(pole);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 1), lampMat);
      lamp.position.copy(toWorld(x * (FIELD.halfWidth + 24), y, 41));
      lamp.lookAt(toWorld(0, 50, 0));
      this.group.add(lamp);
    }
  }

  private buildGoalposts() {
    const mat = new THREE.MeshLambertMaterial({ color: PALETTE.goalpost });
    for (const y of [-10, 110]) {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.33, 6), mat);
      base.position.set(0, 1.66, (y < 0 ? 1 : -1) * 1.5);
      const neck = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 1.6), mat);
      neck.position.set(0, 3.33, (y < 0 ? 1 : -1) * 0.75);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(6.17, 0.22, 0.22), mat);
      bar.position.set(0, 3.33, 0);
      g.add(base, neck, bar);
      for (const sx of [-1, 1]) {
        const up = new THREE.Mesh(new THREE.BoxGeometry(0.15, 10, 0.15), mat);
        up.position.set((sx * 6.17) / 2, 3.33 + 5, 0);
        g.add(up);
      }
      g.position.copy(toWorld(0, y));
      this.group.add(g);
    }
  }
}
