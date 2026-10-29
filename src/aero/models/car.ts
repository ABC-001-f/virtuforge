import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
  Vector3,
} from '@iwsdk/core';
import type { BuiltModel, CarParams, HandleAnchor } from '../types.js';

/**
 * Parametric car builder.
 *
 * The side profile is one closed 2D outline: a monotone cubic (Fritsch-Carlson)
 * through style-specific knots for the top line, filleted nose and tail faces,
 * and a flat underbody at rideHeight. Because the top line is a function of the
 * length coordinate and always sits above the underbody, the outline can never
 * self-intersect for any params inside CAR_PARAM_LIMITS. It is extruded across
 * the width so the silhouette the solver rasterizes is exactly the visible body.
 *
 * Frame: length 1, nose at x = -0.5, tail at x = +0.5, ground at y = 0, centred
 * on z. Left side of the car (driver facing -x) is +z.
 */

export type CarStyle = 'ev' | 'sport' | 'van';

const WHEEL_RADIUS = 0.065;
const TYRE_WIDTH = 0.045;
const BEVEL_THICKNESS = 0.012;
const BEVEL_SIZE = 0.008;
const GLASS_GAP = 0.004;      // minimum glass band height below the top line
const GLASS_PROUD = 0.003;    // glass sits this far outside the paint to avoid z-fighting
const GLASS_SAMPLES = 16;
const TOP_STEP = 0.03;        // max length-wise spacing of top-line samples

// ---- shared materials (created once) ---------------------------------------

const PAINT: Record<CarStyle, MeshStandardMaterial> = {
  ev: new MeshStandardMaterial({ color: 0xf2f0ea, metalness: 0.35, roughness: 0.22 }),
  sport: new MeshStandardMaterial({ color: 0xc81e1e, metalness: 0.4, roughness: 0.2 }),
  van: new MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.2, roughness: 0.35 }),
};
const GLASS_MAT = new MeshStandardMaterial({ color: 0x0e151c, metalness: 0.6, roughness: 0.08 });
const BATTERY_MAT = new MeshStandardMaterial({ color: 0x1f5fd6, metalness: 0.3, roughness: 0.45 });
const MOTOR_MAT = new MeshStandardMaterial({ color: 0xb87333, metalness: 0.8, roughness: 0.3 });
const MOTOR_CAP_MAT = new MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.7, roughness: 0.35 });
const TYRE_MAT = new MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0, roughness: 0.9 });
const RIM_MAT = new MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.25 });
const HEADLIGHT_MAT = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xdfefff, emissiveIntensity: 0.8 });
const TAILLIGHT_MAT = new MeshStandardMaterial({ color: 0x8a0000, emissive: 0xff1a1a, emissiveIntensity: 0.7 });

// ---- shared geometries (unit-sized, scaled per mesh; never disposed per build) ----

const UNIT_BOX = new BoxGeometry(1, 1, 1);
const TYRE_GEO = new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, TYRE_WIDTH, 20).rotateX(Math.PI / 2);
const RIM_GEO = new CylinderGeometry(0.042, 0.042, TYRE_WIDTH + 0.003, 12).rotateX(Math.PI / 2);
const HUB_GEO = new CylinderGeometry(0.012, 0.012, TYRE_WIDTH + 0.008, 8).rotateX(Math.PI / 2);
const MOTOR_GEO = new CylinderGeometry(1, 1, 1, 16).rotateX(Math.PI / 2);
const SHARED_GEOMETRIES = new Set<BufferGeometry>([UNIT_BOX, TYRE_GEO, RIM_GEO, HUB_GEO, MOTOR_GEO]);

// ---- style tables -------------------------------------------------------------

interface StyleSpec {
  wheelU: [number, number];   // front / rear axle along the length (0 = nose)
  noseFillet: [number, number]; // bottom-front fillet [horizontal run, max vertical rise]
  tailFillet: number;          // bottom-rear fillet horizontal run
  topFillet: number;           // max radius of the nose/tail top corners
}

