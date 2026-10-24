/**
 * Stylized-realistic figure: rounded limbs, shoulder pads, helmet with face
 * mask and stripe, jersey numbers. The same rig draws officials (striped
 * shirt, cap, no pads). Procedural animation: run cycle, stance, and contact
 * poses for tackles (shoulder hit, arm wrap, stumble, hip turn, slide).
 */
import * as THREE from 'three';
import BODIES from '../data/bodies.json';
import type { TeamColors } from '../data/types';
import type { ContactAnim } from '../play/sim';
import { GRAPHICS, naturalUniform, type QualityPreset } from './graphics';

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
  g.font = 'bold 42px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 32, 36);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  numberCache.set(key, t);
  return t;
}

let stripeTex: THREE.CanvasTexture | null = null;
function refereeStripes(): THREE.CanvasTexture {
  if (stripeTex) return stripeTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 64; x += 8) {
    g.fillStyle = (x / 8) % 2 === 0 ? '#f4f4f4' : '#161616';
    g.fillRect(x, 0, 8, 16);
  }
  stripeTex = new THREE.CanvasTexture(c);
  stripeTex.colorSpace = THREE.SRGBColorSpace;
  stripeTex.wrapS = THREE.RepeatWrapping;
  stripeTex.repeat.set(2, 1);
  return stripeTex;
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

const GEO = {
  thigh: new THREE.CapsuleGeometry(0.11, 0.36, 4, 8).translate(0, -0.25, 0),
  shin: new THREE.CapsuleGeometry(0.085, 0.36, 4, 8).translate(0, -0.22, 0),
  shoe: new THREE.BoxGeometry(0.13, 0.08, 0.27).translate(0, -0.04, -0.04),
  upperArm: new THREE.CapsuleGeometry(0.075, 0.26, 4, 8).translate(0, -0.17, 0),
  forearm: new THREE.CapsuleGeometry(0.065, 0.24, 4, 8).translate(0, -0.15, 0),
  hand: new THREE.SphereGeometry(0.06, 8, 6),
  torso: new THREE.CylinderGeometry(0.25, 0.2, 0.62, 12),
  waist: new THREE.CylinderGeometry(0.2, 0.19, 0.2, 12),
  pads: new THREE.SphereGeometry(0.32, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.15, 0.55, 0.75),
  neck: new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8),
  helmet: new THREE.SphereGeometry(0.17, 16, 12),
  stripe: new THREE.BoxGeometry(0.05, 0.02, 0.34),
  maskBar: new THREE.BoxGeometry(0.2, 0.022, 0.022),
  maskSide: new THREE.BoxGeometry(0.022, 0.12, 0.022),
  head: new THREE.SphereGeometry(0.12, 12, 10),
  cap: new THREE.CylinderGeometry(0.125, 0.13, 0.08, 14),
  brim: new THREE.CylinderGeometry(0.13, 0.13, 0.015, 14, 1, false, -Math.PI / 2, Math.PI).translate(0, 0, -0.05),
  number: new THREE.PlaneGeometry(0.3, 0.3),
  shadow: new THREE.CircleGeometry(0.42, 16),
  belly: new THREE.SphereGeometry(0.2, 12, 10).scale(1.1, 0.9, 0.8),
};
export interface Build { width: number; depth: number; belly: number; thigh: number; arm: number; legs: number; height: number }
const NEUTRAL: Build = { width: 1, depth: 1, belly: 0, thigh: 1, arm: 1, legs: 1, height: 1 };
/** Phase 3d: proportions for a roster position (`data/bodies.json`); unknown positions are neutral. */
export function buildFor(position: string): Build {
  const b = (BODIES as unknown as Record<string, Partial<Build>>)[position];
  return b && typeof b === 'object' ? { ...NEUTRAL, ...b } : NEUTRAL;
}
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: GRAPHICS.lighting.contactShadow, depthWrite: false });

/** Phase 4: a fine knit pattern (white-ish, multiplied with the team color), shared by every jersey and pants. */
let fabric: THREE.CanvasTexture | null = null;
function fabricTexture(): THREE.CanvasTexture {
  if (fabric) return fabric;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 2) {
    for (let x = 0; x < 64; x += 2) {
      const v = 228 + ((x * 7 + y * 13) % 5) * 5 + ((y >> 1) % 2) * 6;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, 2, 1);
    }
  }
  fabric = new THREE.CanvasTexture(c);
  fabric.wrapS = fabric.wrapT = THREE.RepeatWrapping;
  fabric.repeat.set(3, 3);
  fabric.colorSpace = THREE.SRGBColorSpace;
  return fabric;
}
const maskMat = new THREE.MeshLambertMaterial({ color: 0x8c9196 });
const sockMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
const shoeMat = new THREE.MeshLambertMaterial({ color: 0x1c1c1c });

