/**
 * Intro cutscenes, played on the real stadium with the real player meshes:
 *  1. Player tunnel: the home team runs out of the tunnel onto the field.
 *  2. Team introduction: both teams lined up, the camera dollies past them.
 *  3. Coin toss and kickoff setup: captains and the referee at midfield, the
 *     coin flips, then the camera rises over the kickoff formation.
 * Each scene runs 6-8 s. The director only moves meshes and the camera; it
 * never touches game state, so skipping is always safe.
 */
import * as THREE from 'three';
import { FIELD } from '../play/field';
import type { PlayerData, TeamData } from '../data/types';
import { OFF_SLOTS, DEF_SLOTS } from '../data/types';
import { playerFor } from '../data';
import type { SceneView } from './view';
import { PALETTE } from './palette';
import { setFrameFlip } from './coords';
import { TUNNEL } from './stadium';

export interface CutsceneCaption {
  title: string;
  sub: string;
}

const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
const TUNNEL_Y = TUNNEL.y;
const TUNNEL_X0 = -FIELD.halfWidth - 26;
const TUNNEL_X1 = -FIELD.halfWidth - 9;

export class Cutscene {
  readonly durations = [7.5, 7, 7];
  private t = 0;
  private scene = 0;
  private props = new THREE.Group();
  private coin: THREE.Mesh;
  private starters: { home: PlayerData[]; away: PlayerData[] };

