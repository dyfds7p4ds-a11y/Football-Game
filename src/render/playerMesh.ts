/**
 * Low-poly player figure: boxy limbs, faceted helmet, jersey numbers.
 * One instance per on-field player; colors are re-applied each play.
 */
import * as THREE from 'three';
import type { TeamColors } from '../data/types';

const numberCache = new Map<string, THREE.CanvasTexture>();

function numberTexture(n: number, fg: string, bg: string): THREE.CanvasTexture {
  const key = `${n}|${fg}|${bg}`;
  let t = numberCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = fg;
  g.font = 'bold 44px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 32, 36);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  numberCache.set(key, t);
  return t;
}

const labelCache = new Map<string, THREE.SpriteMaterial>();

export function labelMaterial(text: string, color: string): THREE.SpriteMaterial {
  const key = `${text}|${color}`;
  let m = labelCache.get(key);
  if (m) return m;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.strokeStyle = '#111';
  g.lineWidth = 8;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#111';
  g.font = `bold ${text.length > 1 ? 50 : 70}px "Arial Black", Impact, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  m = new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true });
  labelCache.set(key, m);
  return m;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const GEO = {
  leg: box(0.2, 0.9, 0.24).translate(0, -0.45, 0),
  arm: box(0.15, 0.68, 0.17).translate(0, -0.35, 0),
  torso: box(0.5, 0.72, 0.32),
  pads: box(0.7, 0.2, 0.4),
  helmet: new THREE.IcosahedronGeometry(0.19, 1),
  mask: box(0.22, 0.1, 0.08),
  number: new THREE.PlaneGeometry(0.34, 0.34),
  shadow: new THREE.CircleGeometry(0.42, 10),
};
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
const maskMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });

export class PlayerMesh {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private jersey = new THREE.MeshLambertMaterial({ flatShading: true });
  private pants = new THREE.MeshLambertMaterial({ flatShading: true });
  private helmet = new THREE.MeshLambertMaterial({ flatShading: true });
  private skin = new THREE.MeshLambertMaterial({ flatShading: true });
  private numBack = new THREE.MeshBasicMaterial();
  private numFront = new THREE.MeshBasicMaterial();
  private label: THREE.Sprite | null = null;
  private phase = Math.random() * 10;
  private tilt = 0;

  constructor() {
    this.legL = new THREE.Mesh(GEO.leg, this.pants);
    this.legR = new THREE.Mesh(GEO.leg, this.pants);
    this.legL.position.set(-0.12, 0.92, 0);
    this.legR.position.set(0.12, 0.92, 0);
    this.armL = new THREE.Mesh(GEO.arm, this.skin);
    this.armR = new THREE.Mesh(GEO.arm, this.skin);
    this.armL.position.set(-0.34, 1.62, 0);
    this.armR.position.set(0.34, 1.62, 0);
    const torso = new THREE.Mesh(GEO.torso, this.jersey);
    torso.position.y = 1.3;
    const pads = new THREE.Mesh(GEO.pads, this.jersey);
    pads.position.y = 1.66;
    const helmet = new THREE.Mesh(GEO.helmet, this.helmet);
    helmet.position.y = 1.95;
    helmet.scale.set(1, 1.05, 1.15);
    const mask = new THREE.Mesh(GEO.mask, maskMat);
    mask.position.set(0, 1.9, -0.21);
    const back = new THREE.Mesh(GEO.number, this.numBack);
    back.position.set(0, 1.32, 0.165);
    const front = new THREE.Mesh(GEO.number, this.numFront);
    front.position.set(0, 1.32, -0.165);
    front.rotation.y = Math.PI;
    this.body.add(this.legL, this.legR, this.armL, this.armR, torso, pads, helmet, mask, back, front);
    this.root.add(this.body);
    const shadow = new THREE.Mesh(GEO.shadow, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    this.root.add(shadow);
  }

  setLook(colors: TeamColors, number: number, skinTone: number) {
    this.jersey.color.set(colors.primary);
    this.pants.color.set(colors.pants);
    this.helmet.color.set(colors.helmet);
    this.skin.color.setHex(skinTone);
    const tex = numberTexture(number, colors.secondary, colors.primary);
    this.numBack.map = tex;
    this.numFront.map = tex;
    this.numBack.needsUpdate = true;
    this.numFront.needsUpdate = true;
  }

  setLabel(text: string | null, color = '#ffe066') {
    if (this.label) {
      this.root.remove(this.label);
      this.label = null;
    }
    if (!text) return;
    this.label = new THREE.Sprite(labelMaterial(text, color));
    this.label.position.y = 2.9;
    this.label.scale.set(0.9, 0.9, 0.9);
    this.label.renderOrder = 10;
    this.root.add(this.label);
  }

  /** Keep labels readable at any distance; enlarge the selected target. */
  updateLabel(camDist: number, highlighted: boolean) {
    if (!this.label) return;
    const s = Math.max(0.45, Math.min(1.8, camDist * 0.045)) * (highlighted ? 1.4 : 1);
    this.label.scale.set(s, s, s);
    this.label.position.y = 2.5 + s * 0.4;
  }

  /** Animate run cycle from speed (yd/s); `down` lays the player on the turf. */
  animate(dt: number, speed: number, down: boolean, stance: boolean) {
    this.phase += dt * (4 + speed * 1.15);
    const amp = Math.min(1, speed / 7) * 0.9;
    const sw = Math.sin(this.phase) * amp;
    this.legL.rotation.x = sw;
    this.legR.rotation.x = -sw;
    this.armL.rotation.x = -sw * 0.9;
    this.armR.rotation.x = sw * 0.9;
    const targetTilt = down ? Math.PI / 2.2 : stance ? 0.45 : Math.min(0.25, speed * 0.03);
    this.tilt += (targetTilt - this.tilt) * Math.min(1, dt * (down ? 6 : 8));
    this.body.rotation.x = -this.tilt;
    this.body.position.y = down ? -0.55 * (this.tilt / (Math.PI / 2.2)) : stance ? -0.3 : Math.abs(Math.sin(this.phase)) * 0.05 * amp;
  }
}