const STYLE: Record<CarStyle, StyleSpec> = {
  ev: { wheelU: [0.17, 0.82], noseFillet: [0.055, 0.045], tailFillet: 0.04, topFillet: 0.03 },
  sport: { wheelU: [0.17, 0.81], noseFillet: [0.08, 0.035], tailFillet: 0.035, topFillet: 0.02 },
  van: { wheelU: [0.15, 0.84], noseFillet: [0.03, 0.04], tailFillet: 0.025, topFillet: 0.015 },
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Knots of the top line plus the landmarks the glass and handles need. */
interface Profile {
  u: number[];
  y: number[];
  m: number[];          // monotone cubic tangents
  roofY: number;        // effective roof peak height
  glassFrom: number;    // glass band span along the length
  glassTo: number;
  glassEndY: number;    // belt height at the rear of the glass (clamped below the top line)
}

function makeProfile(p: CarParams, style: CarStyle): Profile {
  const n = p.noseHeight;
  const t = p.tailHeight;
  const pk = p.roofPeak;
  // The cabin must clear the hood and tail, otherwise the greenhouse collapses.
  const R = Math.max(p.roofHeight, n + 0.05, t + 0.03, p.rideHeight + 0.12);

  let u: number[];
  let y: number[];
  let glassFrom: number;
  let glassTo: number;
  let glassEndY: number;

  if (style === 'ev') {
    const uRF = pk - 0.09;
    const uRB = pk + 0.11;
    const uW = Math.max(0.12, uRF - 0.17);
    const yW = n + 0.18 * (R - n);
    const uD = Math.min(0.92, uRB + 0.17);
    const yD = t + 0.06 * (R - t);
    u = [0.025, uW, uRF, pk, uRB, uD, 0.975];
    y = [n, yW, R - 0.012, R, R - 0.018, yD, t];
    glassFrom = uW;
    glassTo = uD;
    glassEndY = yD;
  } else if (style === 'sport') {
    const uRF = pk - 0.07;
    const uRB = pk + 0.08;
    const uW = Math.max(0.14, uRF - 0.2);
    const yW = n + 0.12 * (R - n);
    const uD = Math.min(0.9, uRB + 0.2);
    const yD = t + 0.05 * (R - t);
    // Final knot kicks up into a ducktail spoiler lip.
    u = [0.025, uW, uRF, pk, uRB, uD, 0.945, 0.975];
    y = [n, yW, R - 0.01, R, R - 0.014, yD, t, t + 0.014];
    glassFrom = uW;
    glassTo = uD;
    glassEndY = yD;
  } else {
    const uRF = Math.max(0.18, pk - 0.16);
    const uW = Math.max(0.07, uRF - 0.1);
    const yW = n + 0.1 * (R - n);
    const uRB = clamp(0.93 - 0.9 * (R - t), pk + 0.08, 0.93);
    u = [0.025, uW, uRF, pk, uRB, 0.975];
    y = [n, yW, R - 0.008, R, R - 0.006, t];
    // Cab windows only: a delivery van's cargo box is blind.
    glassFrom = uW;
    glassTo = Math.min(uRF + 0.16, 0.93);
    glassEndY = yW + 0.01;
  }

  return { u, y, m: monotoneTangents(u, y), roofY: R, glassFrom, glassTo, glassEndY };
}

/** Fritsch-Carlson tangents: the interpolant never overshoots its knots. */
function monotoneTangents(u: number[], y: number[]): number[] {
  const k = u.length;
  const d = new Array<number>(k - 1);
  for (let i = 0; i < k - 1; i++) d[i] = (y[i + 1] - y[i]) / (u[i + 1] - u[i]);
  const m = new Array<number>(k);
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return m;
}

function hermite(pr: Profile, i: number, s: number): number {
  const h = pr.u[i + 1] - pr.u[i];
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * pr.y[i] +
    (s3 - 2 * s2 + s) * h * pr.m[i] +
    (-2 * s3 + 3 * s2) * pr.y[i + 1] +
    (s3 - s2) * h * pr.m[i + 1]
  );
}

