/**
 * SceneView: owns the Three.js renderer/scene and mirrors a PlaySim or a
 * ReturnSim each frame. Read-only with respect to game state.
 *
 * Look: stylized realistic. Soft shadows from one sun light that follows the
 * play, a gradient sky, fog for depth, the stadium bowl from stadium.ts.
 */
import * as THREE from 'three';
import type { DefSlot, TeamData, EligibleSlot } from '../data/types';
import { unitOf, type DefUnit } from '../play/defenseSelect';
import { ELIGIBLE } from '../data/types';
import { lerp as lerp2 } from '../core/vec';
import { PlaySim, type Actor } from '../play/sim';
import type { ReturnSim } from '../play/returnSim';
import { flagPosition } from '../play/penalties';
import { jumpHeight } from '../play/interception';
import { flightPos, type KickFlight } from '../play/kicking';
import { FieldView, SLOT_COLORS } from './fieldMesh';
import { PlayerMesh, buildFor } from './playerMesh';
import { PALETTE } from './palette';
import { headingToRotY, setFrameFlip, toWorld } from './coords';
import cameraJson from '../data/camera.json';
import { GRAPHICS, qualityPreset, type GraphicsQuality, type QualityPreset } from './graphics';

type CamRig = { back: number; height: number; lookAhead: number; lookHeight: number };
type DefRig = CamRig & { lookToBall: number; follow: number };
type FormationRig = { behindBall: number; behindDeepest: number; height: number; lookAhead: number; lookHeight: number; lateralShare: number; userShare: number; follow: number };
export const CAMERA = cameraJson as { pocket: CamRig & { gazePan: number }; carrier: CamRig; followDepth: number; followLateral: number; lateralShare: number; fov: number; fovPortrait: number; hideOfficialsWithin: number; defense: DefRig; formation: FormationRig; defenseUnits: Record<DefUnit, Partial<DefRig>> };

export type CameraMode = 'firstPerson' | 'behindQB';
/** Phase 4: defense camera. FORMATION (default) = behind the whole defense; PLAYER = behind the selected defender (Phase 3a). */
export type DefenseCameraMode = 'formation' | 'player';
/** Defense (user controls a cornerback): camera behind the selected defender, looking at the offense. */
export const USER_DEF_LABELS: Partial<Record<string, string>> = { CB1: 'CB1', CB2: 'CB2', NB: 'NB' };

export interface ViewInput {
  gazeYaw: number;
  gazePitch: number;
  target: EligibleSlot | null;
  cameraMode: CameraMode;
  /** Before the snap: players in stance. */
  presnap: boolean;
  /** Phase 4: defense camera (default formation). */
  defenseCamera?: DefenseCameraMode;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** In front of the camera and inside the viewport. */
  onScreen: boolean;
}

const LABELS: Record<EligibleSlot, string> = { WR1: '1', WR2: '2', WR3: '3', RB: 'RB', TE: 'TE' };
const EYE = 2.15;
/** Eyes sit slightly behind the sim position so linemen don't fill the screen. */
const EYE_BACK = 0.45;
const LABEL_HEX: Record<EligibleSlot, string> = Object.fromEntries(
  ELIGIBLE.map((s) => [s, `#${SLOT_COLORS[s].toString(16).padStart(6, '0')}`]),
) as Record<EligibleSlot, string>;

