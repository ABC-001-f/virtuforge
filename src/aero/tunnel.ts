/**
 * Wind tunnel geometry shared by the solver, the visuals and the scene.
 *
 * TUNNEL-LOCAL FRAME (the `tunnel` scene node's object3D):
 *   origin = inlet, floor, centre of depth
 *   +x = downstream (air flows +x), 0 .. TUNNEL_LENGTH
 *   +y = up, 0 (floor) .. TUNNEL_HEIGHT
 *   z  = across the tunnel, -TUNNEL_DEPTH/2 .. +TUNNEL_DEPTH/2
 * Solver grid cell (i, j) covers x in [i*CELL, (i+1)*CELL), y in [j*CELL, (j+1)*CELL).
 * Grid arrays are row-major: index = j * GRID_NX + i (j = 0 is the floor row).
 */

export const GRID_NX = 240;
export const GRID_NY = 96;
export const CELL = 0.004;                       // metres per lattice cell
export const TUNNEL_LENGTH = GRID_NX * CELL;     // 0.96 m
export const TUNNEL_HEIGHT = GRID_NY * CELL;     // 0.384 m
export const TUNNEL_DEPTH = 0.32;

/** World position of the tunnel-local origin (inlet floor centre). Tunnel is centred on x = 0. */
export const TUNNEL_ORIGIN_WORLD: [number, number, number] = [-TUNNEL_LENGTH / 2, 0.86, -0.62];

/** Models are scaled so their length (x extent) is this, and their nose sits at MODEL_NOSE_X. */
export const MODEL_TARGET_LENGTH = 0.34;
export const MODEL_NOSE_X = 0.24;

/** Lattice viscosity used by the solver (Lbm default). */
export const LATTICE_VISCOSITY = 0.012;

export const MIN_WIND_KMH = 20;
export const MAX_WIND_KMH = 200;

/** Map a displayed wind speed to the solver's lattice inlet velocity (kept <= 0.11 for stability). */
export function windToLattice(kmh: number): number {
  const t = (Math.min(MAX_WIND_KMH, Math.max(MIN_WIND_KMH, kmh)) - MIN_WIND_KMH) / (MAX_WIND_KMH - MIN_WIND_KMH);
  return 0.03 + t * 0.08;
}

/** On-screen speed of smoke particles (m/s) when the local flow equals the inlet speed. */
export const VISUAL_FLOW_SPEED = 0.35;

// ---- Desk layout (world metres; player sits at the origin facing -z) ----

/** Desk top height. The tunnel base sits on it; TUNNEL_ORIGIN_WORLD[1] is the tunnel floor. */
export const DESK_TOP_Y = 0.82;

/** Wind-speed lever: the `wind-lever` knob slides along world x between minX and maxX at fixed y, z. */
export const LEVER_RAIL = { minX: 0.52, maxX: 0.82, y: 0.86, z: -0.36 };

/** Angle dial knob (`angle-dial`) world position; you twist it about its vertical axis. */
export const DIAL_POSITION: [number, number, number] = [-0.66, 0.88, -0.36];