/** Top-line height at length coordinate u (clamped to the knot range). */
function topY(pr: Profile, u: number): number {
  const last = pr.u.length - 1;
  if (u <= pr.u[0]) return pr.y[0];
  if (u >= pr.u[last]) return pr.y[last];
  let i = 0;
  while (i < last - 1 && u > pr.u[i + 1]) i++;
  return hermite(pr, i, (u - pr.u[i]) / (pr.u[i + 1] - pr.u[i]));
}

function buildBodyShape(p: CarParams, pr: Profile, spec: StyleSpec): Shape {
  const r = p.rideHeight;
  const n = pr.y[0];
  const last = pr.u.length - 1;
  const tTop = pr.y[last];
  const noseH = n - r;
  const tailH = tTop - r;
  // Fillets are capped by the face height so the nose/tail faces never invert.
  const ft = Math.min(spec.topFillet, 0.4 * noseH);
  const fbH = Math.min(spec.noseFillet[1], 0.5 * noseH);
  const rt = Math.min(spec.topFillet, 0.4 * tailH);
  const rbH = Math.min(0.03, 0.5 * tailH);
  const X = -0.5;

  const s = new Shape();
  s.moveTo(X + spec.noseFillet[0], r);
  s.quadraticCurveTo(X, r, X, r + fbH);
  s.lineTo(X, n - ft);
  s.quadraticCurveTo(X, n, X + pr.u[0], n);
  for (let i = 0; i < last; i++) {
    const segs = Math.max(2, Math.ceil((pr.u[i + 1] - pr.u[i]) / TOP_STEP));
    for (let k = 1; k <= segs; k++) {
      const f = k / segs;
      s.lineTo(X + pr.u[i] + f * (pr.u[i + 1] - pr.u[i]), hermite(pr, i, f));
    }
  }
  s.quadraticCurveTo(X + 1, tTop, X + 1, tTop - rt);
  s.lineTo(X + 1, r + rbH);
  s.quadraticCurveTo(X + 1, r, X + 1 - spec.tailFillet, r);
  s.closePath();
  return s;
}

/** Greenhouse band: top line (a hair proud) over a straight belt line, always >= GLASS_GAP tall. */
function buildGlassShape(pr: Profile): Shape {
  const u0 = pr.glassFrom;
  const u1 = pr.glassTo;
  const y0 = topY(pr, u0);
  const y1 = Math.min(pr.glassEndY, topY(pr, u1));
  const X = -0.5;
  const top = new Array<number>(GLASS_SAMPLES + 1);
  const s = new Shape();
  for (let k = 0; k <= GLASS_SAMPLES; k++) {
    const uu = u0 + (k / GLASS_SAMPLES) * (u1 - u0);
    top[k] = topY(pr, uu);
    if (k === 0) s.moveTo(X + uu, top[k] + GLASS_PROUD);
    else s.lineTo(X + uu, top[k] + GLASS_PROUD);
  }
  for (let k = GLASS_SAMPLES; k >= 0; k--) {
    const f = k / GLASS_SAMPLES;
    const belt = Math.min(y0 + f * (y1 - y0), top[k] - GLASS_GAP);
    s.lineTo(X + u0 + f * (u1 - u0), belt);
  }
  s.closePath();
  return s;
}