/** Anything SceneView can draw: a scrimmage play or a kick return. */
export type FieldSim = PlaySim | ReturnSim;

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly field: FieldView;
  readonly players: PlayerMesh[] = [];
  readonly officials: PlayerMesh[] = [];
  readonly ball: THREE.Mesh;
  private heldBall: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  /** Phase 4: shadowless light from behind the play (as the camera sees it): brighter player edges. */
  private rim: THREE.DirectionalLight;
  private quality: QualityPreset = qualityPreset(GRAPHICS.default);
  private shadowsWanted = true;
  private pixelScale = 1;
  private time = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  /** Actor id of the defender currently carrying the user's label (-1: none). */
  private labeledDef = -1;
  private routeGroup = new THREE.Group();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private crowdEnergy = 0.3;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE.sky);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = GRAPHICS.lighting.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(PALETTE.sky);
    this.scene.fog = new THREE.Fog(PALETTE.horizon, 120, 330);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 700);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.add(this.skyDome());

    const L = GRAPHICS.lighting;
    this.scene.add(new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemiIntensity));
    this.sun = new THREE.DirectionalLight(L.sunColor, L.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -38;
    sc.right = 38;
    sc.top = 38;
    sc.bottom = -38;
    sc.near = 10;
    sc.far = 220;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target);
    this.rim = new THREE.DirectionalLight(L.rimColor, L.rimIntensity);
    this.rim.castShadow = false;
    this.scene.add(this.rim, this.rim.target);

    this.field = new FieldView(this.renderer);
    this.scene.add(this.field.group);

    const ballGeo = new THREE.SphereGeometry(0.15, 14, 10);
    ballGeo.scale(1, 1, 1.75);
    const ballMat = new THREE.MeshLambertMaterial({ color: PALETTE.ball });
    this.ball = new THREE.Mesh(ballGeo, ballMat);
    this.ball.castShadow = true;
    const laces = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    laces.position.y = 0.15;
    this.ball.add(laces);
    this.scene.add(this.ball);
    // First-person: the ball in the QB's hands, attached to the camera.
    this.heldBall = this.ball.clone();
    this.heldBall.position.set(0.36, -0.44, -0.95);
    this.heldBall.rotation.set(0.35, 0.6, 0);
    this.heldBall.scale.setScalar(0.65);
    this.camera.add(this.heldBall);

    this.scene.add(this.routeGroup);
    for (let i = 0; i < 22; i++) {
      const p = new PlayerMesh();
      this.players.push(p);
      this.scene.add(p.root);
    }
    for (let i = 0; i < 5; i++) {
      const o = new PlayerMesh('official');
      o.root.visible = false;
      this.officials.push(o);
      this.scene.add(o.root);
    }
    this.setShadows(true);
    this.resize();
  }

  private skyDome(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(500, 24, 12);
    const top = new THREE.Color(PALETTE.skyTop);
    const bottom = new THREE.Color(PALETTE.horizon);
    const colors: number[] = [];
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = Math.max(0, pos.getY(i) / 500);
      const c = bottom.clone().lerp(top, Math.pow(k, 0.6));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    mesh.renderOrder = -1;
    return mesh;
  }

  setShadows(on: boolean) {
    this.shadowsWanted = on;
    on = on && this.quality.shadows;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    for (const p of [...this.players, ...this.officials]) p.setCastShadow(on);
  }

  /** Phase 4: graphics quality preset (data/graphics.json): pixel ratio, shadows, rim light, materials. */
  setQuality(q: GraphicsQuality) {
    const Q = (this.quality = qualityPreset(q));
    this.renderer.shadowMap.type = Q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.sun.shadow.mapSize.x !== Q.shadowMapSize) {
      this.sun.shadow.mapSize.set(Q.shadowMapSize, Q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.rim.visible = Q.rimLight;
    for (const p of [...this.players, ...this.officials]) p.setQuality(Q);
    this.setShadows(this.shadowsWanted);
    this.resize();
  }

  /** The rim light sits behind the play as seen from the camera, high up, so it outlines the players. */
  private placeRim() {
    if (!this.rim.visible) return;
    const dir = this.camera.getWorldDirection(this.tmp).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const look = this.tmp2.copy(this.camera.position).addScaledVector(dir, 25).setY(0);
    this.rim.target.position.copy(look);
    this.rim.position.copy(look).addScaledVector(dir, 40).setY(look.y + 22);
  }

  setPixelScale(scale: number) {
    this.pixelScale = scale;
    this.canvas.style.imageRendering = scale < 1 ? 'pixelated' : 'auto';
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioCap);
    this.renderer.setPixelRatio(dpr * this.pixelScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep a sensible horizontal FOV in portrait.
    this.applyFov(this.broadcastFov);
  }

  private broadcastFov = false;

  /** QB eyes and cutscenes use the wide FOV, the broadcast view a narrower one. */
  private applyFov(broadcast: boolean) {
    this.broadcastFov = broadcast;
    const portrait = this.camera.aspect < 1;
    const fov = broadcast ? (portrait ? CAMERA.fovPortrait : CAMERA.fov) : portrait ? 85 : 70;
    if (fov === this.camera.fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  setTeams(user: TeamData, cpu: TeamData) {
    this.field.paint(user, cpu);
  }

  setCrowdEnergy(e: number) {
    this.crowdEnergy = e;
  }

  /** Assign team looks and receiver labels for a new play or return. */
  bindPlay(sim: FieldSim, offense: TeamData, defense: TeamData) {
    const scrimmage = sim instanceof PlaySim;
    sim.actors.forEach((a, i) => {
      const pm = this.players[i];
      const team = a.side === 'off' ? offense : defense;
      pm.setLook(team.colors, a.player.number, PALETTE.skin[(a.player.number * 7 + a.id) % PALETTE.skin.length]);
      pm.setBuild(buildFor(a.position));
      const userDefense = scrimmage && sim.userDefId >= 0;
      const isElig = scrimmage && !userDefense && a.side === 'off' && (ELIGIBLE as readonly string[]).includes(a.slot);
      // On defense the user's cornerbacks are labelled instead of the CPU's receivers.
      const defLabel = userDefense && a.side === 'def' ? USER_DEF_LABELS[a.slot] ?? null : null;
      pm.setLabel(isElig ? LABELS[a.slot as EligibleSlot] : defLabel, isElig ? LABEL_HEX[a.slot as EligibleSlot] : undefined);
      pm.root.visible = true;
    });
    for (let i = sim.actors.length; i < this.players.length; i++) this.players[i].root.visible = false;
    for (const o of this.officials) o.root.visible = true;
    this.labeledDef = -1;
    this.camInit = false;
  }

  /** Pre-snap route hints painted on the turf (null clears them). */
  showRoutes(sim: PlaySim | null) {
    for (const c of this.routeGroup.children) (c as THREE.Mesh).geometry.dispose();
    this.routeGroup.clear();
    if (!sim) return;
    for (const slot of ELIGIBLE) {
      const a = sim.get(slot);
      let pts = a.route && !a.route.blocks ? [a.pos, ...a.route.points] : [];
      if (slot === 'RB' && sim.play.run) {
        const aim = sim.ballX + sim.play.run.aim;
        pts = sim.play.run.style === 'toss'
          ? [a.pos, { x: sim.ballX + sim.play.run.aim * 0.55, y: sim.los - 4.5 }, { x: aim, y: sim.los - 1.5 }, { x: aim, y: sim.los + 8 }]
          : [a.pos, { x: sim.get('QB').pos.x, y: sim.get('QB').pos.y }, { x: aim, y: sim.los + 0.5 }, { x: aim, y: sim.los + 8 }];
      }
      const mat = new THREE.MeshBasicMaterial({ color: SLOT_COLORS[slot], transparent: true, opacity: 0.75, depthWrite: false });
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = { x: pts[i].x, y: Math.min(pts[i].y, sim.los + 22) };
        const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if (len < 0.1) continue;
        const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.28, len).rotateX(-Math.PI / 2), mat);
        seg.rotation.y = headingToRotY(Math.atan2(p1.x - p0.x, p1.y - p0.y));
        seg.position.copy(toWorld((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, 0.03));
        seg.renderOrder = 2;
        this.routeGroup.add(seg);
      }
    }
  }

  /** Camera for screens without an active play (behind the ball). */
  updateIdle(ballX: number, ballY: number, dt: number) {
    setFrameFlip(false);
    this.time += dt;
    for (const p of this.players) p.root.visible = false;
    for (const o of this.officials) o.root.visible = false;
    this.ball.visible = true;
    this.heldBall.visible = false;
    this.ball.position.copy(toWorld(ballX, ballY, 0.15));
    this.ball.rotation.set(0, 0, Math.PI / 2);
    this.field.setTargetRing(null, 0);
    this.field.hideReceiverRings();
    this.field.setFlags([]);
    this.applyFov(false);
    this.camera.position.copy(toWorld(ballX + Math.sin(this.time * 0.1) * 6, ballY - 14, 6));
    this.camera.lookAt(toWorld(ballX, ballY + 10, 0));
    this.followSun(ballX, ballY);
    this.camInit = false;
  }

  /** Project a sim-frame point (x, y, height) to screen pixels. */
  project(x: number, y: number, h = 1.6): ScreenPoint {
    const v = toWorld(x, y, h, this.tmp).project(this.camera);
    const w = window.innerWidth;
    const hh = window.innerHeight;
    const front = v.z < 1;
    let sx = (v.x * 0.5 + 0.5) * w;
    let sy = (-v.y * 0.5 + 0.5) * hh;
    if (!front) {
      // Behind the camera: mirror so edge arrows point the right way.
      sx = w - sx;
      sy = hh;
    }
    return { x: sx, y: sy, onScreen: front && sx >= 0 && sx <= w && sy >= 0 && sy <= hh };
  }

  private drawActors(actors: Actor[], alpha: number, dt: number, simT: number, presnap: boolean, hideId: number, target: EligibleSlot | null) {
    actors.forEach((a, i) => {
      const pm = this.players[i];
      const p = lerp2(a.prevPos, a.pos, alpha);
      pm.root.position.copy(toWorld(p.x, p.y, jumpHeight(simT - a.jumpT)));
      pm.root.rotation.y = headingToRotY(a.facing);
      const speed = Math.hypot(a.vel.x, a.vel.y);
      const stance = presnap && a.position !== 'QB' && a.position !== 'WR' && a.position !== 'CB' && a.position !== 'S';
      pm.animate(dt, speed, a.down, stance, a.anim, simT, a.facing);
      pm.updateLabel(pm.root.position.distanceTo(this.camera.position), a.side === 'off' && a.slot === target);
      pm.root.visible = a.id !== hideId;
    });
  }

  private drawOfficials(sim: FieldSim, alpha: number, dt: number) {
    sim.officials.forEach((o, i) => {
      const pm = this.officials[i];
      const p = lerp2(o.prevPos, o.pos, alpha);
      pm.root.position.copy(toWorld(p.x, p.y));
      // An official right under the broadcast camera would block the view of the QB.
      const dx = pm.root.position.x - this.camera.position.x;
      const dz = pm.root.position.z - this.camera.position.z;
      pm.root.visible = !this.broadcastFov || dx * dx + dz * dz > CAMERA.hideOfficialsWithin ** 2;
      pm.root.rotation.y = headingToRotY(o.facing);
      pm.animate(dt, Math.hypot(o.vel.x, o.vel.y), false, false);
    });
  }

  private drawFlags(sim: FieldSim) {
    const flags = sim.flags.map((f) => {
      const fp = flagPosition(f, sim.t);
      if (!fp) {
        // Still in the official's hand: show it at his hip.
        const o = sim.officials[f.official];
        return { pos: toWorld(o.pos.x + 0.3, o.pos.y, 1.0), flying: true, spin: 0 };
      }
      return { pos: toWorld(fp.x, fp.y, fp.h), flying: !fp.landed, spin: this.time * 9 };
    });
    this.field.setFlags(flags);
  }

  private followSun(x: number, y: number) {
    const c = toWorld(x, y, 0, this.tmp2);
    this.sun.target.position.copy(c);
    this.sun.position.set(c.x - 45, 85, c.z + 30);
  }

  update(sim: FieldSim, alpha: number, dt: number, inp: ViewInput) {
    this.time += dt;
    this.field.setCrowd(this.time, this.crowdEnergy);
    if (!(sim instanceof PlaySim)) {
      this.updateReturn(sim, alpha, dt);
      return;
    }
    // A CPU offense (user on defense) runs in the CPU's frame: draw it flipped into the user's world.
    const userDef = sim.userDefender;
    setFrameFlip(!!userDef);
    const qb = sim.get('QB');
    const carrier = sim.carrier;
    // First person while the play is "through the QB's eyes"; chase cam once someone else has the ball.
    // A scramble switches QB eyes to the broadcast view so the field axis stays put.
    const firstPerson = !userDef && inp.cameraMode === 'firstPerson' && !(carrier && carrier !== qb) && !sim.scrambling;
    this.drawActors(sim.actors, alpha, dt, sim.t, inp.presnap, firstPerson ? qb.id : -1, inp.target);
    this.drawOfficials(sim, alpha, dt);
    this.drawFlags(sim);

    // Ball.
    const b = sim.ball;
    const bp = lerp2(b.prevPos, b.pos, alpha);
    const bh = b.prevH + (b.h - b.prevH) * alpha;
    const qbHolds = b.state === 'held' && b.holder === qb.id;
    this.heldBall.visible = firstPerson && qbHolds;
    this.ball.visible = !(firstPerson && qbHolds);
    this.ball.position.copy(toWorld(bp.x, bp.y, bh));
    if (b.state === 'air' && b.flight && !b.flight.lateral) {
      const f = b.flight;
      this.tmp.set(f.vel.x, f.vel.h - 10.7 * f.t, -f.vel.y).normalize();
      this.ball.lookAt(this.tmp2.copy(this.ball.position).add(this.tmp));
      this.ball.rotateZ(this.time * 25);
    } else if (b.state === 'held' && b.holder !== null) {
      this.ball.rotation.set(0, headingToRotY(sim.actors[b.holder].facing), 0);
    }

    // Every eligible receiver carries a marker ring; the selected one pulses.
    const showMarkers = !userDef && !sim.result && (sim.canThrow() || inp.presnap);
    for (const slot of ELIGIBLE) {
      const r = sim.get(slot);
      const rp = lerp2(r.prevPos, r.pos, alpha);
      this.field.setReceiverRing(slot, showMarkers && slot !== inp.target ? toWorld(rp.x, rp.y) : null, !!r.route?.blocks);
    }
    if (userDef && userDef.id !== this.labeledDef) {
      // Phase 3b: any defender can be selected; he carries his slot label while he is the user's.
      const prev = this.labeledDef >= 0 ? sim.actors[this.labeledDef] : null;
      if (prev) this.players[prev.id]?.setLabel(USER_DEF_LABELS[prev.slot] ?? null);
      this.players[userDef.id]?.setLabel(userDef.slot);
      this.labeledDef = userDef.id;
    }
    if (userDef && !userDef.down) {
      const dp = lerp2(userDef.prevPos, userDef.pos, alpha);
      this.field.setTargetRing(toWorld(dp.x, dp.y), this.time);
    } else if (inp.target && showMarkers) {
      const r = sim.get(inp.target);
      const rp = lerp2(r.prevPos, r.pos, alpha);
      this.field.setTargetRing(toWorld(rp.x, rp.y), this.time);
    } else {
      this.field.setTargetRing(null, this.time);
    }

    const focus = carrier ?? qb;
    this.followSun(focus.pos.x, focus.pos.y + 8);
    if (userDef && inp.defenseCamera === 'player') this.updateDefenseCamera(sim, userDef, alpha, dt);
    else if (userDef) this.updateFormationCamera(sim, userDef, alpha, dt);
    else this.updateCamera(sim, alpha, dt, inp, firstPerson);
  }

  /**
   * Defense: behind the selected cornerback (on the far side from the offense),
   * looking past him toward the ball. The axis is the field axis; it only
   * leans toward the ball, so switching cornerbacks or chasing never spins it.
   */
  private updateDefenseCamera(sim: PlaySim, d: Actor, alpha: number, dt: number) {
    const C = { ...CAMERA.defense, ...CAMERA.defenseUnits[unitOf(d.slot as DefSlot)] };
    const dp = lerp2(d.prevPos, d.pos, alpha);
    const b = sim.ball.pos;
    // Look point: ahead of him toward the offense, leaning a little toward the ball;
    // the camera sits behind him on that line so he stays in the middle of the screen.
    const look = { x: dp.x + (b.x - dp.x) * C.lookToBall, y: Math.min(dp.y, b.y) - C.lookAhead };
    const dx = look.x - dp.x;
    const dy = look.y - dp.y;
    const l = Math.hypot(dx, dy) || 1;
    const desiredPos = toWorld(dp.x - (dx / l) * C.back, dp.y - (dy / l) * C.back, C.height);
    const desiredLook = toWorld(look.x, look.y, C.lookHeight);
    if (!this.camInit) {
      this.camPos.copy(desiredPos);
      this.camLook.copy(desiredLook);
      this.camInit = true;
    }
    const k = Math.min(1, dt * C.follow);
    this.camPos.lerp(desiredPos, k);
    this.camLook.lerp(desiredLook, k);
    this.applyFov(true);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  /**
   * Phase 4 default defense camera: behind the whole defense, high enough to
   * see the formation, the line, the safeties and the receivers. Follows the
   * ball along the field axis; it never rotates.
   */
  private updateFormationCamera(sim: PlaySim, d: Actor, alpha: number, dt: number) {
    const C = CAMERA.formation;
    const carrier = sim.carrier;
    const bp = carrier ? lerp2(carrier.prevPos, carrier.pos, alpha) : lerp2(sim.ball.prevPos, sim.ball.pos, alpha);
    const dp = lerp2(d.prevPos, d.pos, alpha);
    let deepest = -Infinity;
    for (const a of sim.actors) if (a.side === 'def' && !a.down) deepest = Math.max(deepest, a.pos.y);
    const camY = Math.max(bp.y + C.behindBall, deepest + C.behindDeepest);
    const camX = bp.x * C.lateralShare + (dp.x - bp.x) * C.userShare;
    const desiredPos = toWorld(camX, camY, C.height);
    const desiredLook = toWorld(camX + (bp.x - camX) * 0.5, bp.y - C.lookAhead, C.lookHeight);
    if (!this.camInit) {
      this.camPos.copy(desiredPos);
      this.camLook.copy(desiredLook);
      this.camInit = true;
    }
    const k = Math.min(1, dt * C.follow);
    this.camPos.lerp(desiredPos, k);
    this.camLook.lerp(desiredLook, k);
    this.applyFov(true);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  /** Kick returns: chase cam behind the returner, looking at the ball while it is in the air. */
  private updateReturn(sim: ReturnSim, alpha: number, dt: number) {
    setFrameFlip(!sim.userReturns);
    this.heldBall.visible = false;
    this.field.hideReceiverRings();
    this.field.setTargetRing(null, this.time);
    this.drawActors(sim.actors, alpha, dt, sim.t, false, -1, null);
    this.drawOfficials(sim, alpha, dt);
    this.drawFlags(sim);
    const b = sim.ball;
    const bp = lerp2(b.prevPos, b.pos, alpha);
    const bh = b.prevH + (b.h - b.prevH) * alpha;
    this.ball.visible = true;
    this.ball.position.copy(toWorld(bp.x, bp.y, bh));
    if (b.state === 'air') {
      this.ball.rotation.set(this.time * 12, 0, 0);
    } else if (b.state === 'held' && b.holder !== null) {
      this.ball.rotation.set(0, headingToRotY(sim.actors[b.holder].facing), 0);
    }
    const r = sim.returner;
    const rp = lerp2(r.prevPos, r.pos, alpha);
    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;
    // Stay in front of the goalposts (they stand on the end line, y = -10).
    const camY = (y: number) => Math.max(y, -8.5);
    const cover = sim.coverMan;
    if (cover && cover.id !== this.labeledDef) {
      if (this.labeledDef >= 0) this.players[this.labeledDef]?.setLabel(null);
      this.players[cover.id]?.setLabel(cover.slot);
      this.labeledDef = cover.id;
    }
    if (cover) {
      // Phase 3b coverage: behind the user's cover man, looking at the ball / returner (same rig as defense).
      const C = CAMERA.defense;
      const cp = lerp2(cover.prevPos, cover.pos, alpha);
      if (!cover.down) this.field.setTargetRing(toWorld(cp.x, cp.y), this.time);
      const focus = b.state === 'held' ? rp : bp;
      const look = { x: cp.x + (focus.x - cp.x) * 0.5, y: Math.min(cp.y, focus.y + 6) - C.lookAhead * 0.5 };
      const dx = look.x - cp.x;
      const dy = look.y - cp.y;
      const l = Math.hypot(dx, dy) || 1;
      desiredPos = toWorld(cp.x - (dx / l) * C.back, cp.y - (dy / l) * C.back, C.height + 1);
      desiredLook = toWorld(look.x, look.y, b.state === 'air' ? Math.max(1, bh * 0.4) : C.lookHeight);
    } else if (b.state === 'air') {
      // Behind the returner, looking up at the ball coming down.
      desiredPos = toWorld(rp.x, camY(rp.y - 9), 5.2);
      desiredLook = toWorld(bp.x * 0.5 + rp.x * 0.5, (bp.y + rp.y) / 2, Math.max(2, bh * 0.6));
    } else {
      desiredPos = toWorld(rp.x - r.vel.x * 0.4, camY(rp.y - 8.5), 4.6);
      desiredLook = toWorld(rp.x + r.vel.x * 0.5, rp.y + 8, 1.0);
    }
    if (!this.camInit) {
      this.camPos.copy(desiredPos);
      this.camLook.copy(desiredLook);
      this.camInit = true;
    }
    const k = Math.min(1, dt * 4);
    this.camPos.lerp(desiredPos, k);
    this.camLook.lerp(desiredLook, k);
    this.applyFov(false);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.followSun(rp.x, rp.y + 6);
  }

  /**
   * Kick setup / field goal flight: ball on the tee or in the air, the kicker
   * (and holder) next to it, camera behind the kicker. `flight` in the kicking
   * team's frame (the user's frame when the user kicks).
   */
  updateKick(spot: { x: number; y: number }, flight: KickFlight | null, t: number, dt: number, kicker: TeamData, withHolder: boolean, flip: boolean) {
    setFrameFlip(flip);
    this.time += dt;
    this.field.setCrowd(this.time, this.crowdEnergy);
    for (const p of this.players) p.root.visible = false;
    for (const o of this.officials) o.root.visible = false;
    this.field.hideReceiverRings();
    this.field.setTargetRing(null, 0);
    this.field.setFlags([]);
    this.heldBall.visible = false;
    const k = this.players[0];
    k.setLook(kicker.colors, 3, PALETTE.skin[1]);
    k.setLabel(null);
    k.root.visible = true;
    const kickT = flight ? Math.min(t, 0.25) : 0;
    k.root.position.copy(toWorld(spot.x - 0.9, spot.y - 2.2 + kickT * 6));
    k.root.rotation.y = headingToRotY(0.35);
    k.animate(dt, flight && t < 0.3 ? 6 : 0, false, false);
    if (withHolder) {
      const hd = this.players[1];
      hd.setLook(kicker.colors, 12, PALETTE.skin[3]);
      hd.setLabel(null);
      hd.root.visible = true;
      hd.root.position.copy(toWorld(spot.x + 0.7, spot.y));
      hd.root.rotation.y = headingToRotY(-Math.PI / 2);
      hd.animate(dt, 0, false, true);
    }
    this.ball.visible = true;
    if (flight) {
      const p = flightPos(flight, Math.min(t, flight.hang));
      this.ball.position.copy(toWorld(p.x, p.y, Math.max(0.15, p.h)));
      this.ball.rotation.set(this.time * 14, 0, 0);
    } else {
      this.ball.position.copy(toWorld(spot.x, spot.y, 0.3));
      this.ball.rotation.set(Math.PI / 2, 0, 0);
    }
    const look = flight ? flightPos(flight, Math.min(t, flight.hang)) : { x: spot.x, y: spot.y + 30, h: 2 };
    const desiredPos = toWorld(spot.x, spot.y - 7, 3.2);
    const desiredLook = toWorld(look.x * 0.4 + spot.x * 0.6, look.y * 0.5 + (spot.y + 25) * 0.5, Math.max(1.5, look.h * 0.5));
    if (!this.camInit) {
      this.camPos.copy(desiredPos);
      this.camLook.copy(desiredLook);
      this.camInit = true;
    }
    this.camPos.lerp(desiredPos, Math.min(1, dt * 4));
    this.camLook.lerp(desiredLook, Math.min(1, dt * 4));
    this.applyFov(false);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.followSun(spot.x, spot.y + 10);
  }

  resetCamera() {
    this.camInit = false;
  }

  private updateCamera(sim: PlaySim, alpha: number, dt: number, inp: ViewInput, firstPerson: boolean) {
    const qb = sim.get('QB');
    const carrier = sim.carrier;
    const qp = lerp2(qb.prevPos, qb.pos, alpha);
    const cam = this.camera;
    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;

    if (firstPerson) {
      // Eyes of the QB: gaze controls yaw/pitch; while a pass is in the air
      // the head turns to follow the ball.
      let yaw = inp.gazeYaw;
      let pitch = inp.gazePitch;
      if (sim.ball.state === 'air' && sim.ball.flight && !sim.ball.flight.lateral) {
        const dx = sim.ball.pos.x - qp.x;
        const dy = sim.ball.pos.y - qp.y;
        yaw = Math.atan2(dx, dy);
        pitch = Math.atan2(sim.ball.h - EYE, Math.max(1, Math.hypot(dx, dy))) * 0.6 - 0.05;
      }
      const bob = Math.sin(this.time * 9) * Math.min(1, Math.hypot(qb.vel.x, qb.vel.y) / 6) * 0.04;
      // Going down in a sack or slide pulls the eyes toward the turf.
      const down = qb.anim && (qb.anim.down || qb.anim.kind === 'slide') ? Math.min(1, (sim.t - qb.anim.t) / qb.anim.duration) : 0;
      desiredPos = toWorld(qp.x - Math.sin(yaw) * EYE_BACK, qp.y - Math.cos(yaw) * EYE_BACK, EYE + bob - down * 1.4);
      desiredLook = desiredPos.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch) - down * 0.3, -Math.cos(yaw) * Math.cos(pitch)));
      if (!this.camInit) {
        this.camPos.copy(desiredPos);
        this.camLook.copy(desiredLook);
        this.camInit = true;
      }
      // Position snaps (no lag) in first person; look direction eases slightly.
      this.camPos.copy(desiredPos);
      this.camLook.lerp(desiredLook, Math.min(1, dt * 14));
    } else {
      // Before the snap the center holds the ball; the broadcast view frames the QB.
      const focus = carrier && carrier.slot !== 'C' ? carrier : inp.presnap || sim.ball.state !== 'air' || !sim.ball.flight ? qb : null;
      let fx: number;
      let fy: number;
      if (focus) {
        const fp = lerp2(focus.prevPos, focus.pos, alpha);
        fx = fp.x;
        fy = fp.y;
      } else {
        fx = sim.ball.pos.x;
        fy = sim.ball.pos.y;
      }
      // Broadcast view on a fixed field axis: never rotates with the QB, so a
      // scramble only moves it along (depth) and a little across (lateral).
      const c = focus === qb || !focus ? CAMERA.pocket : CAMERA.carrier;
      const pan = c === CAMERA.pocket && !sim.scrambling && sim.ball.state !== 'air' ? Math.sin(inp.gazeYaw) * CAMERA.pocket.gazePan : 0;
      const cx = sim.ballX + (fx - sim.ballX) * CAMERA.lateralShare;
      desiredPos = toWorld(cx, fy - c.back, c.height);
      desiredLook = toWorld(cx + pan, fy + c.lookAhead, c.lookHeight);
      if (!this.camInit) {
        this.camPos.copy(desiredPos);
        this.camLook.copy(desiredLook);
        this.camInit = true;
      }
      // Depth (world z) follows faster than the lateral position (world x).
      const kd = Math.min(1, dt * CAMERA.followDepth);
      const kl = Math.min(1, dt * CAMERA.followLateral);
      for (const v of [[this.camPos, desiredPos], [this.camLook, desiredLook]] as const) {
        v[0].x += (v[1].x - v[0].x) * kl;
        v[0].y += (v[1].y - v[0].y) * kd;
        v[0].z += (v[1].z - v[0].z) * kd;
      }
    }
    this.applyFov(!firstPerson);
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
  }

  render() {
    this.placeRim();
    this.renderer.render(this.scene, this.camera);
  }
}
