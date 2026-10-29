/**
 * Model placement and silhouette rasterisation for the 2D solver.
 *
 * - computeFit: uniform scale + tunnel-local placement so any model (procedural
 *   or imported glTF) lands at MODEL_TARGET_LENGTH with its nose at MODEL_NOSE_X.
 * - rasterizeSilhouette: projects every visible triangle of the model onto the
 *   tunnel-local x/y plane and fills the GRID_NX x GRID_NY solid mask the LBM
 *   solver uses. The side view (union over z) is what a 2D centreline slice sees.
 *
 * Meshes (and their subtrees) flagged with userData.noSilhouette are ignored, as
 * are invisible objects. Only geometry is read; materials are irrelevant.
 */

import { Matrix4, Vector3 } from '@iwsdk/core';
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Mesh, Object3D } from '@iwsdk/core';
import {
  CELL,
  GRID_NX,
  GRID_NY,
  MODEL_NOSE_X,
  MODEL_TARGET_LENGTH,
  TUNNEL_HEIGHT,
} from './tunnel.js';
import type { ModelKind } from './types.js';

export interface Fit {
  /** Uniform scale to apply to the model root. */
  scale: number;
  /** Tunnel-local position of the scaled bounding-box centre. */
  center: Vector3;
  /**
   * Convenience (additive to the spec): the model.position that realises `center`
   * when the model is a direct child of the tunnel with no rotation and `scale` applied.
   * position = center - scale * nativeBoxCentre.
   */
  position: Vector3;
}

export interface SilhouetteInfo {
  frontalCells: number;
  lengthCells: number;
  solidCells: number;
}

type PositionAttr = BufferAttribute | InterleavedBufferAttribute;

const CELL_COUNT = GRID_NX * GRID_NY;
const INV_CELL = 1 / CELL;

// Module scratch (no per-triangle or per-mesh allocation in rasterisation).
const _tunnelInv = new Matrix4();
const _rel = new Matrix4();
const _raw = new Uint8Array(CELL_COUNT);

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/** Native-frame bounds accumulator for computeFit. */
const _box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, empty: true };

function expandByMesh(mesh: Mesh, m: Matrix4): void {
  const geom = mesh.geometry as BufferGeometry | undefined;
  const pos = geom?.getAttribute('position') as PositionAttr | undefined;
  if (!pos) return;
  const e = m.elements;
  for (let v = 0, n = pos.count; v < n; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (_box.empty) {
      _box.minX = _box.maxX = wx;
      _box.minY = _box.maxY = wy;
      _box.minZ = _box.maxZ = wz;
      _box.empty = false;
      continue;
    }
    if (wx < _box.minX) _box.minX = wx; else if (wx > _box.maxX) _box.maxX = wx;
    if (wy < _box.minY) _box.minY = wy; else if (wy > _box.maxY) _box.maxY = wy;
    if (wz < _box.minZ) _box.minZ = wz; else if (wz > _box.maxZ) _box.maxZ = wz;
  }
}

/** Walk the subtree accumulating bounds with matrices relative to the model root (root = identity). */
function walkBounds(obj: Object3D, parent: Matrix4): void {
  if (!obj.visible || obj.userData.noSilhouette) return;
  if ((obj as Mesh).isMesh) expandByMesh(obj as Mesh, parent);
  const children = obj.children;
  if (children.length === 0) return;
  const local = new Matrix4();
  for (let c = 0; c < children.length; c++) {
    const child = children[c];
    if (child.matrixAutoUpdate) child.updateMatrix();
    local.multiplyMatrices(parent, child.matrix);
    walkBounds(child, local);
  }
}

/**
 * Scale and tunnel-local placement for a model, measured in its own native frame
 * (the model root's own position/rotation/scale are ignored).
 */