export type FigureKind = 'player' | 'official';

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
}

export class PlayerMesh {
  readonly root = new THREE.Group();
  /** Pivot at the hips: leans, falls and spins happen here. */
  private body = new THREE.Group();
  private legL: Limb;
  private legR: Limb;
  private armL: Limb;
  private armR: Limb;
  private jersey = new THREE.MeshLambertMaterial();
  private pants = new THREE.MeshLambertMaterial();
  /** Phase 4: Phong so helmets can carry a highlight (matte on LOW: no specular). */
  private helmetMat = new THREE.MeshPhongMaterial({ specular: 0x000000, shininess: 0 });
  private official: boolean;
  private skin = new THREE.MeshLambertMaterial();
  private numBack = new THREE.MeshBasicMaterial();
  private numFront = new THREE.MeshBasicMaterial();
  private label: THREE.Sprite | null = null;
  private phase = Math.random() * 10;
  private pitch = 0;
  private roll = 0;
  private spin = 0;
  private drop = 0;
  /** Phase 3d: body build (position proportions). */
  private hips = 0.98;
  private torso!: THREE.Mesh;
  private waist!: THREE.Mesh;
  private pads: THREE.Mesh | null = null;
  private belly: THREE.Mesh | null = null;
  private thighs: THREE.Mesh[] = [];
  private upperArms: THREE.Mesh[] = [];

