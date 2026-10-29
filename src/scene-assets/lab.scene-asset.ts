import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
} from '@iwsdk/core';
import {
  DESK_TOP_Y,
  LEVER_RAIL,
  TUNNEL_DEPTH,
  TUNNEL_HEIGHT,
  TUNNEL_LENGTH,
  TUNNEL_ORIGIN_WORLD,
} from '../aero/tunnel.js';

/**
 * AeroLab set, built in code: floor, desk, the glass wind tunnel, the wind
 * lever rail/knob and the angle dial base/knob. Dark navy/graphite with cyan
 * accents. Geometries and materials are shared module-level instances; every
 * placement is a clone of these prototypes. Meshes systems look up at runtime
 * carry a stable `name` (`tunnel-fan`).
 */

// ---- Shared materials ----

const floorMaterial = new MeshStandardMaterial({ color: '#070a12', roughness: 0.92 });
const deskMaterial = new MeshStandardMaterial({ color: '#141a2a', roughness: 0.38, metalness: 0.3 });
const graphite = new MeshStandardMaterial({ color: '#23293a', roughness: 0.45, metalness: 0.55 });
const darkMetal = new MeshStandardMaterial({ color: '#0e121c', roughness: 0.5, metalness: 0.6 });
const brushedMetal = new MeshStandardMaterial({ color: '#59627a', roughness: 0.32, metalness: 0.8 });
const housingMaterial = new MeshStandardMaterial({ color: '#0e121c', roughness: 0.5, metalness: 0.6, side: DoubleSide });
const glowCyan = new MeshStandardMaterial({
  color: '#071018',
  emissive: '#00e5ff',
  emissiveIntensity: 1.3,
});
const glowCyanSoft = new MeshStandardMaterial({
  color: '#071018',
  emissive: '#00bcd4',
  emissiveIntensity: 0.45,
});
const knobGlow = new MeshStandardMaterial({
  color: '#0a2a33',
  emissive: '#29f0ff',
  emissiveIntensity: 1.6,
  roughness: 0.25,
});
const glassMaterial = new MeshStandardMaterial({
  color: '#bfefff',
  transparent: true,
  opacity: 0.1,
  roughness: 0.05,
  metalness: 0,
  depthWrite: false,
  side: DoubleSide,
});
// The flow field is drawn just in front of the back wall, so keep it nearly invisible.
const backGlassMaterial = new MeshStandardMaterial({
  color: '#bfefff',
  transparent: true,
  opacity: 0.035,
  roughness: 0.05,
  metalness: 0,
  depthWrite: false,
  side: DoubleSide,
});

// ---- Helpers ----

function mesh(geometry: BufferGeometry, material: MeshStandardMaterial,
  x = 0, y = 0, z = 0, name = ''): Mesh {
  const m = new Mesh(geometry, material);
  m.position.set(x, y, z);
  if (name) m.name = name;
  return m;
}

function box(group: Group, w: number, h: number, d: number, material: MeshStandardMaterial,
  x: number, y: number, z: number): Mesh {
  const m = mesh(new BoxGeometry(w, h, d), material, x, y, z);
  group.add(m);
  return m;
}

// ---- Floor & desk ----

/** Large dark floor disc with a subtle cyan ring. Origin on the floor. */
export function createLabFloor(): Group {
  const group = new Group();
  group.add(mesh(new CylinderGeometry(7, 7, 0.02, 64), floorMaterial, 0, -0.01, 0));
  const ring = mesh(new TorusGeometry(1.6, 0.006, 6, 96), glowCyanSoft, 0, 0.002, 0);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  const inner = mesh(new TorusGeometry(1.15, 0.003, 6, 96), glowCyanSoft, 0, 0.002, 0);
  inner.rotation.x = Math.PI / 2;
  group.add(inner);
  return group;
}

const DESK_W = 2.0;
const DESK_D = 0.7;
const DESK_SLAB = 0.04;