export function computeFit(model: Object3D, kind: ModelKind): Fit {
  _box.empty = true;
  walkBounds(model, new Matrix4());

  if (_box.empty) {
    const y = kind === 'ground' ? 0 : TUNNEL_HEIGHT / 2;
    const center = new Vector3(MODEL_NOSE_X + MODEL_TARGET_LENGTH / 2, y, 0);
    return { scale: 1, center, position: center.clone() };
  }

  const sizeX = _box.maxX - _box.minX;
  const sizeY = _box.maxY - _box.minY;
  const scale = sizeX > 1e-9 ? MODEL_TARGET_LENGTH / sizeX : 1;
  const halfH = (sizeY * scale) / 2;

  const center = new Vector3(
    MODEL_NOSE_X + (sizeX * scale) / 2,
    kind === 'ground' ? halfH : TUNNEL_HEIGHT / 2,
    0,
  );
  const position = new Vector3(
    center.x - scale * (_box.minX + _box.maxX) * 0.5,
    center.y - scale * (_box.minY + _box.maxY) * 0.5,
    center.z - scale * (_box.minZ + _box.maxZ) * 0.5,
  );
  return { scale, center, position };
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

function markCell(gx: number, gy: number): void {
  const i = Math.floor(gx), j = Math.floor(gy);
  if (i >= 0 && i < GRID_NX && j >= 0 && j < GRID_NY) _raw[j * GRID_NX + i] = 1;
}

/** Mark every cell a segment passes through (sampled at half-cell steps). Grid units. */
function markSegment(x0: number, y0: number, x1: number, y1: number): void {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
  if (steps <= 0) { markCell(x0, y0); return; }
  const inv = 1 / steps;
  for (let s = 0; s <= steps; s++) markCell(x0 + dx * s * inv, y0 + dy * s * inv);
}

/** Fill one triangle given in grid units (x, y in cells). */
function rasterTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void {
  // Cheap reject when entirely outside the grid.
  const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
  const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
  if (maxX < 0 || maxY < 0 || minX >= GRID_NX || minY >= GRID_NY) return;

  // Vertex cells always survive so thin parts keep at least one cell.
  markCell(ax, ay); markCell(bx, by); markCell(cx, cy);

  const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const lab = Math.abs(bx - ax) + Math.abs(by - ay);
  const lbc = Math.abs(cx - bx) + Math.abs(cy - by);
  const lca = Math.abs(ax - cx) + Math.abs(ay - cy);
  const longest = Math.max(lab, lbc, lca);

  // Sliver (thinner than ~1 cell): centre sampling would miss it, so trace its edges.
  if (Math.abs(area2) < longest) {
    if (longest > 1) {
      markSegment(ax, ay, bx, by);
      markSegment(bx, by, cx, cy);
      markSegment(cx, cy, ax, ay);
    }
    if (Math.abs(area2) < 1e-12) return;
  }

  // Normalise winding so the inside is where all edge functions are >= 0.
  const sgn = area2 > 0 ? 1 : -1;
  const i0 = Math.max(0, Math.ceil(minX - 0.5));
  const i1 = Math.min(GRID_NX - 1, Math.floor(maxX - 0.5));
  const j0 = Math.max(0, Math.ceil(minY - 0.5));
  const j1 = Math.min(GRID_NY - 1, Math.floor(maxY - 0.5));
  if (i0 > i1 || j0 > j1) return;

  // Edge function E(p) = (q1 - q0) x (p - q0); incremental in x.
  const e0dx = -(by - ay) * sgn, e0dy = (bx - ax) * sgn;
  const e1dx = -(cy - by) * sgn, e1dy = (cx - bx) * sgn;
  const e2dx = -(ay - cy) * sgn, e2dy = (ax - cx) * sgn;
  const px0 = i0 + 0.5;
  for (let j = j0; j <= j1; j++) {
    const py = j + 0.5;
    let w0 = e0dx * (px0 - ax) + e0dy * (py - ay);
    let w1 = e1dx * (px0 - bx) + e1dy * (py - by);
    let w2 = e2dx * (px0 - cx) + e2dy * (py - cy);
    const row = j * GRID_NX;
    for (let i = i0; i <= i1; i++) {
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) _raw[row + i] = 1;
      w0 += e0dx; w1 += e1dx; w2 += e2dx;
    }
  }
}

