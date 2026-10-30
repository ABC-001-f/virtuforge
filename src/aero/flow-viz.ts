/**
 * Flow visuals inside the tunnel: a field plane on the back wall (speed or
 * pressure coefficient) and smoke streaks advected through the solver's
 * velocity field. Everything is drawn in the tunnel-local frame, so the
 * caller adds `object` as a child of the tunnel node.
 *
 * All buffers are allocated in the constructor; update() and tick() only
 * write into them (the solver frame's arrays are kept by reference).
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  Group,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from '@iwsdk/core';
import { divergingColor, speedColor } from './colormap.js';
import type { FlowFrame } from './solver-client.js';
import {
  CELL,
  GRID_NX,
  GRID_NY,
  TUNNEL_DEPTH,
  TUNNEL_HEIGHT,
  TUNNEL_LENGTH,
  VISUAL_FLOW_SPEED,
} from './tunnel.js';
import type { ViewMode } from './types.js';

const PARTICLES = 700;
const PRESSURE_PARTICLES = Math.round(PARTICLES * 0.4);
const MAX_AGE = 7;                 // seconds before a streak respawns at the inlet
const TAIL_SECONDS = 0.06;         // streak length = local velocity * this
const SPAWN_X = 0.005;
const SPAWN_MARGIN = 0.01;
const SPREAD_Z = 0.42 * TUNNEL_DEPTH;
const MAX_VISUAL_SPEED = VISUAL_FLOW_SPEED * 2.5;
const SPEED_NORM = 1.6;            // speed colour saturates at 1.6 * inlet speed
const CP_RANGE = 1.0;              // |Cp| mapped to the ends of the diverging map
const TAIL_FADE = 0.12;            // tail colour relative to the head
const DIM_FLOWING = 1;
const DIM_FROZEN = 0.35;
const SOLID_RGB = [18, 20, 26];

const FIELD_OPACITY: Record<ViewMode, number> = { smoke: 0.25, speed: 0.9, pressure: 0.9 };
const N_CELLS = GRID_NX * GRID_NY;

export class FlowViz {
  readonly object: Group;
  readonly speedTexture: DataTexture;
  readonly pressureTexture: DataTexture;
  /**
   * Pressure for the model's surface: like pressureTexture, but every solid cell
   * carries the colour of the nearest air cell, so a skin sampling the body's own
   * cells shows the pressure of the air touching it instead of the dark interior.
   */
  readonly skinTexture: DataTexture;

  private readonly speedData: Uint8Array;
  private readonly pressureData: Uint8Array;
  private readonly skinData: Uint8Array;
  /** For each cell, the index of the nearest fluid cell (itself if fluid); rebuilt when the mask changes. */
  private readonly nearestFluid = new Int32Array(N_CELLS);
  private readonly bfsQueue = new Int32Array(N_CELLS);
  private maskHash = 0;
  private maskSolidCount = -1;
  private readonly fieldMaterial: MeshBasicMaterial;
  private readonly fieldGeometry: PlaneGeometry;
  private readonly streakGeometry: BufferGeometry;
  private readonly streakMaterial: LineBasicMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly positionAttr: BufferAttribute;
  private readonly colorAttr: BufferAttribute;
  /** Linear-space RGB lookup of speedColor, 256 entries, for vertex colours. */
  private readonly speedLut: Float32Array;

  private readonly px = new Float32Array(PARTICLES);
  private readonly py = new Float32Array(PARTICLES);
  private readonly pz = new Float32Array(PARTICLES);
  private readonly age = new Float32Array(PARTICLES);

  // Latest solver data (by reference). Null until the first frame: uniform flow.
  private ux: Float32Array | null = null;
  private uy: Float32Array | null = null;
  private solid: Uint8Array | null = null;
  private u0 = 0.06;

  private mode: ViewMode = 'smoke';
  private flowing = true;
  // Velocity sample output (avoids returning tuples).
  private sx = 0;
  private sy = 0;

  constructor() {
    this.object = new Group();
    this.object.name = 'flow-viz';

    // ---- Field textures ----
    this.speedData = new Uint8Array(N_CELLS * 4);
    this.pressureData = new Uint8Array(N_CELLS * 4);
    this.speedTexture = makeTexture(this.speedData);
    this.pressureTexture = makeTexture(this.pressureData);
    this.skinData = new Uint8Array(N_CELLS * 4);
    this.skinTexture = makeTexture(this.skinData);
    this.fillUniform();

    // ---- Back-wall field plane ----
    this.fieldGeometry = new PlaneGeometry(TUNNEL_LENGTH, TUNNEL_HEIGHT);
    this.fieldMaterial = new MeshBasicMaterial({
      map: this.speedTexture,
      transparent: true,
      opacity: FIELD_OPACITY.smoke,
      depthWrite: false,
      toneMapped: false,
    });
    const field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    field.name = 'flow-field';
    field.position.set(TUNNEL_LENGTH / 2, TUNNEL_HEIGHT / 2, -TUNNEL_DEPTH / 2 + 0.003);
    field.userData.noSilhouette = true;
    field.renderOrder = -1;
    this.object.add(field);

    // ---- Speed colour lookup (sRGB bytes -> linear floats for vertex colours) ----
    this.speedLut = new Float32Array(256 * 3);
    const rgb = new Uint8Array(3);
    for (let k = 0; k < 256; k++) {
      speedColor(k / 255, rgb, 0);
      this.speedLut[k * 3] = srgbToLinear(rgb[0]);
      this.speedLut[k * 3 + 1] = srgbToLinear(rgb[1]);
      this.speedLut[k * 3 + 2] = srgbToLinear(rgb[2]);
    }

    // ---- Smoke streaks: one segment (head, tail) per particle ----
    this.positions = new Float32Array(PARTICLES * 6);
    this.colors = new Float32Array(PARTICLES * 6);
    this.positionAttr = new BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(DynamicDrawUsage);
    this.streakGeometry = new BufferGeometry();
    this.streakGeometry.setAttribute('position', this.positionAttr);
    this.streakGeometry.setAttribute('color', this.colorAttr);
    this.streakMaterial = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const streaks = new LineSegments(this.streakGeometry, this.streakMaterial);
    streaks.name = 'flow-streaks';
    streaks.frustumCulled = false;
    streaks.userData.noSilhouette = true;
    this.object.add(streaks);

    // Staggered start: particles spread along the tunnel with random ages.
    for (let p = 0; p < PARTICLES; p++) {
      this.spawn(p);
      this.px[p] = SPAWN_X + Math.random() * (TUNNEL_LENGTH - 2 * SPAWN_X);
      this.age[p] = Math.random() * MAX_AGE;
    }
    this.writeStreaks();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.fieldMaterial.map = mode === 'pressure' ? this.pressureTexture : this.speedTexture;
    this.fieldMaterial.opacity = FIELD_OPACITY[mode];
    this.streakGeometry.setDrawRange(0, (mode === 'pressure' ? PRESSURE_PARTICLES : PARTICLES) * 2);
  }

  setFlowing(on: boolean): void {
    this.flowing = on;
    this.streakMaterial.color.setScalar(on ? DIM_FLOWING : DIM_FROZEN);
  }

  /** New solver data: refresh both field textures and keep the velocity for the streaks. */
  update(frame: FlowFrame, solid: Uint8Array): void {
    const { ux, uy, rho } = frame;
    this.ux = ux;
    this.uy = uy;
    this.solid = solid;
    this.u0 = frame.u0 > 1e-4 ? frame.u0 : 1e-4;

    const speedScale = 1 / (this.u0 * SPEED_NORM);
    const cpScale = 1 / (3 * 0.5 * this.u0 * this.u0 * CP_RANGE);
    const sd = this.speedData;
    const pd = this.pressureData;
    for (let c = 0; c < N_CELLS; c++) {
      const o = c * 4;
      if (solid[c] || rho[c] <= 0) {
        sd[o] = pd[o] = SOLID_RGB[0];
        sd[o + 1] = pd[o + 1] = SOLID_RGB[1];
        sd[o + 2] = pd[o + 2] = SOLID_RGB[2];
        continue;
      }
      const u = ux[c];
      const v = uy[c];
      speedColor(Math.sqrt(u * u + v * v) * speedScale, sd, o);
      divergingColor((rho[c] - 1) * cpScale, pd, o);
    }
    this.speedTexture.needsUpdate = true;
    this.pressureTexture.needsUpdate = true;

    this.updateNearestFluid(solid);
    const near = this.nearestFluid;
    const kd = this.skinData;
    for (let c = 0; c < N_CELLS; c++) {
      const o = c * 4;
      const s = near[c] * 4;
      kd[o] = pd[s];
      kd[o + 1] = pd[s + 1];
      kd[o + 2] = pd[s + 2];
    }
    this.skinTexture.needsUpdate = true;
  }

  /** Multi-source flood fill from every fluid cell into the solid ones; skipped while the mask is unchanged. */
  private updateNearestFluid(solid: Uint8Array): void {
    let hash = 0;
    let count = 0;
    for (let c = 0; c < N_CELLS; c++) {
      if (solid[c]) {
        hash = (hash * 31 + c) | 0;
        count++;
      }
    }
    if (hash === this.maskHash && count === this.maskSolidCount) return;
    this.maskHash = hash;
    this.maskSolidCount = count;

    const near = this.nearestFluid;
    const queue = this.bfsQueue;
    let head = 0;
    let tail = 0;
    for (let c = 0; c < N_CELLS; c++) {
      if (solid[c]) {
        near[c] = -1;
      } else {
        near[c] = c;
        queue[tail++] = c;
      }
    }
    while (head < tail) {
      const c = queue[head++];
      const i = c % GRID_NX;
      if (i > 0 && near[c - 1] < 0) { near[c - 1] = near[c]; queue[tail++] = c - 1; }
      if (i < GRID_NX - 1 && near[c + 1] < 0) { near[c + 1] = near[c]; queue[tail++] = c + 1; }
      if (c >= GRID_NX && near[c - GRID_NX] < 0) { near[c - GRID_NX] = near[c]; queue[tail++] = c - GRID_NX; }
      if (c < N_CELLS - GRID_NX && near[c + GRID_NX] < 0) { near[c + GRID_NX] = near[c]; queue[tail++] = c + GRID_NX; }
    }
    // A fully solid grid can't happen (inlet/outlet columns are kept clear), but never index -1.
    for (let c = 0; c < N_CELLS; c++) if (near[c] < 0) near[c] = 0;
  }

  /** Advect the smoke streaks; call every frame. */
  tick(delta: number): void {
    if (!this.flowing) return;
    const dt = delta > 0.05 ? 0.05 : delta;
    if (dt <= 0) return;
    const { px, py, age } = this;
    for (let p = 0; p < PARTICLES; p++) {
      age[p] += dt;
      this.sample(px[p], py[p]);
      px[p] += this.sx * dt;
      py[p] += this.sy * dt;
      if (age[p] > MAX_AGE || this.outsideOrSolid(px[p], py[p])) this.spawn(p);
    }
    this.writeStreaks();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    this.streakGeometry.dispose();
    this.streakMaterial.dispose();
    this.speedTexture.dispose();
    this.pressureTexture.dispose();
    this.skinTexture.dispose();
    this.ux = this.uy = null;
    this.solid = null;
  }

  // ---- internals ----

  private spawn(p: number): void {
    this.px[p] = SPAWN_X;
    this.py[p] = SPAWN_MARGIN + Math.random() * (TUNNEL_HEIGHT - 2 * SPAWN_MARGIN);
    this.pz[p] = (Math.random() * 2 - 1) * SPREAD_Z;
    this.age[p] = 0;
  }

  private outsideOrSolid(x: number, y: number): boolean {
    if (x < 0 || x >= TUNNEL_LENGTH || y < 0 || y >= TUNNEL_HEIGHT) return true;
    const solid = this.solid;
    if (!solid) return false;
    const i = Math.floor(x / CELL);
    const j = Math.floor(y / CELL);
    return solid[j * GRID_NX + i] !== 0;
  }

  /** Bilinear velocity at tunnel-local (x, y) in m/s, written to sx, sy. */
  private sample(x: number, y: number): void {
    const ux = this.ux;
    const uy = this.uy;
    if (!ux || !uy) {
      this.sx = VISUAL_FLOW_SPEED;
      this.sy = 0;
      return;
    }
    let gx = x / CELL - 0.5;
    let gy = y / CELL - 0.5;
    if (gx < 0) gx = 0;
    else if (gx > GRID_NX - 1.001) gx = GRID_NX - 1.001;
    if (gy < 0) gy = 0;
    else if (gy > GRID_NY - 1.001) gy = GRID_NY - 1.001;
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const c00 = j * GRID_NX + i;
    const c10 = c00 + 1;
    const c01 = c00 + GRID_NX;
    const c11 = c01 + 1;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const scale = VISUAL_FLOW_SPEED / this.u0;
    let vx = (ux[c00] * w00 + ux[c10] * w10 + ux[c01] * w01 + ux[c11] * w11) * scale;
    let vy = (uy[c00] * w00 + uy[c10] * w10 + uy[c01] * w01 + uy[c11] * w11) * scale;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      vx = VISUAL_FLOW_SPEED;
      vy = 0;
    }
    const s2 = vx * vx + vy * vy;
    if (s2 > MAX_VISUAL_SPEED * MAX_VISUAL_SPEED) {
      const k = MAX_VISUAL_SPEED / Math.sqrt(s2);
      vx *= k;
      vy *= k;
    }
    this.sx = vx;
    this.sy = vy;
  }

  /** Write head/tail vertices and colours for every particle. */
  private writeStreaks(): void {
    const { px, py, pz, positions: pos, colors: col, speedLut: lut } = this;
    const norm = 1 / (VISUAL_FLOW_SPEED * SPEED_NORM);
    for (let p = 0; p < PARTICLES; p++) {
      this.sample(px[p], py[p]);
      const o = p * 6;
      pos[o] = px[p];
      pos[o + 1] = py[p];
      pos[o + 2] = pz[p];
      pos[o + 3] = px[p] - this.sx * TAIL_SECONDS;
      pos[o + 4] = py[p] - this.sy * TAIL_SECONDS;
      pos[o + 5] = pz[p];

      let t = Math.sqrt(this.sx * this.sx + this.sy * this.sy) * norm;
      if (t > 1) t = 1;
      const k = ((t * 255) | 0) * 3;
      col[o] = lut[k];
      col[o + 1] = lut[k + 1];
      col[o + 2] = lut[k + 2];
      col[o + 3] = lut[k] * TAIL_FADE;
      col[o + 4] = lut[k + 1] * TAIL_FADE;
      col[o + 5] = lut[k + 2] * TAIL_FADE;
    }
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  /** Field textures before the first solver frame: uniform inlet speed, Cp = 0. */
  private fillUniform(): void {
    for (let c = 0; c < N_CELLS; c++) {
      const o = c * 4;
      speedColor(1 / SPEED_NORM, this.speedData, o);
      divergingColor(0, this.pressureData, o);
      divergingColor(0, this.skinData, o);
    }
    this.speedTexture.needsUpdate = true;
    this.pressureTexture.needsUpdate = true;
    this.skinTexture.needsUpdate = true;
  }
}

function makeTexture(data: Uint8Array): DataTexture {
  data.fill(255);   // alpha stays opaque; RGB is overwritten
  const tex = new DataTexture(data, GRID_NX, GRID_NY, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function srgbToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
