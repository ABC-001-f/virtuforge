/**
 * Procedural air vehicles for the tunnel: a light jet, a quadcopter and a
 * NACA 2412 wing section.
 *
 * Frame rules (see types.ts): nose / leading edge toward -x, up +y, span on z,
 * length about 1 at native scale. computeFit rescales them anyway.
 *
 * Geometries are built lazily once and cached; materials are module-level.
 * Both are shared by every build, so rebuilding a model allocates only
 * Object3Ds. (If a caller disposes them, three.js simply re-uploads on use.)
 *
 * Meshes that are not part of the 2D centreline section - translucent rotor
 * discs, propeller blades, wing end plates - carry userData.noSilhouette so
 * the solver mask is not polluted by them.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Shape,
  ShapeUtils,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from '@iwsdk/core';
import type { Material, Object3D } from '@iwsdk/core';
import type { BuiltModel } from '../types.js';

// ---------------------------------------------------------------- materials

const white = new MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.42, metalness: 0.08 });
const graphite = new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.55, metalness: 0.35 });
const accent = new MeshStandardMaterial({
  color: 0x22d3ee,
  emissive: 0x0b4a57,
  roughness: 0.35,
  metalness: 0.1,
});
const canopy = new MeshStandardMaterial({ color: 0x1b2633, roughness: 0.12, metalness: 0.6 });
const rotorDisc = new MeshStandardMaterial({
  color: 0x9ae9f7,
  roughness: 0.3,
  metalness: 0,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  side: DoubleSide,
});

// ---------------------------------------------------------------- geometry cache

const geoCache = new Map<string, BufferGeometry>();

function geo(key: string, make: () => BufferGeometry): BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

function mesh(
  geometry: BufferGeometry,
  material: Material,
  x = 0,
  y = 0,
  z = 0,
  noSilhouette = false,
): Mesh {
  const m = new Mesh(geometry, material);
  m.position.set(x, y, z);
  if (noSilhouette) m.userData.noSilhouette = true;
  return m;
}

function part(name: string, ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  for (const c of children) g.add(c);
  return g;
}

function assemble(name: string, parts: Group[]): BuiltModel {
  const root = new Group();
  root.name = name;
  for (const p of parts) root.add(p);
  return { root, parts, handles: [] };
}

/**
 * Swept, tapered planform in the x/z plane, symmetric about z = 0, with the
 * given thickness centred on y = 0. Chord stations are absolute x values.
 */