  constructor(readonly kind: FigureKind = 'player') {
    const official = kind === 'official';
    this.official = official;
    const hips = 0.98;
    this.body.position.y = hips;
    this.root.add(this.body);

    const leg = (x: number): Limb => {
      const upper = new THREE.Group();
      upper.position.set(x, 0, 0);
      const thigh = new THREE.Mesh(GEO.thigh, this.pants);
      this.thighs.push(thigh);
      upper.add(thigh);
      const lower = new THREE.Group();
      lower.position.y = -0.5;
      const shin = new THREE.Mesh(GEO.shin, official ? this.pants : sockMat);
      const shoe = new THREE.Mesh(GEO.shoe, shoeMat);
      shoe.position.y = -0.46;
      lower.add(shin, shoe);
      upper.add(lower);
      this.body.add(upper);
      return { upper, lower };
    };
    this.legL = leg(-0.12);
    this.legR = leg(0.12);

    const waist = new THREE.Mesh(GEO.waist, this.pants);
    waist.position.y = 0.08;
    this.waist = waist;
    const torso = new THREE.Mesh(GEO.torso, this.jersey);
    this.torso = torso;
    torso.position.y = 0.45;
    if (official) torso.scale.set(0.85, 1, 0.85);
    this.body.add(waist, torso);
    if (!official) {
      const pads = new THREE.Mesh(GEO.pads, this.jersey);
      pads.position.y = 0.72;
      this.body.add(pads);
      this.pads = pads;
      // Phase 3d: linemen's gut (hidden unless the build has a belly).
      const belly = new THREE.Mesh(GEO.belly, this.jersey);
      belly.position.set(0, 0.24, -0.1);
      belly.visible = false;
      this.body.add(belly);
      this.belly = belly;
    }
    const neck = new THREE.Mesh(GEO.neck, this.skin);
    neck.position.y = 0.82;
    this.body.add(neck);

    const head = new THREE.Group();
    head.position.y = 0.97;
    if (official) {
      const face = new THREE.Mesh(GEO.head, this.skin);
      const cap = new THREE.Mesh(GEO.cap, this.helmetMat);
      cap.position.y = 0.08;
      const brim = new THREE.Mesh(GEO.brim, this.helmetMat);
      brim.position.y = 0.05;
      head.add(face, cap, brim);
    } else {
      const helmet = new THREE.Mesh(GEO.helmet, this.helmetMat);
      helmet.scale.set(1, 1.02, 1.12);
      const stripe = new THREE.Mesh(GEO.stripe, this.jersey);
      stripe.position.set(0, 0.165, 0.01);
      const face = new THREE.Mesh(GEO.head, this.skin);
      face.scale.setScalar(0.85);
      face.position.set(0, -0.02, -0.04);
      head.add(face, helmet, stripe);
      for (const y of [-0.02, -0.07]) {
        const bar = new THREE.Mesh(GEO.maskBar, maskMat);
        bar.position.set(0, y, -0.19);
        head.add(bar);
      }
      for (const x of [-0.09, 0.09]) {
        const side = new THREE.Mesh(GEO.maskSide, maskMat);
        side.position.set(x, -0.04, -0.17);
        head.add(side);
      }
    }
    this.body.add(head);

    const arm = (x: number): Limb => {
      const upper = new THREE.Group();
      upper.position.set(x, 0.74, 0);
      const ua = new THREE.Mesh(GEO.upperArm, official ? this.jersey : this.skin);
      this.upperArms.push(ua);
      upper.add(ua);
      const lower = new THREE.Group();
      lower.position.y = -0.33;
      const fore = new THREE.Mesh(GEO.forearm, this.skin);
      const hand = new THREE.Mesh(GEO.hand, this.skin);
      hand.position.y = -0.3;
      lower.add(fore, hand);
      upper.add(lower);
      this.body.add(upper);
      return { upper, lower };
    };
    this.armL = arm(official ? -0.27 : -0.36);
    this.armR = arm(official ? 0.27 : 0.36);

    if (!official) {
      const back = new THREE.Mesh(GEO.number, this.numBack);
      back.position.set(0, 0.45, 0.235);
      const front = new THREE.Mesh(GEO.number, this.numFront);
      front.position.set(0, 0.45, -0.235);
      front.rotation.y = Math.PI;
      this.body.add(back, front);
    } else {
      this.jersey.map = refereeStripes();
      this.jersey.color.set(0xffffff);
      this.pants.color.set(0xf0f0f0);
      this.helmetMat.color.set(0xffffff);
      this.skin.color.setHex(0xc68642);
    }

    const shadow = new THREE.Mesh(GEO.shadow, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    this.root.add(shadow);
  }

  /** Real-time shadows on/off (set from the graphics setting). */
  /** Phase 4: graphics quality: helmet gloss and the fabric texture (players only; officials keep their stripes). */
  setQuality(q: QualityPreset) {
    this.helmetMat.specular.setHex(q.glossyHelmets ? 0x3a3a3a : 0x000000);
    this.helmetMat.shininess = q.glossyHelmets ? 55 : 0;
    if (this.official) return;
    const map = q.fabric ? fabricTexture() : null;
    for (const m of [this.jersey, this.pants]) {
      if (m.map === map) continue;
      m.map = map;
      m.needsUpdate = true;
    }
  }

  setCastShadow(on: boolean) {
    this.body.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = on;
    });
  }

  /** Phase 3d: apply a position's proportions (players only; officials keep theirs). */
  setBuild(b: Build) {
    if (this.kind === 'official') return;
    this.torso.scale.set(b.width, 1, b.depth);
    this.waist.scale.set(b.width * (1 + 0.08 * b.belly), 1, b.depth * (1 + 0.1 * b.belly));
    this.pads?.scale.set(b.width, 1, b.depth);
    if (this.belly) {
      this.belly.visible = b.belly > 0;
      this.belly.scale.set(b.width * (0.7 + 0.3 * b.belly), 0.7 + 0.3 * b.belly, 0.6 + 0.6 * b.belly);
      this.belly.position.z = -0.08 * b.depth - 0.06 * b.belly;
    }
    for (const t of this.thighs) t.scale.set(b.thigh, 1, b.thigh);
    for (const a of this.upperArms) a.scale.set(b.arm, 1, b.arm);
    this.armL.upper.position.x = -0.36 * b.width;
    this.armR.upper.position.x = 0.36 * b.width;
    this.legL.upper.position.x = -0.12 * (0.5 + 0.5 * b.width);
    this.legR.upper.position.x = 0.12 * (0.5 + 0.5 * b.width);
    for (const l of [this.legL, this.legR]) l.upper.scale.set(1, b.legs, 1);
    this.hips = 0.98 * b.legs;
    this.root.scale.setScalar(b.height);
  }

  setLook(colors: TeamColors, number: number, skinTone: number) {
    // Phase 4: team colors read as dyed fabric (render/graphics.ts naturalUniform).
    this.jersey.color.set(naturalUniform(colors.primary));
    this.pants.color.set(naturalUniform(colors.pants));
    this.helmetMat.color.set(colors.helmet);
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

  /**
   * Animate from speed (yd/s). `down` lays the player on the turf; `anim` is a
   * contact animation (tackle, broken tackle, slide) started at sim time
   * anim.t; `simT` is the current sim time; `facing` the field heading.
   */
  animate(dt: number, speed: number, down: boolean, stance: boolean, anim: ContactAnim | null = null, simT = 0, facing = 0) {
    this.phase += dt * (4 + speed * 1.15);
    const amp = Math.min(1, speed / 7) * 0.9;
    const sw = Math.sin(this.phase) * amp;
    let pitch = stance ? 0.5 : Math.min(0.28, speed * 0.035);
    let roll = 0;
    let spin = 0;
    let drop = stance ? 0.28 : 0;
    let legSwing = sw;
    let armFwd = 0;
    let armIn = 0;

    if (anim) {
      const k = (simT - anim.t) / Math.max(0.05, anim.duration);
      const e = Math.min(1, Math.max(0, k));
      // Direction of the contact relative to where the player faces.
      const rel = anim.heading - facing;
      const side = Math.sin(rel) >= 0 ? 1 : -1;
      const fromFront = Math.cos(rel);
      const lying = anim.down && k >= 1;
      switch (anim.kind) {
        case 'shoulder':
          if (anim.role === 'carrier') {
            // Jolted back, then on his back.
            pitch = anim.down ? -0.35 - 1.1 * e : -0.4 * Math.sin(Math.min(1, k) * Math.PI);
          } else {
            pitch = anim.down ? 0.7 + 0.65 * e : 0.7 * (1 - e);
            armFwd = 0.9;
            armIn = 0.4;
          }
          break;
        case 'wrap':
          armFwd = anim.role === 'tackler' ? 1.4 : 0.3;
          armIn = anim.role === 'tackler' ? 0.7 : 0;
          roll = anim.down ? side * (anim.role === 'carrier' ? 1.0 : -1.0) * 1.35 * e : 0;
          pitch = anim.down ? 0.35 * e : 0.2;
          break;
        case 'stumble':
          if (anim.role === 'carrier') {
            // Tripped up from behind: stumbles forward and goes face down.
            pitch = anim.down ? 0.45 + 1.0 * e * e : 0.5 * Math.sin(Math.min(1, k) * Math.PI);
            armFwd = anim.down ? 1.2 * e : 0.5;
          } else {
            // Dives at the ankles.
            pitch = anim.down ? 1.1 + 0.35 * e : 1.1 * Math.sin(Math.min(1, k) * Math.PI);
            armFwd = 1.5;
          }
          break;
        case 'hipTurn':
          if (anim.role === 'carrier') {
            spin = side * Math.PI * Math.sin(Math.min(1, k) * Math.PI) * 0.45;
            pitch = 0.25;
          } else {
            pitch = 1.0 * Math.sin(Math.min(1, k) * Math.PI);
            armFwd = 1.3;
          }
          break;
        case 'slide':
          pitch = -1.15 * e;
          armFwd = -0.6;
          break;
      }
      if (fromFront < -0.3 && anim.kind === 'shoulder' && anim.role === 'carrier') pitch = -pitch; // hit from behind: falls forward
      if (anim.down || anim.kind === 'slide') {
        drop = (anim.kind === 'slide' ? 0.75 : 0.85) * e;
        legSwing = sw * (1 - e);
      }
      if (lying && Math.abs(pitch) < 0.3 && Math.abs(roll) < 0.3) pitch = 1.45;
    } else if (down) {
      pitch = 1.45;
      drop = 0.85;
      legSwing = 0;
    }

    const rate = Math.min(1, dt * (anim ? 14 : 8));
    this.pitch += (pitch - this.pitch) * rate;
    this.roll += (roll - this.roll) * rate;
    this.spin += (spin - this.spin) * rate;
    this.drop += (drop - this.drop) * rate;
    this.body.rotation.set(-this.pitch, this.spin, this.roll, 'YXZ');
    this.body.position.y = this.hips - this.drop + (anim || down ? 0 : Math.abs(Math.sin(this.phase)) * 0.05 * amp);

    // Signs: models face -z, so +x rotation swings a limb forward.
    this.legL.upper.rotation.x = legSwing;
    this.legR.upper.rotation.x = -legSwing;
    this.legL.lower.rotation.x = -Math.max(0, -legSwing) * 1.2;
    this.legR.lower.rotation.x = -Math.max(0, legSwing) * 1.2;
    if (stance) {
      this.legL.upper.rotation.x = 0.75;
      this.legR.upper.rotation.x = 0.55;
      this.legL.lower.rotation.x = -1.2;
      this.legR.lower.rotation.x = -1.0;
    }
    this.armL.upper.rotation.x = -sw * 0.9 + armFwd;
    this.armR.upper.rotation.x = sw * 0.9 + armFwd;
    this.armL.upper.rotation.z = armIn * 0.6 - 0.08;
    this.armR.upper.rotation.z = -armIn * 0.6 + 0.08;
    this.armL.lower.rotation.x = 0.5 + Math.max(0, sw) * 0.4;
    this.armR.lower.rotation.x = 0.5 + Math.max(0, -sw) * 0.4;
  }
}