/** Wide engineering desk, top at DESK_TOP_Y. Origin on the floor under its centre. */
export function createLabDesk(): Group {
  const group = new Group();
  const topY = DESK_TOP_Y - DESK_SLAB / 2;
  box(group, DESK_W, DESK_SLAB, DESK_D, deskMaterial, 0, topY, 0);
  // Cyan trim along the front (user-facing) edge.
  box(group, DESK_W, 0.006, 0.006, glowCyan, 0, topY, DESK_D / 2 + 0.003);
  // Two slab legs with a recessed modesty panel at the back.
  const legH = DESK_TOP_Y - DESK_SLAB;
  for (const side of [-1, 1]) {
    box(group, 0.05, legH, DESK_D - 0.08, graphite, side * (DESK_W / 2 - 0.08), legH / 2, 0);
    box(group, 0.006, legH * 0.8, 0.006, glowCyanSoft, side * (DESK_W / 2 - 0.08), legH / 2, DESK_D / 2 - 0.035);
  }
  box(group, DESK_W - 0.2, 0.4, 0.02, darkMetal, 0, legH - 0.24, -DESK_D / 2 + 0.06);
  return group;
}

// ---- Wind tunnel ----

const L = TUNNEL_LENGTH;
const H = TUNNEL_HEIGHT;
const D = TUNNEL_DEPTH;
const GLASS = 0.004;
const FLOOR_PLATE = 0.01;
const PLINTH_BOTTOM = DESK_TOP_Y - TUNNEL_ORIGIN_WORLD[1];   // tunnel-local y of the desk top (negative)
const FAN_RADIUS = 0.19;
const HOUSING_LEN = 0.12;

/** Outlet fan, named `tunnel-fan`; spins about its local x axis. */
function createFan(): Group {
  const fan = new Group();
  fan.name = 'tunnel-fan';
  const hub = mesh(new CylinderGeometry(0.035, 0.035, 0.03, 24), brushedMetal);
  hub.rotation.z = Math.PI / 2;
  fan.add(hub);
  const nose = mesh(new SphereGeometry(0.035, 16, 8), brushedMetal, -0.015, 0, 0);
  nose.scale.set(0.6, 1, 1);
  fan.add(nose);
  const bladeGeometry = new BoxGeometry(0.006, 0.14, 0.045);
  const blades = 7;
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2;
    const blade = mesh(bladeGeometry, graphite, 0, Math.cos(a) * 0.105, Math.sin(a) * 0.105);
    blade.rotation.x = a;
    blade.rotation.y = 0.45;   // pitch
    fan.add(blade);
  }
  return fan;
}

/**
 * Desk-top wind tunnel. Origin = tunnel-local origin (inlet, floor, centre of
 * depth); air flows +x through 0..TUNNEL_LENGTH.
 */