function planform(
  rootLE: number,
  rootTE: number,
  tipLE: number,
  tipTE: number,
  halfSpan: number,
  thickness: number,
): BufferGeometry {
  // Shape coordinates are (x, span); rotateX below maps span onto +z.
  const s = new Shape();
  s.moveTo(rootLE, 0);
  s.lineTo(tipLE, -halfSpan);
  s.lineTo(tipTE, -halfSpan);
  s.lineTo(rootTE, 0);
  s.lineTo(tipTE, halfSpan);
  s.lineTo(tipLE, halfSpan);
  s.closePath();
  const bevel = thickness * 0.3;
  const g = new ExtrudeGeometry(s, {
    depth: thickness - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  g.rotateX(Math.PI / 2); // span -> z, extrusion -> -y
  g.translate(0, thickness / 2 - bevel, 0);
  return g;
}

// ---------------------------------------------------------------- airplane

/** Fuselage radius profile: (radius, station) with station -0.5 = nose. */
const FUSELAGE_PROFILE: [number, number][] = [
  [0, -0.5], [0.018, -0.49], [0.032, -0.47], [0.045, -0.43], [0.054, -0.37],
  [0.058, -0.3], [0.06, -0.2], [0.06, 0.05], [0.056, 0.15], [0.047, 0.25],
  [0.036, 0.34], [0.025, 0.42], [0.016, 0.48], [0, 0.5],
];

export function buildAirplane(): BuiltModel {
  const body = geo('plane.fuselage', () => {
    const pts = FUSELAGE_PROFILE.map(([r, t]) => new Vector2(r, t));
    const g = new LatheGeometry(pts, 20);
    g.rotateZ(-Math.PI / 2); // lathe axis y -> x, nose (-y) -> -x
    return g;
  });
  const sphere = geo('unit.sphere', () => new SphereGeometry(1, 16, 10));
  const cockpit = mesh(sphere, canopy, -0.37, 0.034, 0);
  cockpit.scale.set(0.085, 0.032, 0.038);
  const fuselage = part('fuselage', mesh(body, white), cockpit);

  // Low swept wing with cyan winglets.
  const wingGeo = geo('plane.wing', () => planform(-0.14, 0.06, 0.06, 0.13, 0.46, 0.014));
  const wingletGeo = geo('plane.winglet', () => new BoxGeometry(0.06, 0.05, 0.006));
  const wings = part(
    'wings',
    mesh(wingGeo, white, 0, -0.035, 0),
    mesh(wingletGeo, accent, 0.1, -0.012, 0.457),
    mesh(wingletGeo, accent, 0.1, -0.012, -0.457),
  );

  // Horizontal stabiliser + vertical fin (the fin shows in the side silhouette).
  const stabGeo = geo('plane.stab', () => planform(0.33, 0.46, 0.43, 0.49, 0.17, 0.01));
  const finGeo = geo('plane.fin', () => {
    const s = new Shape();
    s.moveTo(0.28, 0.035);
    s.lineTo(0.43, 0.19);
    s.lineTo(0.49, 0.19);
    s.lineTo(0.495, 0.012);
    s.closePath();
    const g = new ExtrudeGeometry(s, {
      depth: 0.008,
      bevelEnabled: true,
      bevelThickness: 0.002,
      bevelSize: 0.002,
      bevelSegments: 1,
      curveSegments: 1,
    });
    g.translate(0, 0, -0.004);
    return g;
  });
  const tail = part('tail', mesh(stabGeo, white, 0, 0.02, 0), mesh(finGeo, accent));

  // Under-wing nacelles on short pylons, cyan intake lips.
  const nacelleGeo = geo('plane.nacelle', () => {
    const g = new CylinderGeometry(0.03, 0.024, 0.15, 16, 1);
    g.rotateZ(Math.PI / 2); // axis y -> x; the wider top end lands at -x (intake)
    return g;
  });
  const lipGeo = geo('plane.lip', () => {
    const g = new TorusGeometry(0.028, 0.005, 6, 16);
    g.rotateY(Math.PI / 2); // ring faces along x
    return g;
  });
  const pylonGeo = geo('plane.pylon', () => new BoxGeometry(0.06, 0.02, 0.008));
  const engines = part('engines');
  for (const z of [0.17, -0.17]) {
    engines.add(
      mesh(nacelleGeo, graphite, -0.07, -0.08, z),
      mesh(lipGeo, accent, -0.145, -0.08, z),
      mesh(pylonGeo, graphite, -0.05, -0.048, z),
    );
  }

  return assemble('airplane', [fuselage, wings, tail, engines]);
}

// ---------------------------------------------------------------- drone

const ARM_LENGTH = 0.27;

export function buildDrone(): BuiltModel {
  const sphere = geo('unit.sphere', () => new SphereGeometry(1, 16, 10));
  const pod = mesh(sphere, white);
  pod.scale.set(0.13, 0.045, 0.09);
  const batteryGeo = geo('drone.battery', () => new BoxGeometry(0.12, 0.028, 0.07));
  const ledGeo = geo('drone.led', () => new BoxGeometry(0.008, 0.012, 0.07));
  const legGeo = geo('drone.leg', () => new CylinderGeometry(0.005, 0.005, 0.06, 6));
  const body = part(
    'body',
    pod,
    mesh(batteryGeo, graphite, 0.01, 0.048, 0),
    mesh(ledGeo, accent, -0.128, 0.005, 0),
  );
  for (const [x, z] of [[0.06, 0.05], [0.06, -0.05], [-0.06, 0.05], [-0.06, -0.05]]) {
    body.add(mesh(legGeo, graphite, x, -0.06, z));
  }

  // X layout arms, motors at the tips (motors are solid, so they live here).
  const armGeo = geo('drone.arm', () => new BoxGeometry(ARM_LENGTH, 0.018, 0.026));
  const motorGeo = geo('drone.motor', () => new CylinderGeometry(0.026, 0.026, 0.04, 14));
  const capGeo = geo('drone.cap', () => new CylinderGeometry(0.012, 0.012, 0.012, 10));
  const discGeo = geo('drone.disc', () => new CylinderGeometry(0.13, 0.13, 0.003, 32));
  const bladeGeo = geo('drone.blade', () => new BoxGeometry(0.24, 0.003, 0.018));
  const arms = part('arms');
  const rotors = part('rotors');
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const c = Math.cos(a);
    const s = -Math.sin(a); // rotation.y = a maps local +x to (cos a, 0, -sin a)
    const arm = mesh(armGeo, graphite, (c * ARM_LENGTH) / 2, 0.005, (s * ARM_LENGTH) / 2);
    arm.rotation.y = a;
    const mx = c * ARM_LENGTH;
    const mz = s * ARM_LENGTH;
    arms.add(arm, mesh(motorGeo, graphite, mx, 0.025, mz), mesh(capGeo, accent, mx, 0.051, mz));

    const blade = mesh(bladeGeo, white, mx, 0.058, mz, true);
    blade.rotation.y = a + (k % 2 ? 0.6 : -0.6);
    rotors.add(mesh(discGeo, rotorDisc, mx, 0.06, mz, true), blade);
  }

  // Gimbal under the nose: mount, ball, cyan lens facing -x.
  const mountGeo = geo('drone.mount', () => new CylinderGeometry(0.012, 0.012, 0.025, 8));
  const ballGeo = geo('drone.ball', () => new SphereGeometry(0.028, 14, 10));
  const lensGeo = geo('drone.lens', () => {
    const g = new CylinderGeometry(0.012, 0.012, 0.012, 12);
    g.rotateZ(Math.PI / 2);
    return g;
  });
  const camera = part(
    'camera',
    mesh(mountGeo, graphite, -0.07, -0.05, 0),
    mesh(ballGeo, graphite, -0.07, -0.078, 0),
    mesh(lensGeo, accent, -0.098, -0.078, 0),
  );

  return assemble('drone', [body, arms, rotors, camera]);
}

// ---------------------------------------------------------------- NACA 2412 wing

const WING_SPAN = 0.9;
const AIRFOIL_HALF_POINTS = 30;

/**
 * NACA 4-digit section (m = 2%, p = 40%, t = 12%), chord 1, cosine spacing.
 * Returns an open contour from the trailing edge over the upper surface to
 * the leading edge and back along the lower surface (first == last point),
 * counter-clockwise, with x shifted so the leading edge is at -0.5.
 */
function naca2412(n: number): Vector2[] {
  const m = 0.02;
  const p = 0.4;
  const t = 0.12;
  const upper: Vector2[] = [];
  const lower: Vector2[] = [];
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / n)); // 0 at LE .. 1 at TE
    // Closed-trailing-edge thickness coefficient (-0.1036).
    const yt =
      5 * t *
      (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc: number;
    let dyc: number;
    if (x < p) {
      yc = (m / (p * p)) * (2 * p * x - x * x);
      dyc = ((2 * m) / (p * p)) * (p - x);
    } else {
      yc = (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
      dyc = ((2 * m) / ((1 - p) * (1 - p))) * (p - x);
    }
    const th = Math.atan(dyc);
    const sn = Math.sin(th);
    const cs = Math.cos(th);
    upper.push(new Vector2(x - yt * sn - 0.5, yc + yt * cs));
    lower.push(new Vector2(x + yt * sn - 0.5, yc - yt * cs));
  }
  // TE -> LE along the upper surface, then LE -> TE along the lower one.
  const out = upper.reverse();
  for (let i = 1; i < lower.length; i++) out.push(lower[i]);
  return out;
}

