/**
 * Stadium bowl: stepped stands on all four sides (lower and upper tier with a
 * concourse), a roof canopy with light rigs, and a crowd of instanced
 * spectators in varied colors. The crowd bounces in a vertex shader, so the
 * whole stadium animates with one uniform update per frame: `setEnergy`
 * follows the crowd meter.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FIELD } from '../play/field';

/** Field frame -> world (never flipped: the stadium is static). */
const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

interface StandSpec {
  /** Center of the front edge (field frame) and the direction the stand faces (toward the field). */
  cx: number;
  cy: number;
  rotY: number;
  length: number;
  /** Opening in the podium wall for the players' tunnel (local x range). */
  gap?: [number, number];
}

/** Players' tunnel: under the west stand, opening onto the field at this yard line. */
export const TUNNEL = { y: 40, halfWidth: 3.5, height: 3.2 };

const ROW_DEPTH = 0.95;
const ROW_RISE = 0.5;
const LOWER_ROWS = 18;
const UPPER_ROWS = 14;
const CONCOURSE = 3.5;
const UPPER_LIFT = 4;
const SEAT = 0.9;
const PODIUM = 3.4;

export class Stadium {
  readonly group = new THREE.Group();
  private crowdMat: THREE.MeshLambertMaterial;
  private uniforms = { uTime: { value: 0 }, uEnergy: { value: 0.3 } };

