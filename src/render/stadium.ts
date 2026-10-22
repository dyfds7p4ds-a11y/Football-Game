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

/** Players' tunnel: under the west stand, opening onto the field at this yard line; `depth` yards long. */
export const TUNNEL = { y: 40, halfWidth: 3.5, height: 3.2, depth: 17 };

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
    const endFront = FIELD.length + FIELD.endzone + 9;
    // Side and end stands meet at the four corner pivots (±side, endFront / -endFront + 100);
    // curved corner sections fill the quadrant behind each pivot.
    const sideLen = 2 * (endFront - 50);
    const stands: StandSpec[] = [
      // Local x runs along the stand; for the west stand local x = field y - 50.
      { cx: -side, cy: 50, rotY: Math.PI / 2, length: sideLen, gap: [TUNNEL.y - 50 - TUNNEL.halfWidth, TUNNEL.y - 50 + TUNNEL.halfWidth] },
      { cx: side, cy: 50, rotY: -Math.PI / 2, length: sideLen },
      { cx: 0, cy: endFront, rotY: 0, length: 2 * side },
      { cx: 0, cy: 100 - endFront, rotY: Math.PI, length: 2 * side },
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
        // Thin underside so the players' tunnel (TUNNEL.height < PODIUM) fits beneath it.
        const under = new THREE.Mesh(new THREE.BoxGeometry(s.length, 0.2, depth), concrete);
        under.position.set(0, h0 - 0.1, -(z0 + depth / 2) - 0.5);
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
      if (s.gap) g.add(this.tunnel(s.gap, wallMat, concrete, lampMat));
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

    // Corner stands so the bowl reads as closed.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        this.corner(sx * side, sy > 0 ? endFront : 100 - endFront, sx, sy, { stepMat: steps, concrete, facade, roofMat, wallMat }, palette, rng, matrices, colors);
      }
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
  }

  /**
   * Players' tunnel built into a stand (local frame of that stand): an
   * open-mouthed concrete passage from the gap in the podium wall back under
   * the lower tier, lit along the ceiling, with a padded portal frame and a
   * glowing locker-room door at the far end. Nothing closes the field end.
   */
  private tunnel(gap: [number, number], wallMat: THREE.Material, concrete: THREE.Material, lampMat: THREE.Material): THREE.Group {
    const t = new THREE.Group();
    const w = gap[1] - gap[0];
    const cx = (gap[0] + gap[1]) / 2;
    const d = TUNNEL.depth;
    // Emissive so the passage reads as lit from within, not as a dark hole.
    const inner = new THREE.MeshLambertMaterial({ color: 0x6b707a, emissive: 0x2c3036, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshLambertMaterial({ color: 0x3d4a3a, emissive: 0x151a15 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.02, -d / 2);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), inner);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, TUNNEL.height, -d / 2);
    t.add(floor, ceil);
    for (const x of gap) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(d, TUNNEL.height), inner);
      wall.rotation.y = Math.PI / 2;
      wall.position.set(x, TUNNEL.height / 2, -d / 2);
      t.add(wall);
    }
    // Far end: wall with a lit doorway.
    const end = new THREE.Mesh(new THREE.PlaneGeometry(w, TUNNEL.height), concrete);
    end.position.set(cx, TUNNEL.height / 2, -d);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.5, TUNNEL.height * 0.8), lampMat);
    door.position.set(cx, TUNNEL.height * 0.4, -d + 0.05);
    t.add(end, door);
    for (let z = -2; z > -d + 1; z -= 3) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 1.6), lampMat);
      lamp.position.set(cx, TUNNEL.height - 0.05, z);
      t.add(lamp);
    }
    // Portal: padded posts and a header in the wall color, flush with the podium wall.
    for (const x of gap) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, PODIUM, 0.7), wallMat);
      post.position.set(x + (x < cx ? -0.25 : 0.25), PODIUM / 2, 0);
      t.add(post);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(w + 1, PODIUM - TUNNEL.height, 0.7), wallMat);
    header.position.set(cx, (PODIUM + TUNNEL.height) / 2, 0);
    t.add(header);
    return t;
  }

  /**
   * Curved corner stand between a side stand and an end stand. `px, py` is the
   * pivot where both front edges meet; rows fan out over the quadrant behind
   * it (outward x direction sx, outward y direction sy), matching the tiers,
   * concourse, back facade and roof of the straight stands.
   */
  private corner(px: number, py: number, sx: number, sy: number,
    mats: { stepMat: THREE.Texture; concrete: THREE.Material; facade: THREE.Material; roofMat: THREE.Material; wallMat: THREE.Material },
    palette: string[], rng: () => number, matrices: THREE.Matrix4[], colors: THREE.Color[]) {
    const SEG = 14;
    const dir = (u: number) => ({ x: Math.cos(u * Math.PI / 2) * sx, y: Math.sin(u * Math.PI / 2) * sy });
    const at = (u: number, r: number, h: number) => {
      const d = dir(u);
      return W(px + d.x * r, py + d.y * r, h);
    };
    /** A ring-sector strip from (r0, h0) to (r1, h1); vertical when r0 == r1. */
    const strip = (r0: number, h0: number, r1: number, h1: number, mat: THREE.Material, vRepeat = 1) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const arc = ((r0 + r1) / 2) * Math.PI / 2;
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const a = at(u, r0, h0);
        const b = at(u, r1, h1);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        uv.push((u * arc) / 6, 0, (u * arc) / 6, vRepeat);
        if (i < SEG) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      return mesh;
    };
    const steps = mats.stepMat.clone();
    steps.repeat.set(1, 1);
    steps.needsUpdate = true;
    const stepMat = new THREE.MeshLambertMaterial({ map: steps, color: 0xb5b8bc, side: THREE.DoubleSide });
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const tiers: [number, number, number][] = [
      [0, LOWER_ROWS, PODIUM],
      [LOWER_ROWS * ROW_DEPTH + CONCOURSE, UPPER_ROWS, PODIUM + LOWER_ROWS * ROW_RISE + UPPER_LIFT],
    ];
    for (const [z0, rows, h0] of tiers) {
      const depth = rows * ROW_DEPTH;
      strip(z0 + 0.5, h0, z0 + depth + 0.5, h0 + rows * ROW_RISE, stepMat, rows);
      strip(z0 + 0.5, 0, z0 + 0.5, h0, mats.facade).material = new THREE.MeshLambertMaterial({ color: 0x3b4250, side: THREE.DoubleSide });
      for (let r = 0; r < rows; r++) {
        const rad = z0 + r * ROW_DEPTH + ROW_DEPTH * 0.6 + 0.5;
        const h = h0 + r * ROW_RISE + 0.02;
        const n = Math.floor((rad * Math.PI / 2) / SEAT);
        for (let k = 0; k < n; k++) {
          if (rng() < 0.07) continue;
          const u = (k + 0.5 + (rng() - 0.5) * 0.15) / n;
          const d = dir(u);
          const pos = at(u, rad, h);
          // Face the pivot (the field corner): front of the figure is local -z.
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(d.x, -d.y) + (rng() - 0.5) * 0.4);
          const sc = 0.9 + rng() * 0.2;
          m.compose(pos, q, new THREE.Vector3(sc, sc, sc));
          matrices.push(m.clone());
          colors.push(new THREE.Color(palette[Math.floor(rng() * palette.length)]));
        }
      }
    }
    const backR = LOWER_ROWS * ROW_DEPTH + CONCOURSE + UPPER_ROWS * ROW_DEPTH + 1.5;
    const topH = PODIUM + LOWER_ROWS * ROW_RISE + UPPER_LIFT + UPPER_ROWS * ROW_RISE;
    const dark = new THREE.MeshLambertMaterial({ color: 0x3b4250, side: THREE.DoubleSide });
    strip(backR, 0, backR, topH + 6, dark);
    const roofDepth = UPPER_ROWS * ROW_DEPTH + 6;
    strip(backR - roofDepth + 1, topH + 6.6, backR + 0.5, topH + 6, mats.roofMat);
    // Concourse floor between the tiers.
    strip(LOWER_ROWS * ROW_DEPTH + 0.5, PODIUM + LOWER_ROWS * ROW_RISE + 0.05, LOWER_ROWS * ROW_DEPTH + CONCOURSE + 0.5, PODIUM + LOWER_ROWS * ROW_RISE + 0.05, dark);
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
