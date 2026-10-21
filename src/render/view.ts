/**
 * SceneView: owns the Three.js renderer/scene and mirrors a PlaySim each
 * frame. Read-only with respect to game state.
 */
import * as THREE from 'three';
import type { TeamData, EligibleSlot } from '../data/types';
import { ELIGIBLE } from '../data/types';
import { lerp as lerp2 } from '../core/vec';
import type { PlaySim } from '../play/sim';
import { FieldView } from './fieldMesh';
import { PlayerMesh } from './playerMesh';
import { PALETTE } from './palette';
import { headingToRotY, toWorld } from './coords';

export type CameraMode = 'firstPerson' | 'behindQB';

export interface ViewInput {
  gazeYaw: number;
  gazePitch: number;
  target: EligibleSlot | null;
  cameraMode: CameraMode;
  /** Before the snap: players in stance. */
  presnap: boolean;
}

const LABELS: Record<EligibleSlot, string> = { WR1: '1', WR2: '2', WR3: '3', RB: 'RB', TE: 'TE' };
const EYE = 2.15;
/** Eyes sit slightly behind the sim position so linemen don't fill the screen. */
const EYE_BACK = 0.45;

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly field: FieldView;
  private players: PlayerMesh[] = [];
  private ball: THREE.Mesh;
  private heldBall: THREE.Mesh;
  private pixelScale = 1;
  private time = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  private routeGroup = new THREE.Group();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE.sky);
    this.scene.background = new THREE.Color(PALETTE.sky);
    this.scene.fog = new THREE.Fog(PALETTE.horizon, 90, 260);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xdff3ff, 0x3c5a2a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(-40, 80, 20);
    this.scene.add(sun);

    this.field = new FieldView(this.renderer);
    this.scene.add(this.field.group);

    const ballGeo = new THREE.SphereGeometry(0.15, 10, 6);
    ballGeo.scale(1, 1, 1.75);
    const ballMat = new THREE.MeshLambertMaterial({ color: PALETTE.ball, flatShading: true });
    this.ball = new THREE.Mesh(ballGeo, ballMat);
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
    this.resize();
  }

  setPixelScale(scale: number) {
    this.pixelScale = scale;
    this.canvas.style.imageRendering = scale < 1 ? 'pixelated' : 'auto';
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr * this.pixelScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep a sensible horizontal FOV in portrait.
    this.camera.fov = w / h < 1 ? 85 : 70;
    this.camera.updateProjectionMatrix();
  }

  setTeams(offense: TeamData, defense: TeamData) {
    this.field.paint(offense, defense);
  }

  /** Assign team looks and receiver labels for a new play. */
  bindPlay(sim: PlaySim, offense: TeamData, defense: TeamData) {
    sim.actors.forEach((a, i) => {
      const pm = this.players[i];
      const team = a.side === 'off' ? offense : defense;
      pm.setLook(team.colors, a.player.number, PALETTE.skin[(a.player.number * 7 + a.id) % PALETTE.skin.length]);
      const isElig = a.side === 'off' && (ELIGIBLE as readonly string[]).includes(a.slot);
      pm.setLabel(isElig ? LABELS[a.slot as EligibleSlot] : null);
      pm.root.visible = true;
    });
    this.camInit = false;
  }

  /** Pre-snap route hints painted on the turf (null clears them). */
  showRoutes(sim: PlaySim | null) {
    for (const c of this.routeGroup.children) (c as THREE.Mesh).geometry.dispose();
    this.routeGroup.clear();
    if (!sim) return;
    const colors: Record<EligibleSlot, number> = { WR1: 0xffd23f, WR2: 0x4ea8ff, WR3: 0xff8c42, RB: 0xf1faee, TE: 0xc77dff };
    for (const slot of ELIGIBLE) {
      const a = sim.get(slot);
      let pts = a.route && !a.route.blocks ? [a.pos, ...a.route.points] : [];
      if (slot === 'RB' && sim.play.run) {
        const aim = sim.ballX + sim.play.run.aim;
        pts = sim.play.run.style === 'toss'
          ? [a.pos, { x: sim.ballX + sim.play.run.aim * 0.55, y: sim.los - 4.5 }, { x: aim, y: sim.los - 1.5 }, { x: aim, y: sim.los + 8 }]
          : [a.pos, { x: sim.get('QB').pos.x, y: sim.get('QB').pos.y }, { x: aim, y: sim.los + 0.5 }, { x: aim, y: sim.los + 8 }];
      }
      const mat = new THREE.MeshBasicMaterial({ color: colors[slot], transparent: true, opacity: 0.75, depthWrite: false });
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
    this.time += dt;
    for (const p of this.players) p.root.visible = false;
    this.ball.visible = true;
    this.heldBall.visible = false;
    this.ball.position.copy(toWorld(ballX, ballY, 0.15));
    this.ball.rotation.set(0, 0, Math.PI / 2);
    this.field.setTargetRing(null, 0);
    this.camera.position.copy(toWorld(ballX + Math.sin(this.time * 0.1) * 6, ballY - 14, 6));
    this.camera.lookAt(toWorld(ballX, ballY + 10, 0));
    this.camInit = false;
  }

  update(sim: PlaySim, alpha: number, dt: number, inp: ViewInput) {
    this.time += dt;
    const qb = sim.get('QB');
    const carrier = sim.carrier;
    // First person while the play is "through the QB's eyes"; chase cam once someone else has the ball.
    const firstPerson = inp.cameraMode === 'firstPerson' && !(carrier && carrier !== qb);

    sim.actors.forEach((a, i) => {
      const pm = this.players[i];
      const p = lerp2(a.prevPos, a.pos, alpha);
      pm.root.position.copy(toWorld(p.x, p.y));
      pm.root.rotation.y = headingToRotY(a.facing);
      const speed = Math.hypot(a.vel.x, a.vel.y);
      pm.animate(dt, speed, a.down, inp.presnap && a.position !== 'QB' && a.position !== 'WR' && a.position !== 'CB' && a.position !== 'S');
      pm.updateLabel(pm.root.position.distanceTo(this.camera.position), a.side === 'off' && a.slot === inp.target);
      pm.root.visible = !(firstPerson && a.id === qb.id);
    });

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

    // Target ring under the selected receiver.
    if (inp.target && !sim.result && (sim.canThrow() || inp.presnap)) {
      const r = sim.get(inp.target);
      this.field.setTargetRing(toWorld(r.pos.x, r.pos.y), this.time);
    } else {
      this.field.setTargetRing(null, this.time);
    }

    this.updateCamera(sim, alpha, dt, inp, firstPerson);
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
      desiredPos = toWorld(qp.x - Math.sin(yaw) * EYE_BACK, qp.y - Math.cos(yaw) * EYE_BACK, EYE + bob);
      desiredLook = desiredPos.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)));
      if (!this.camInit) {
        this.camPos.copy(desiredPos);
        this.camLook.copy(desiredLook);
        this.camInit = true;
      }
      // Position snaps (no lag) in first person; look direction eases slightly.
      this.camPos.copy(desiredPos);
      this.camLook.lerp(desiredLook, Math.min(1, dt * 14));
    } else {
      const focus = carrier ?? (sim.ball.state === 'air' ? null : qb);
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
      const behindQB = !carrier || carrier.id === qb.id;
      const back = behindQB ? 6 : 8;
      const height = behindQB ? 3.6 : 4.2;
      const yawOffset = behindQB ? inp.gazeYaw * 0.5 : 0;
      desiredPos = toWorld(fx - Math.sin(yawOffset) * back, fy - Math.cos(yawOffset) * back, height);
      desiredLook = toWorld(fx + Math.sin(yawOffset) * 8, fy + Math.cos(yawOffset) * 8, 1.0);
      if (!this.camInit) {
        this.camPos.copy(desiredPos);
        this.camLook.copy(desiredLook);
        this.camInit = true;
      }
      const k = Math.min(1, dt * 5);
      this.camPos.lerp(desiredPos, k);
      this.camLook.lerp(desiredLook, k);
    }
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
