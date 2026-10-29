import type { CarParam, CarParams, ModelId, ViewMode } from './types.js';

/**
 * Shared lab state. Systems read it freely; whoever changes something calls
 * emit() with the matching event so the owning system reacts.
 *
 * Owners:
 *   WindTunnelSystem (src/wind-tunnel.ts) - model, solver, flow visuals, metrics, handle anchors, explode, ghost
 *   ControlsSystem   (src/controls.ts)    - wind lever, angle dial, shape-handle entities
 *   UiSystem         (src/ui.ts)          - panels, buttons, readouts, compare bars, report
 */

export interface Metrics {
  cd: number;              // time-averaged drag coefficient (2D, relative)
  cl: number;              // time-averaged lift coefficient (2D, relative)
  re: number;              // lattice Reynolds number
  stepsPerSecond: number;  // solver speed
  settled: boolean;        // true once the flow has run long enough for a fair reading
}

export interface SavedDesign {
  modelId: ModelId;
  label: string;
  cd: number;
  cl: number;
  windKmh: number;
  angleDeg: number;
  carParams: CarParams | null;
}

/** World-space shape handle published by WindTunnelSystem for ControlsSystem. */
export interface HandleWorld {
  param: CarParam;
  axis: 'x' | 'y';
  world: [number, number, number];
  /** World metres of handle travel per 1.0 change of the parameter. */
  metresPerUnit: number;
}

export type LabEvent =
  | 'model'      // modelId changed
  | 'shape'      // carParams changed (continuous while dragging a handle)
  | 'angle'      // angleDeg changed
  | 'wind'       // windKmh or windOn changed
  | 'view'       // view mode changed
  | 'skin'       // pressure skin toggled
  | 'explode'    // exploded toggled
  | 'saveA'      // store current design as A (WindTunnelSystem fills savedA and shows a ghost)
  | 'clearA'     // forget design A
  | 'handles'    // handleAnchors republished
  | 'metrics'    // metrics updated (~4 Hz)
  | 'status';    // status text changed

export const DEFAULT_CAR_PARAMS: Record<'ev' | 'sport' | 'van', CarParams> = {
  ev: { noseHeight: 0.18, roofHeight: 0.33, roofPeak: 0.5, tailHeight: 0.24, rideHeight: 0.04, width: 0.42 },
  sport: { noseHeight: 0.12, roofHeight: 0.25, roofPeak: 0.55, tailHeight: 0.18, rideHeight: 0.03, width: 0.44 },
  van: { noseHeight: 0.3, roofHeight: 0.46, roofPeak: 0.42, tailHeight: 0.4, rideHeight: 0.06, width: 0.46 },
};

export const lab = {
  modelId: 'ev' as ModelId,
  /** Shape of the current parametric car (null for non-car models). */
  carParams: { ...DEFAULT_CAR_PARAMS.ev } as CarParams | null,
  windOn: true,
  windKmh: 90,
  angleDeg: 0,             // pitch / angle of attack, -15 .. +20
  view: 'smoke' as ViewMode,
  skin: false,
  exploded: false,
  metrics: { cd: 0, cl: 0, re: 0, stepsPerSecond: 0, settled: false } as Metrics,
  savedA: null as SavedDesign | null,
  handleAnchors: [] as HandleWorld[],
  /** Param currently being dragged (ControlsSystem sets it) - WindTunnelSystem won't republish that handle. */
  draggingParam: null as CarParam | null,
  /** One-line status for the control panel (e.g. "Loading Toy Car...", "Flow settling..."). */
  status: 'Ready',
};

export const ANGLE_LIMITS: [number, number] = [-15, 20];

type Listener = () => void;
const listeners = new Map<LabEvent, Set<Listener>>();

export function on(event: LabEvent, listener: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener);
  return () => set!.delete(listener);
}

export function emit(event: LabEvent): void {
  listeners.get(event)?.forEach((listener) => listener());
}