export function createWindTunnel(): Group {
  const group = new Group();

  // Glass walls: front (+z, toward the viewer), back (-z, very faint), top.
  box(group, L, H, GLASS, glassMaterial, L / 2, H / 2, D / 2 + GLASS / 2);
  box(group, L, H, GLASS, backGlassMaterial, L / 2, H / 2, -D / 2 - GLASS / 2);
  box(group, L, GLASS, D + 2 * GLASS, glassMaterial, L / 2, H + GLASS / 2, 0);

  // Metal floor plate (top at y = 0) and a plinth down to the desk.
  box(group, L, FLOOR_PLATE, D + 2 * GLASS, darkMetal, L / 2, -FLOOR_PLATE / 2, 0);
  const plinthTop = -FLOOR_PLATE;
  const plinthH = Math.max(0.005, plinthTop - PLINTH_BOTTOM);
  const plinthX0 = -0.05;
  const plinthX1 = L + HOUSING_LEN + 0.03;
  box(group, plinthX1 - plinthX0, plinthH, D + 0.08, graphite,
    (plinthX0 + plinthX1) / 2, plinthTop - plinthH / 2, 0);
  box(group, plinthX1 - plinthX0, 0.005, 0.005, glowCyan,
    (plinthX0 + plinthX1) / 2, plinthTop - plinthH / 2, D / 2 + 0.0425);

  // Cyan edge trims along the four long edges and the inlet/outlet uprights.
  const trim = 0.006;
  for (const z of [D / 2 + GLASS, -D / 2 - GLASS]) {
    box(group, L, trim, trim, glowCyan, L / 2, H + GLASS, z);
    box(group, L, trim, trim, glowCyanSoft, L / 2, 0, z);
    box(group, trim, H, trim, glowCyan, 0, H / 2, z);
    box(group, trim, H, trim, glowCyan, L, H / 2, z);
  }

  // Inlet: honeycomb-style grille frame around the opening at x = 0.
  const frame = 0.03;
  const fx = -0.012;
  const fd = 0.024;
  box(group, fd, frame, D + 2 * frame, graphite, fx, H + frame / 2, 0);
  box(group, fd, frame, D + 2 * frame, graphite, fx, -frame / 2, 0);
  box(group, fd, H, frame, graphite, fx, H / 2, D / 2 + frame / 2);
  box(group, fd, H, frame, graphite, fx, H / 2, -D / 2 - frame / 2);
  // Thin straightener bars across the opening (visual only; the tunnel is never rasterised).
  const barV = new BoxGeometry(0.01, H, 0.0016);
  const barH = new BoxGeometry(0.01, 0.0016, D);
  for (let k = 1; k < 8; k++) group.add(mesh(barV, darkMetal, fx, H / 2, -D / 2 + (k * D) / 8));
  for (let k = 1; k < 10; k++) group.add(mesh(barH, darkMetal, fx, (k * H) / 10, 0));

  // Outlet: square collar at x = L blending into a round fan housing.
  const cx = L + 0.012;
  box(group, fd, frame, D + 2 * frame, graphite, cx, H + frame / 2, 0);
  box(group, fd, frame, D + 2 * frame, graphite, cx, -frame / 2, 0);
  box(group, fd, H, frame, graphite, cx, H / 2, D / 2 + frame / 2);
  box(group, fd, H, frame, graphite, cx, H / 2, -D / 2 - frame / 2);
  const housing = mesh(new CylinderGeometry(FAN_RADIUS, FAN_RADIUS, HOUSING_LEN, 40, 1, true),
    housingMaterial, L + 0.024 + HOUSING_LEN / 2, H / 2, 0);
  housing.rotation.z = Math.PI / 2;
  group.add(housing);
  const ringGeometry = new TorusGeometry(FAN_RADIUS, 0.007, 8, 48);
  for (const x of [L + 0.024, L + 0.024 + HOUSING_LEN]) {
    const ring = mesh(ringGeometry, glowCyan, x, H / 2, 0);
    ring.rotation.y = Math.PI / 2;
    group.add(ring);
  }
  // Housing cradle down to the plinth.
  box(group, HOUSING_LEN * 0.8, 0.03, 0.12, graphite, L + 0.024 + HOUSING_LEN / 2, H / 2 - FAN_RADIUS + 0.005, 0);

  const fan = createFan();
  fan.position.set(L + 0.024 + HOUSING_LEN * 0.55, H / 2, 0);
  group.add(fan);

  return group;
}

// ---- Wind lever ----

const RAIL_LEN = LEVER_RAIL.maxX - LEVER_RAIL.minX;

/** Slotted track for the wind-speed lever. Origin at the rail centre (x/z) and mid-height. */
export function createLeverRail(): Group {
  const group = new Group();
  const baseH = 0.02;
  box(group, RAIL_LEN + 0.05, baseH, 0.05, graphite, 0, 0, 0);
  // Slot: two lips with a dark gap between them.
  box(group, RAIL_LEN + 0.01, 0.004, 0.016, darkMetal, 0, baseH / 2 + 0.0005, 0);
  box(group, RAIL_LEN, 0.002, 0.003, glowCyanSoft, 0, baseH / 2 + 0.002, 0);
  // Tick marks every 10 % on the user-facing side, longer every 50 %.
  const tickShort = new BoxGeometry(0.002, 0.002, 0.008);
  const tickLong = new BoxGeometry(0.003, 0.002, 0.014);
  for (let k = 0; k <= 10; k++) {
    const long = k % 5 === 0;
    const x = -RAIL_LEN / 2 + (k / 10) * RAIL_LEN;
    group.add(mesh(long ? tickLong : tickShort, long ? glowCyan : glowCyanSoft,
      x, baseH / 2 + 0.001, 0.0125 + (long ? 0.004 : 0.001)));
  }
  // End caps: min (left) and max (right, brighter).
  box(group, 0.012, 0.03, 0.054, darkMetal, -RAIL_LEN / 2 - 0.022, 0.005, 0);
  box(group, 0.012, 0.03, 0.054, darkMetal, RAIL_LEN / 2 + 0.022, 0.005, 0);
  box(group, 0.013, 0.004, 0.055, glowCyanSoft, -RAIL_LEN / 2 - 0.022, 0.018, 0);
  box(group, 0.013, 0.004, 0.055, glowCyan, RAIL_LEN / 2 + 0.022, 0.018, 0);
  return group;
}

