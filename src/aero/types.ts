import type { Group, Object3D, Vector3 } from '@iwsdk/core';

export type ModelId = 'ev' | 'sport' | 'van' | 'airplane' | 'drone' | 'wing' | 'toycar';
/** Ground vehicles sit on the tunnel floor; air vehicles are centred in the tunnel height. */
export type ModelKind = 'ground' | 'air';
export type ViewMode = 'smoke' | 'speed' | 'pressure';

export interface ModelInfo {
  id: ModelId;
  label: string;
  kind: ModelKind;
  source: 'procedural' | 'gltf';
  credit?: string;
}

export const MODEL_CATALOG: ModelInfo[] = [
  { id: 'ev', label: 'EV Sedan', kind: 'ground', source: 'procedural' },
  { id: 'sport', label: 'Sports Car', kind: 'ground', source: 'procedural' },
  { id: 'van', label: 'Delivery Van', kind: 'ground', source: 'procedural' },
  { id: 'airplane', label: 'Airplane', kind: 'air', source: 'procedural' },
  { id: 'drone', label: 'Drone', kind: 'air', source: 'procedural' },
  { id: 'wing', label: 'Wing NACA 2412', kind: 'air', source: 'procedural' },
  {
    id: 'toycar',
    label: 'Toy Car (imported glTF)',
    kind: 'ground',
    source: 'gltf',
    credit: 'ToyCar by Guido Odendahl & Eric Chadwick, CC0 (Khronos glTF Sample Assets)',
  },
];

/**
 * Parametric car shape. All values are fractions of the car length (car is built at length 1).
 * Built car frame: nose toward -x (upstream), ground contact at y = 0, centred on z = 0.
 */
export interface CarParams {
  noseHeight: number;   // height of the front bumper top            0.10 .. 0.32
  roofHeight: number;   // highest point of the cabin                 0.22 .. 0.48
  roofPeak: number;     // where along the length the roof peaks      0.35 .. 0.65
  tailHeight: number;   // height of the rear end top                 0.12 .. 0.40
  rideHeight: number;   // ground clearance                           0.02 .. 0.08
  width: number;        // body width                                 0.36 .. 0.50
}

export type CarParam = keyof CarParams;

export const CAR_PARAM_LIMITS: Record<CarParam, [number, number]> = {
  noseHeight: [0.1, 0.32],
  roofHeight: [0.22, 0.48],
  roofPeak: [0.35, 0.65],
  tailHeight: [0.12, 0.4],
  rideHeight: [0.02, 0.08],
  width: [0.36, 0.5],
};

/** A grabbable shape handle, in the built model's own (unscaled) frame. */
export interface HandleAnchor {
  param: CarParam;
  axis: 'x' | 'y';      // which model axis dragging the handle changes
  local: Vector3;       // handle position in model-local units (car length = 1)
}

/** What every model builder returns. */
export interface BuiltModel {
  /** Parentless root at native scale, oriented per the frame rules above (nose toward -x). */
  root: Group;
  /** Separable parts for the exploded view, each a direct child of root. Empty = explode meshes generically. */
  parts: Object3D[];
  /** Shape handles (parametric cars only). */
  handles: HandleAnchor[];
}