/** Smooth-shaded extrusion of the airfoil along z, with flat end caps. */
function airfoilGeometry(span: number): BufferGeometry {
  const pts = naca2412(AIRFOIL_HALF_POINTS);
  const count = pts.length;
  const h = span / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];

  // Sides: vertex 2i at z = -h, 2i + 1 at z = +h, normal from the 2D tangent.
  for (let i = 0; i < count; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, count - 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const p = pts[i];
    positions.push(p.x, p.y, -h, p.x, p.y, h);
    normals.push(ty, -tx, 0, ty, -tx, 0); // outward for a CCW contour
  }
  for (let i = 0; i < count - 1; i++) {
    const a0 = 2 * i;
    const b0 = a0 + 1;
    const a1 = a0 + 2;
    const b1 = a0 + 3;
    index.push(a0, a1, b1, a0, b1, b0);
  }

  // Caps: drop the duplicated trailing-edge point, triangulate once.
  const contour = pts.slice(0, count - 1);
  const tris = ShapeUtils.triangulateShape(contour, []);
  for (const [z, nz] of [[h, 1], [-h, -1]] as const) {
    const base = positions.length / 3;
    for (const p of contour) {
      positions.push(p.x, p.y, z);
      normals.push(0, 0, nz);
    }
    for (const [i0, i1, i2] of tris) {
      const p0 = contour[i0];
      const p1 = contour[i1];
      const p2 = contour[i2];
      const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
      // +z cap needs CCW triangles, -z cap needs CW.
      if (area * nz > 0) index.push(base + i0, base + i1, base + i2);
      else index.push(base + i0, base + i2, base + i1);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setIndex(index);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function buildWing(): BuiltModel {
  const wingGeo = geo('wing.naca2412', () => airfoilGeometry(WING_SPAN));
  const wing = part('wing', mesh(wingGeo, white));

  // End plates sit outside the centreline section, so keep them out of the mask.
  const plateGeo = geo('wing.endplate', () => new BoxGeometry(1.0, 0.26, 0.008));
  const endplates = part(
    'endplates',
    mesh(plateGeo, graphite, 0.0, 0.01, WING_SPAN / 2 + 0.004, true),
    mesh(plateGeo, graphite, 0.0, 0.01, -WING_SPAN / 2 - 0.004, true),
  );

  return assemble('wing', [wing, endplates]);
}