  constructor(private view: SceneView, private home: TeamData, private away: TeamData, private homeReceives: boolean) {
    this.starters = {
      home: OFF_SLOTS.map((s) => playerFor(home, s)),
      away: DEF_SLOTS.map((s) => playerFor(away, s)),
    };
    // Tunnel: a lit concrete tube through the side stand.
    const len = TUNNEL_X1 - TUNNEL_X0;
    const tunnel = new THREE.Mesh(
      new THREE.BoxGeometry(len, TUNNEL.height, TUNNEL.halfWidth * 2),
      new THREE.MeshLambertMaterial({ color: 0x4a505a, side: THREE.BackSide }),
    );
    tunnel.position.copy(W((TUNNEL_X0 + TUNNEL_X1) / 2 - 0.3, TUNNEL_Y, TUNNEL.height / 2));
    this.props.add(tunnel);
    for (let x = TUNNEL_X0 + 2; x < TUNNEL_X1; x += 3) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.5), new THREE.MeshBasicMaterial({ color: 0xfff3c4 }));
      lamp.position.copy(W(x, TUNNEL_Y, TUNNEL.height - 0.05));
      this.props.add(lamp);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, TUNNEL.halfWidth * 2 + 0.4), new THREE.MeshLambertMaterial({ color: new THREE.Color(home.colors.primary) }));
    banner.position.copy(W(TUNNEL_X1 + 0.3, TUNNEL_Y, TUNNEL.height - 0.3));
    this.props.add(banner);
    this.coin = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 24), new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.3 }));
    this.props.add(this.coin);
    view.scene.add(this.props);
    setFrameFlip(false);
    view.ball.visible = false;
    for (const p of view.players) p.setLabel(null);
    this.setupScene(0);
  }

  get sceneIndex(): number {
    return this.scene;
  }

  caption(): CutsceneCaption {
    const h = `${this.home.city} ${this.home.name}`;
    const a = `${this.away.city} ${this.away.name}`;
    if (this.scene === 0) return { title: `${h.toUpperCase()}`, sub: 'take the field' };
    if (this.scene === 1) {
      const qb = this.starters.home[0];
      const wr = playerFor(this.home, 'WR1');
      const dl = playerFor(this.away, 'DE1');
      return this.t < this.durations[1] / 2
        ? { title: h.toUpperCase(), sub: `QB #${qb.number} ${qb.name} · WR #${wr.number} ${wr.name}` }
        : { title: `VS ${a.toUpperCase()}`, sub: `DE #${dl.number} ${dl.name} leads the defense` };
    }
    const recv = this.homeReceives ? h : a;
    return this.t < 3.5
      ? { title: 'COIN TOSS', sub: `${this.away.name} call it in the air...` }
      : { title: `${recv.toUpperCase()} WILL RECEIVE`, sub: 'Kickoff' };
  }

  /** Advance; returns false when all scenes are done. */
  update(dt: number): boolean {
    this.t += dt;
    if (this.t >= this.durations[this.scene]) {
      this.scene++;
      this.t = 0;
      if (this.scene >= this.durations.length) return false;
      this.setupScene(this.scene);
    }
    this.view.field.setCrowd(performance.now() / 1000, 0.55 + 0.35 * Math.sin(this.t * 0.7) ** 2);
    if (this.scene === 0) this.tunnel(dt);
    else if (this.scene === 1) this.intro(dt);
    else this.coinToss(dt);
    return true;
  }

  dispose() {
    this.view.scene.remove(this.props);
    this.props.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.view.resetCamera();
  }

  private setupScene(i: number) {
    const v = this.view;
    for (const p of v.players) p.root.visible = false;
    for (const o of v.officials) o.root.visible = false;
    this.coin.visible = i === 2;
    const look = (pm: (typeof v.players)[number], team: TeamData, p: PlayerData, k: number) => {
      pm.setLook(team.colors, p.number, PALETTE.skin[(p.number * 7 + k) % PALETTE.skin.length]);
      pm.root.visible = true;
    };
    if (i === 0) {
      this.starters.home.forEach((p, k) => look(v.players[k], this.home, p, k));
    } else if (i === 1) {
      this.starters.home.forEach((p, k) => look(v.players[k], this.home, p, k));
      this.starters.away.forEach((p, k) => look(v.players[11 + k], this.away, p, k));
    } else {
      // Captains and the referee at midfield; then both teams for the kickoff.
      this.starters.home.forEach((p, k) => look(v.players[k], this.home, p, k));
      this.starters.away.forEach((p, k) => look(v.players[11 + k], this.away, p, k));
      v.officials[0].root.visible = true;
    }
  }

  private place(i: number, x: number, y: number, heading: number, speed: number, dt: number, stance = false) {
    const pm = this.view.players[i];
    pm.root.position.copy(W(x, y));
    pm.root.rotation.y = -heading;
    pm.animate(dt, speed, false, stance);
  }

  private camera(pos: THREE.Vector3, look: THREE.Vector3) {
    const c = this.view.camera;
    c.position.copy(pos);
    c.lookAt(look);
  }

  private tunnel(dt: number) {
    const t = this.t;
    // Players jog out in pairs, accelerating once they see the field.
    for (let k = 0; k < 11; k++) {
      const start = TUNNEL_X0 + 2 - k * 1.6;
      const x = start + Math.max(0, t - 0.4) * (5.5 + Math.min(3, t * 0.6));
      const lane = (k % 2 === 0 ? -1 : 1) * 1.2 + Math.sin(k) * 0.3;
      this.place(k, x, TUNNEL_Y + lane, Math.PI / 2, 7, dt);
    }
    const lead = TUNNEL_X0 + 2 + Math.max(0, t - 0.4) * 6.5;
    const k = Math.min(1, t / this.durations[0]);
    // Inside the tunnel behind the players, then out and up to reveal the bowl.
    const camX = Math.min(lead - 9, TUNNEL_X1 + 6);
    // Stay under the tunnel roof until the camera is out on the field, then rise.
    const out = Math.max(0, camX - TUNNEL_X1);
    const camH = 1.7 + Math.min(10, out * 1.6);
    this.camera(W(camX, TUNNEL_Y - 1.2, camH), W(lead + 10, TUNNEL_Y + 2 * k, 1.6 + k * 3));
  }

  private intro(dt: number) {
    const t = this.t;
    const half = this.durations[1] / 2;
    // Home team on its 40 facing the camera rail, visitors on the other 40.
    for (let k = 0; k < 11; k++) {
      this.place(k, -15 + k * 3, 42, Math.PI, 0, dt);
      this.place(11 + k, -15 + k * 3, 58, 0, 0, dt);
    }
    const home = t < half;
    const k = home ? t / half : (t - half) / half;
    const y = home ? 37 : 63;
    const camX = -18 + k * 36;
    this.camera(W(camX, y, 1.9), W(camX + 4, home ? 42 : 58, 1.6));
  }

  private coinToss(dt: number) {
    const t = this.t;
    const v = this.view;
    if (t < 3.5) {
      // Two captains each, the referee in the middle.
      for (let k = 0; k < 11; k++) {
        const cap = k < 2;
        this.place(k, cap ? -2.2 - k * 1.1 : -40, cap ? 50 : 0, Math.PI / 2, 0, dt);
        this.place(11 + k, cap ? 2.2 + k * 1.1 : 40, cap ? 50 : 0, -Math.PI / 2, 0, dt);
        if (!cap) {
          v.players[k].root.visible = false;
          v.players[11 + k].root.visible = false;
        }
      }
      const ref = v.officials[0];
      ref.root.visible = true;
      ref.root.position.copy(W(0, 51.2));
      ref.root.rotation.y = Math.PI;
      ref.animate(dt, 0, false, false);
      // Coin: up, spinning, and down onto the turf.
      const ct = Math.min(1, Math.max(0, (t - 0.6) / 1.8));
      const hgt = 1.4 + Math.sin(ct * Math.PI) * 4.5;
      this.coin.position.copy(W(0, 50.6, ct >= 1 ? 0.03 : hgt));
      this.coin.rotation.set(ct >= 1 ? 0 : t * 22, 0, 0);
      const r = 6 - Math.min(2, t);
      this.camera(W(Math.sin(t * 0.25) * r, 50 - r, 1.7 + Math.min(1, t) * 0.4), W(0, 50.5, ct > 0 && ct < 1 ? hgt * 0.6 : 1.4));
    } else {
      // Kickoff formation: the kicking team on its 35, the return team spread out.
      this.coin.visible = false;
      v.officials[0].root.visible = false;
      const kickY = this.homeReceives ? 65 : 35;
      const dir = this.homeReceives ? -1 : 1;
      for (let k = 0; k < 11; k++) {
        const x = -22 + k * 4.4;
        const kick = this.homeReceives ? 11 + k : k;
        const recv = this.homeReceives ? k : 11 + k;
        v.players[kick].root.visible = true;
        v.players[recv].root.visible = true;
        this.place(kick, x, kickY - dir * 1, dir > 0 ? 0 : Math.PI, 0, dt, true);
        const deep = k === 5;
        this.place(recv, deep ? 0 : x * 0.8, deep ? kickY + dir * 62 : kickY + dir * (k < 5 ? 10 : 25), dir > 0 ? Math.PI : 0, 0, dt);
      }
      const k2 = Math.min(1, (t - 3.5) / 3.5);
      this.camera(W(-28 + k2 * 8, kickY - dir * (14 - k2 * 4), 6 + k2 * 16), W(0, kickY + dir * 25, 0));
    }
  }
}