function extrude(shape: Shape, width: number, bevel: boolean): ExtrudeGeometry {
  const depth = bevel ? width - 2 * BEVEL_THICKNESS : width;
  const geo = new ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: 4,
    bevelEnabled: bevel,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
    // Negative offset keeps the outermost bevel exactly on the profile outline.
    bevelOffset: -BEVEL_SIZE,
    bevelSegments: 2,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

function boxMesh(name: string, mat: MeshStandardMaterial, sx: number, sy: number, sz: number): Mesh {
  const mesh = new Mesh(UNIT_BOX, mat);
  mesh.name = name;
  mesh.scale.set(sx, sy, sz);
  return mesh;
}

function buildWheel(name: string, x: number, z: number): Group {
  const wheel = new Group();
  wheel.name = name;
  wheel.position.set(x, WHEEL_RADIUS, z);
  wheel.add(new Mesh(TYRE_GEO, TYRE_MAT), new Mesh(RIM_GEO, RIM_MAT), new Mesh(HUB_GEO, MOTOR_CAP_MAT));
  return wheel;
}

export function buildCar(params: CarParams, style: CarStyle): BuiltModel {
  const spec = STYLE[style];
  const pr = makeProfile(params, style);
  const r = params.rideHeight;
  const w = params.width;
  const half = w / 2;
  const root = new Group();
  root.name = `car-${style}`;

  // Body
  const body = new Mesh(extrude(buildBodyShape(params, pr, spec), w, true), PAINT[style]);
  body.name = 'body';
  // Light strips ride on the body but stay out of the solver's silhouette.
  const lightY = pr.y[0] - Math.min(0.025, 0.35 * (pr.y[0] - r));
  const head = boxMesh('headlights', HEADLIGHT_MAT, 0.006, 0.012, w * 0.78);
  head.position.set(-0.5 - 0.001, lightY, 0);
  head.userData.noSilhouette = true;
  const tailTop = pr.y[pr.y.length - 1];
  const tail = boxMesh('taillights', TAILLIGHT_MAT, 0.006, 0.014, w * 0.82);
  tail.position.set(0.5 + 0.001, tailTop - Math.min(0.03, 0.4 * (tailTop - r)), 0);
  tail.userData.noSilhouette = true;
  body.add(head, tail);

  // Greenhouse
  const glass = new Mesh(extrude(buildGlassShape(pr), w + 2 * GLASS_PROUD, false), GLASS_MAT);
  glass.name = 'glass';

  // Battery pack lies on the floor pan, between the axles.
  const [uf, ur] = spec.wheelU;
  const battLen = (ur - uf) * 0.8;
  const battery = boxMesh('battery', BATTERY_MAT, battLen, 0.022, w * 0.78);
  battery.position.set(-0.5 + (uf + ur) / 2, r + 0.016, 0);

  // Motor on the rear axle, kept inside the body above the underbody.
  const motor = new Group();
  motor.name = 'motor';
  const motorR = 0.03;
  motor.position.set(-0.5 + ur, Math.max(WHEEL_RADIUS, r + motorR + 0.006), 0);
  const can = new Mesh(MOTOR_GEO, MOTOR_MAT);
  can.scale.set(motorR, motorR, w * 0.36);
  const cap = new Mesh(MOTOR_GEO, MOTOR_CAP_MAT);
  cap.scale.set(motorR * 0.75, motorR * 0.75, w * 0.46);
  motor.add(can, cap);

  // Wheels: tyre outer face just proud of the body side.
  const zW = half - TYRE_WIDTH / 2 + 0.006;
  const xF = -0.5 + uf;
  const xR = -0.5 + ur;
  const wheels = [
    buildWheel('wheel-fl', xF, zW),
    buildWheel('wheel-fr', xF, -zW),
    buildWheel('wheel-rl', xR, zW),
    buildWheel('wheel-rr', xR, -zW),
  ];

  const parts: Object3D[] = [body, glass, battery, motor, ...wheels];
  root.add(...parts);

  const last = pr.u.length - 1;
  const handles: HandleAnchor[] = [
    { param: 'noseHeight', axis: 'y', local: new Vector3(-0.5 + pr.u[0], pr.y[0], 0) },
    { param: 'roofHeight', axis: 'y', local: new Vector3(-0.5 + params.roofPeak, pr.roofY, 0) },
    { param: 'roofPeak', axis: 'x', local: new Vector3(-0.5 + params.roofPeak + 0.05, pr.roofY + 0.06, 0) },
    { param: 'tailHeight', axis: 'y', local: new Vector3(-0.5 + pr.u[last], pr.y[last], 0) },
  ];

  return { root, parts, handles };
}

/** Free the per-build geometries (body + glass) of a car root; shared geometries and materials are kept. */
export function disposeCar(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (mesh.isMesh && !SHARED_GEOMETRIES.has(mesh.geometry)) mesh.geometry.dispose();
  });
}
