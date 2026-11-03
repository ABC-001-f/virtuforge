/**
 * Bring-your-own-model catalog.
 *
 * To ship a glTF model with the app:
 *   1. copy the .glb (or a self-contained .gltf) into public/models/
 *   2. add one entry below
 *   3. add a `<Button id="model-<id>">` to public/ui/control.uikitml
 *
 * `src/assets.ts` registers every entry with the asset manager and
 * `src/aero/types.ts` adds it to the model picker, so nothing else changes.
 * Keep this module pure: it is imported by both the runtime and the editor.
 */

import type { ModelKind } from './types.js';

/** How the model is oriented in its own file. The tunnel wants the nose toward -x and +y up. */
export interface GltfOrientation {
  /** Which axis points up in the file. glTF is +y up by convention; some exporters write +z. */
  up?: 'y' | 'z';
  /**
   * Rotation about the vertical axis, in quarter turns (0..3), applied after the
   * up-axis fix. Leave undefined to auto-detect the long axis and put the nose at -x.
   */
  yawQuarterTurns?: 0 | 1 | 2 | 3;
}

export interface GltfModelEntry {
  /** Unique id, used for the button (`model-<id>`) and the asset key. Lowercase, no spaces. */
  id: string;
  /** Label shown on the control panel readout. */
  label: string;
  /** Ground vehicles sit on the tunnel floor; air vehicles are centred in the tunnel. */
  kind: ModelKind;
  /** Path under public/, for example `models/MyCar.glb`. */
  file: string;
  /** Attribution shown on the results panel whenever the model is in the tunnel. */
  credit?: string;
  orientation?: GltfOrientation;
}

export const GLTF_MODELS: GltfModelEntry[] = [
  {
    id: 'toycar',
    label: 'Toy Car (imported glTF)',
    kind: 'ground',
    file: 'models/ToyCar.glb',
    credit: 'ToyCar by Guido Odendahl & Eric Chadwick, CC0 (Khronos glTF Sample Assets)',
  },
];

/** Reserved id for the model a user imports at runtime (see src/aero/model-import.ts). */
export const CUSTOM_MODEL_ID = 'custom';