  constructor(homeColors: string[], awayColors: string[]) {
    const side = FIELD.halfWidth + 9;
    const stands: StandSpec[] = [
      // Local x runs along the stand; for the west stand local x = field y - 50.
      { cx: -side, cy: 50, rotY: Math.PI / 2, length: 130, gap: [TUNNEL.y - 50 - TUNNEL.halfWidth, TUNNEL.y - 50 + TUNNEL.halfWidth] },
      { cx: side, cy: 50, rotY: -Math.PI / 2, length: 130 },
      { cx: 0, cy: 110 + 9, rotY: 0, length: 74 },
      { cx: 0, cy: -10 - 9, rotY: Math.PI, length: 74 },
    ];
    const concrete = new THREE.MeshLambertMaterial({ color: 0x8e9196 });
    const steps = this.stepTexture();
    const stepMat = new THREE.MeshLambertMaterial({ map: steps, color: 0xb5b8bc });
    const facade = new THREE.MeshLambertMaterial({ color: 0x3b4250 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0xd9dde2, side: THREE.DoubleSide });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x1f3a5f });

    this.crowdMat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.crowdMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uEnergy = this.uniforms.uEnergy;
      shader.vertexShader = 'uniform float uTime;\nuniform float uEnergy;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float seed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.71;
          float jump = max(0.0, sin(uTime * (5.0 + fract(seed) * 3.0) + seed * 6.2831));
          float stand = smoothstep(0.35, 0.75, uEnergy);
          transformed.y += jump * jump * 0.35 * uEnergy + stand * 0.12;
          transformed.x += sin(uTime * 1.3 + seed) * 0.03 * uEnergy;
        #endif`,
      );
    };

    const person = this.personGeometry();
    const palette = [...homeColors, ...homeColors, ...homeColors, ...awayColors,
      '#e8e8e8', '#2b2d42', '#6c757d', '#c9a227', '#7a4b2a', '#3a7d44', '#9d1c2a', '#1b4965', '#e07a5f', '#f2cc8f'];
    const rng = mulberry(17);
    const matrices: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();

    for (const s of stands) {
      const g = new THREE.Group();
      g.position.copy(W(s.cx, s.cy));
      g.rotation.y = s.rotY;
      this.group.add(g);
      // Podium wall (padded, in the home color); the seats start above the tunnel height.
      const segments: [number, number][] = s.gap ? [[-s.length / 2, s.gap[0]], [s.gap[1], s.length / 2]] : [[-s.length / 2, s.length / 2]];
      for (const [a, b] of segments) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(b - a, PODIUM, 0.4), wallMat);
        wall.position.set((a + b) / 2, PODIUM / 2, 0);
        wall.receiveShadow = true;
        g.add(wall);
      }
      const tiers: [number, number, number][] = [
        [0, LOWER_ROWS, PODIUM],
        [LOWER_ROWS * ROW_DEPTH + CONCOURSE, UPPER_ROWS, PODIUM + LOWER_ROWS * ROW_RISE + UPPER_LIFT],
      ];
      for (const [z0, rows, h0] of tiers) {
        const depth = rows * ROW_DEPTH;
        const rise = rows * ROW_RISE;
        // Stepped deck as one sloped, step-textured slab plus a solid underside.
        const deck = new THREE.Mesh(new THREE.PlaneGeometry(s.length, Math.hypot(depth, rise)), stepMat);
        deck.rotation.x = -Math.PI / 2 + Math.atan2(rise, depth);
        deck.position.set(0, h0 + rise / 2, -(z0 + depth / 2) - 0.5);
        g.add(deck);
        (deck.material as THREE.MeshLambertMaterial).map!.repeat.set(s.length / 6, rows);
        const under = new THREE.Mesh(new THREE.BoxGeometry(s.length, 1, depth), concrete);
        under.position.set(0, h0 - 0.5, -(z0 + depth / 2) - 0.5);
        g.add(under);
        // Spectators on each row.
        for (let r = 0; r < rows; r++) {
          const z = -(z0 + r * ROW_DEPTH + ROW_DEPTH * 0.6) - 0.5;
          const y = h0 + r * ROW_RISE + 0.02;
          for (let x = -s.length / 2 + 1; x < s.length / 2 - 1; x += SEAT) {
            if (rng() < 0.07) continue; // empty seat
            const local = new THREE.Vector3(x + (rng() - 0.5) * 0.15, y, z);
            const world = local.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY).add(g.position);
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY + Math.PI + (rng() - 0.5) * 0.4);
            const sc = 0.9 + rng() * 0.2;
            m.compose(world, q, new THREE.Vector3(sc, sc, sc));
            matrices.push(m.clone());
            colors.push(new THREE.Color(palette[Math.floor(rng() * palette.length)]));
          }
        }
      }
      // Back facade and roof canopy over the upper tier.
      const backZ = -(LOWER_ROWS * ROW_DEPTH + CONCOURSE + UPPER_ROWS * ROW_DEPTH) - 1;
      const topH = PODIUM + LOWER_ROWS * ROW_RISE + UPPER_LIFT + UPPER_ROWS * ROW_RISE;
      const back = new THREE.Mesh(new THREE.BoxGeometry(s.length, topH + 6, 1), facade);
      back.position.set(0, (topH + 6) / 2, backZ - 0.5);
      g.add(back);
      const roofDepth = UPPER_ROWS * ROW_DEPTH + 6;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(s.length + 2, 0.4, roofDepth), roofMat);
      roof.position.set(0, topH + 6, backZ + roofDepth / 2 - 1);
      roof.rotation.x = -0.06;
      g.add(roof);
      // Light rig along the roof edge.
      for (let x = -s.length / 2 + 6; x <= s.length / 2 - 6; x += 12) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(5, 1.2, 0.4), lampMat);
        lamp.position.set(x, topH + 5.2, backZ + roofDepth - 1.4);
        lamp.rotation.x = 0.5;
        g.add(lamp);
      }
      // Concourse band.
      const band = new THREE.Mesh(new THREE.BoxGeometry(s.length, 1.6, CONCOURSE), facade);
      band.position.set(0, PODIUM + LOWER_ROWS * ROW_RISE + 0.8, -(LOWER_ROWS * ROW_DEPTH + CONCOURSE / 2) - 0.5);
      g.add(band);
    }

    const crowd = new THREE.InstancedMesh(person, this.crowdMat, matrices.length);
    matrices.forEach((mx, i) => {
      crowd.setMatrixAt(i, mx);
      crowd.setColorAt(i, colors[i]);
    });
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    crowd.frustumCulled = false;
    this.group.add(crowd);

    // Corner fill so the bowl reads as closed.
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const corner = new THREE.Mesh(new THREE.CylinderGeometry(14, 18, 30, 8, 1, true, 0, Math.PI / 2), facade);
      corner.position.copy(W(x * (side + 4), y < 0 ? -14 : 114, 15));
      corner.rotation.y = Math.atan2(x, y) + Math.PI * 0.75;
      this.group.add(corner);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
  }

  /** 0..1 crowd energy (from the crowd meter) and time for the bounce. */
  update(time: number, energy: number) {
    this.uniforms.uTime.value = time;
    this.uniforms.uEnergy.value += (energy - this.uniforms.uEnergy.value) * 0.05;
  }

  /** A spectator: two boxes (body, head), 48 vertices. */
  private personGeometry(): THREE.BufferGeometry {
    const body = new THREE.BoxGeometry(0.46, 0.62, 0.3).translate(0, 0.31, 0);
    const head = new THREE.BoxGeometry(0.2, 0.22, 0.2).translate(0, 0.76, 0);
    return mergeGeometries([body, head])!;
  }

  private stepTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#9da1a6';
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#6c7076';
    g.fillRect(0, 22, 64, 10);
    g.fillStyle = '#2f3540';
    for (let x = 2; x < 64; x += 9) g.fillRect(x, 4, 7, 14); // seat backs
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
}

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