/** Grippable lever knob (~4 cm). Origin at the knob centre; the stem reaches down into the rail slot. */
export function createLeverKnob(): Group {
  const group = new Group();
  group.add(mesh(new SphereGeometry(0.02, 24, 16), knobGlow));
  const collar = mesh(new TorusGeometry(0.02, 0.003, 8, 32), brushedMetal);
  collar.rotation.x = Math.PI / 2;
  group.add(collar);
  group.add(mesh(new CylinderGeometry(0.005, 0.006, 0.02, 12), brushedMetal, 0, -0.026, 0));
  return group;
}

// ---- Angle dial ----

/** Dial pedestal with an angle scale. Origin at the top face (the knob sits on it). */
export function createDialBase(): Group {
  const group = new Group();
  const pedestalH = 0.04;
  group.add(mesh(new CylinderGeometry(0.06, 0.068, pedestalH, 40), graphite, 0, -pedestalH / 2, 0));
  const ring = mesh(new TorusGeometry(0.058, 0.0025, 6, 48), glowCyanSoft, 0, 0.0005, 0);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  // Ticks every 5 deg across +-30 deg around the forward (-z) direction, long at 0.
  const tickGeometry = new BoxGeometry(0.0018, 0.002, 0.008);
  const zeroGeometry = new BoxGeometry(0.003, 0.002, 0.014);
  for (let deg = -30; deg <= 30; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const zero = deg === 0;
    const r = zero ? 0.05 : 0.052;
    const tick = mesh(zero ? zeroGeometry : tickGeometry, zero ? glowCyan : glowCyanSoft,
      -Math.sin(a) * r, 0.001, -Math.cos(a) * r);
    tick.rotation.y = a;
    group.add(tick);
  }
  return group;
}

/** Knurled twist knob (~7 cm) with a pointer fin aimed at -z. Origin at the knob centre. */
export function createDialKnob(): Group {
  const group = new Group();
  const height = 0.04;
  const radius = 0.033;
  group.add(mesh(new CylinderGeometry(radius, radius, height, 32), darkMetal));
  // Knurl ribs around the grip.
  const rib = new BoxGeometry(0.004, height * 0.86, 0.004);
  const ribs = 24;
  for (let k = 0; k < ribs; k++) {
    const a = (k / ribs) * Math.PI * 2;
    const r = mesh(rib, brushedMetal, Math.cos(a) * radius, 0, Math.sin(a) * radius);
    r.rotation.y = -a;
    group.add(r);
  }
  const cap = mesh(new CylinderGeometry(radius * 0.92, radius * 0.92, 0.004, 32), graphite, 0, height / 2 + 0.002, 0);
  group.add(cap);
  const capRing = mesh(new TorusGeometry(radius * 0.92, 0.0018, 6, 40), glowCyan, 0, height / 2 + 0.004, 0);
  capRing.rotation.x = Math.PI / 2;
  group.add(capRing);
  // Pointer fin across the cap, glowing tip reaching past the rim toward -z.
  box(group, 0.006, 0.012, radius * 1.5, brushedMetal, 0, height / 2 + 0.01, -radius * 0.25);
  box(group, 0.0065, 0.006, 0.012, glowCyan, 0, height / 2 + 0.006, -radius - 0.004);
  return group;
}
