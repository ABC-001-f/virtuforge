import type { GltfOrientation } from './catalog.js';
import type { CarId, CarParam, CarParams, ModelId, ModelKind, ViewMode } from './types.js';

/**
 * Shared lab state. Systems read it freely; whoever changes something calls
 * emit() with the matching event so the owning system reacts.
 *
 * Owners:
 *   WindTunnelSystem (src/wind-tunnel.ts)    - model, solver, flow visuals, metrics, handle/part anchors, explode, ghost
 *   ControlsSystem   (src/controls.ts)       - wind lever, angle dial, shape-handle and part-handle entities
 *   UiSystem         (src/ui.ts)             - panels, buttons, readouts, compare bars, report
 *   ImportOverlay    (src/import-overlay.ts) - the browser-side import panel (custom model, part visibility)
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

/** One part of the current model (world-space centre), published by WindTunnelSystem. */
export interface PartWorld {
  index: number;
  name: string;
  world: [number, number, number];
  hidden: boolean;
  /** False for the smallest parts of a very detailed model: listed, but no grab handle. */
  handle: boolean;
}

/** Per-part edit. The offset is in the part's parent frame, in the model's native units. */
export interface PartEdit {
  offset: [number, number, number];
  hidden: boolean;
}

/** Settings of the user's imported model. Persisted with the file (src/aero/model-store.ts). */
export interface CustomModelMeta {
  /** Display name, usually the file name. */
  name: string;
  kind: ModelKind;
  orientation: Required<GltfOrientation>;
  /** Turn the model round so the nose faces the other way (applied after the yaw). */
  flipNose: boolean;
  /** Part edits for this model, by part index. */
  parts: Record<number, PartEdit>;
}

export type LabEvent =
  | 'model'          // modelId changed
  | 'shape'          // carParams changed (continuous while dragging a handle)
  | 'angle'          // angleDeg changed
  | 'wind'           // windKmh or windOn changed
  | 'view'           // view mode changed
  | 'skin'           // pressure skin toggled
  | 'explode'        // exploded toggled
  | 'saveA'          // store current design as A (WindTunnelSystem fills savedA and shows a ghost)
  | 'clearA'         // forget design A
  | 'handles'        // handleAnchors republished
  | 'parts'          // partAnchors republished (also after a part was hidden or shown)
  | 'partEdit'       // partEditing toggled
  | 'partMove'       // a part edit's offset changed (continuous while dragging)
  | 'partVisibility' // a part edit's hidden flag changed
  | 'resetParts'     // forget every part edit of the current model
  | 'custom'         // the imported model (or its settings) changed; lab.customModel is null once removed
  | 'metrics'        // metrics updated (~4 Hz)
  | 'status';        // status text changed

export const DEFAULT_CAR_PARAMS: Record<CarId, CarParams> = {
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
  /** Part-edit mode: part handles replace the shape handles so parts can be moved by hand. */
  partEditing: false,
  partAnchors: [] as PartWorld[],
  /** Part index currently being dragged (ControlsSystem sets it) - WindTunnelSystem won't republish that anchor. */
  draggingPart: null as number | null,
  /** World position of the dragged part handle (ControlsSystem writes it before every 'partMove'). */
  partDragWorld: [0, 0, 0] as [number, number, number],
  /** Edits for every model, keyed by partKey(modelId, index). */
  partEdits: new Map<string, PartEdit>(),
  /** The user's imported model, or null when none is stored on this device. */
  customModel: null as CustomModelMeta | null,
  /** One-line status for the control panel (e.g. "Loading Toy Car...", "Flow settling..."). */
  status: 'Ready',
};

export const ANGLE_LIMITS: [number, number] = [-15, 20];

export function partKey(modelId: ModelId, index: number): string {
  return `${modelId}:${index}`;
}

/** The edit record for a part of one model, created on first use. */
export function partEdit(modelId: ModelId, index: number): PartEdit {
  const key = partKey(modelId, index);
  let edit = lab.partEdits.get(key);
  if (!edit) {
    edit = { offset: [0, 0, 0], hidden: false };
    lab.partEdits.set(key, edit);
  }
  return edit;
}

/** Edits of one model, by part index (only the ones that differ from the rest state). */
export function partEditsOf(modelId: ModelId): Record<number, PartEdit> {
  const prefix = `${modelId}:`;
  const out: Record<number, PartEdit> = {};
  for (const [key, edit] of lab.partEdits) {
    if (!key.startsWith(prefix)) continue;
    const [x, y, z] = edit.offset;
    if (!edit.hidden && x === 0 && y === 0 && z === 0) continue;
    out[Number(key.slice(prefix.length))] = { offset: [x, y, z], hidden: edit.hidden };
  }
  return out;
}

/** Replace the edits of one model. */
export function setPartEdits(modelId: ModelId, edits: Record<number, PartEdit>): void {
  clearPartEdits(modelId);
  for (const [index, edit] of Object.entries(edits)) {
    lab.partEdits.set(partKey(modelId, Number(index)), {
      offset: [edit.offset[0], edit.offset[1], edit.offset[2]],
      hidden: edit.hidden,
    });
  }
}

/** Drop every edit of one model. */
export function clearPartEdits(modelId: ModelId): void {
  const prefix = `${modelId}:`;
  for (const key of [...lab.partEdits.keys()]) {
    if (key.startsWith(prefix)) lab.partEdits.delete(key);
  }
}

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