function rasterMesh(mesh: Mesh): void {
  const geom = mesh.geometry as BufferGeometry | undefined;
  const pos = geom?.getAttribute('position') as PositionAttr | undefined;
  if (!geom || !pos) return;

  _rel.multiplyMatrices(_tunnelInv, mesh.matrixWorld);
  const e = _rel.elements;
  const m0 = e[0] * INV_CELL, m4 = e[4] * INV_CELL, m8 = e[8] * INV_CELL, m12 = e[12] * INV_CELL;
  const m1 = e[1] * INV_CELL, m5 = e[5] * INV_CELL, m9 = e[9] * INV_CELL, m13 = e[13] * INV_CELL;

  const index = geom.index;
  const total = index ? index.count : pos.count;
  const start = Math.max(0, geom.drawRange.start);
  const end = Math.min(total, start + geom.drawRange.count);
  const idx = index ? index.array : null;

  for (let t = start; t + 2 < end; t += 3) {
    const a = idx ? idx[t] : t;
    const b = idx ? idx[t + 1] : t + 1;
    const c = idx ? idx[t + 2] : t + 2;
    let x = pos.getX(a), y = pos.getY(a), z = pos.getZ(a);
    const ax = m0 * x + m4 * y + m8 * z + m12, ay = m1 * x + m5 * y + m9 * z + m13;
    x = pos.getX(b); y = pos.getY(b); z = pos.getZ(b);
    const bx = m0 * x + m4 * y + m8 * z + m12, by = m1 * x + m5 * y + m9 * z + m13;
    x = pos.getX(c); y = pos.getY(c); z = pos.getZ(c);
    const cx = m0 * x + m4 * y + m8 * z + m12, cy = m1 * x + m5 * y + m9 * z + m13;
    rasterTriangle(ax, ay, bx, by, cx, cy);
  }
}

function walkRaster(obj: Object3D): void {
  if (!obj.visible || obj.userData.noSilhouette) return;
  if ((obj as Mesh).isMesh) rasterMesh(obj as Mesh);
  const children = obj.children;
  for (let c = 0; c < children.length; c++) walkRaster(children[c]);
}

/**
 * Rasterise the model's side silhouette into `out` (GRID_NX * GRID_NY, 1 = solid).
 * Caller must have called updateMatrixWorld(true) on the scene / tunnel first.
 */
export function rasterizeSilhouette(model: Object3D, tunnel: Object3D, out: Uint8Array): SilhouetteInfo {
  _raw.fill(0);
  out.fill(0);
  _tunnelInv.copy(tunnel.matrixWorld).invert();
  walkRaster(model);

  // 1-cell (3x3) dilation, skipping the two inlet and two outlet columns.
  let solidCells = 0;
  for (let j = 0; j < GRID_NY; j++) {
    const jLo = j > 0 ? j - 1 : 0;
    const jHi = j < GRID_NY - 1 ? j + 1 : GRID_NY - 1;
    for (let i = 2; i < GRID_NX - 2; i++) {
      let hit = 0;
      for (let jj = jLo; jj <= jHi && !hit; jj++) {
        const r = jj * GRID_NX;
        hit = _raw[r + i - 1] | _raw[r + i] | _raw[r + i + 1];
      }
      if (hit) { out[j * GRID_NX + i] = 1; solidCells++; }
    }
  }

  let frontalCells = 0;
  for (let j = 0; j < GRID_NY; j++) {
    const r = j * GRID_NX;
    for (let i = 2; i < GRID_NX - 2; i++) {
      if (out[r + i]) { frontalCells++; break; }
    }
  }
  let lengthCells = 0;
  for (let i = 2; i < GRID_NX - 2; i++) {
    for (let j = 0; j < GRID_NY; j++) {
      if (out[j * GRID_NX + i]) { lengthCells++; break; }
    }
  }

  return { frontalCells, lengthCells, solidCells };
}

/** Centroid of the solid cells in tunnel-local metres, or null for an empty mask. */
export function maskCentroid(mask: Uint8Array): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (let j = 0; j < GRID_NY; j++) {
    const r = j * GRID_NX;
    for (let i = 0; i < GRID_NX; i++) {
      if (mask[r + i]) { sx += i; sy += j; n++; }
    }
  }
  if (n === 0) return null;
  return { x: (sx / n + 0.5) * CELL, y: (sy / n + 0.5) * CELL };
}
