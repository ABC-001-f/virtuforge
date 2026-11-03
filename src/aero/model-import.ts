/**
 * Bring your own model: keep the user's glTF on this device and hand
 * WindTunnelSystem a ready-to-place scene graph.
 *
 * - src/aero/gltf-pack.ts turns a file selection or a URL into one
 *   self-contained file (a .glb, or a .gltf with its resources inlined).
 * - The staged glTF lives in its own AssetManager load transaction. Replacing
 *   or removing the model rolls that transaction back, which frees its GPU
 *   resources without touching the shared asset cache.
 * - orientModel wraps any glTF scene so its long axis runs along x with the
 *   nose upstream (-x), which is the frame the tunnel expects.
 *
 * Imported files never leave the browser: the store is IndexedDB.
 */

import { AssetManager, Box3, Group } from '@iwsdk/core';
import type { GLTFLoadTransaction, Object3D } from '@iwsdk/core';
import { CUSTOM_MODEL_ID } from './catalog.js';
import type { GltfOrientation } from './catalog.js';
import { MAX_IMPORT_BYTES, ModelImportError } from './gltf-pack.js';
import type { PackedModel } from './gltf-pack.js';
import { emit, lab, on, partEditsOf, setPartEdits } from './lab-state.js';
import type { CustomModelMeta } from './lab-state.js';
import {
  deleteStoredModel,
  loadStoredModel,
  saveStoredModel,
  storageAvailable,
  updateStoredMeta,
} from './model-store.js';
import type { StoredModel } from './model-store.js';
import type { ModelKind } from './types.js';

export { fetchModelFromUrl, MAX_IMPORT_BYTES, ModelImportError, packModelFiles } from './gltf-pack.js';
export type { PackedModel } from './gltf-pack.js';

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

export interface OrientedModel {
  /** Plain root to hand to the tunnel; the orientation lives in its children. */
  root: Group;
  /** The yaw that was applied (resolved when the catalog entry said "auto"). */
  yawQuarterTurns: 0 | 1 | 2 | 3;
}

/**
 * Wrap a glTF scene so +y is up and its long axis runs along x. With no
 * explicit yaw the longer horizontal axis is turned onto x. `flipNose` turns
 * the model round for files whose nose came out facing downstream.
 */
export function orientModel(scene: Object3D, orientation: GltfOrientation | undefined, flipNose = false): OrientedModel {
  const upFix = new Group();
  upFix.name = 'up-axis';
  upFix.add(scene);
  if (orientation?.up === 'z') upFix.rotation.x = -Math.PI / 2;

  let yaw = orientation?.yawQuarterTurns;
  if (yaw === undefined) {
    const box = new Box3().setFromObject(upFix);
    yaw = box.max.z - box.min.z > box.max.x - box.min.x ? 1 : 0;
  }

  const yawGroup = new Group();
  yawGroup.name = 'yaw';
  yawGroup.rotation.y = (((yaw + (flipNose ? 2 : 0)) % 4) * Math.PI) / 2;
  yawGroup.add(upFix);

  const root = new Group();
  root.add(yawGroup);
  return { root, yawQuarterTurns: yaw };
}

// ---------------------------------------------------------------------------
// The user's model
// ---------------------------------------------------------------------------

/** A staged custom model: ask it for fresh clones, dispose it when replaced. */
export interface CustomModelHandle {
  meta: CustomModelMeta;
  fileName: string;
  bytes: number;
  /** A new scene-graph clone sharing the staged geometry and materials. */
  cloneScene(): Object3D;
  dispose(): void;
}

let handle: CustomModelHandle | null = null;
let pendingLoad: Promise<CustomModelHandle | null> | null = null;
let metaSaveTimer: ReturnType<typeof setTimeout> | null = null;
let revision = 0;

async function stage(record: StoredModel): Promise<CustomModelHandle> {
  const url = URL.createObjectURL(record.blob);
  const key = `${CUSTOM_MODEL_ID}:${++revision}`;
  let tx: GLTFLoadTransaction | null = null;
  try {
    tx = AssetManager.createGLTFLoadTransaction({
      maxModelPayloadBytes: MAX_IMPORT_BYTES,
      maxTotalModelPayloadBytes: MAX_IMPORT_BYTES,
    });
    await tx.stage(url, key);
  } catch (err) {
    tx?.rollback();
    const reason = err instanceof Error ? err.message : String(err);
    throw new ModelImportError(`The model could not be parsed: ${reason}`);
  } finally {
    URL.revokeObjectURL(url);
  }
  const staged = tx;
  return {
    meta: record.meta,
    fileName: record.fileName,
    bytes: record.blob.size,
    cloneScene() {
      const gltf = staged.getGLTF(key);
      if (!gltf) throw new ModelImportError('The imported model is no longer loaded.');
      return gltf.scene;
    },
    dispose() {
      staged.rollback();
    },
  };
}

/** The staged custom model, loading it from the device store on first use. */
export function getCustomModel(): Promise<CustomModelHandle | null> {
  if (handle) return Promise.resolve(handle);
  if (pendingLoad) return pendingLoad;
  pendingLoad = (async () => {
    const record = await loadStoredModel().catch((err: unknown) => {
      console.warn('[ModelImport] could not read the stored model', err);
      return null;
    });
    if (!record) return null;
    handle = await stage(record);
    return handle;
  })().finally(() => {
    pendingLoad = null;
  });
  return pendingLoad;
}

/** Restore lab.customModel from the device store at start-up and tell the UI. */
export async function initCustomModel(): Promise<void> {
  const loaded = await getCustomModel().catch((err: unknown) => {
    console.warn('[ModelImport] stored model is unusable', err);
    return null;
  });
  lab.customModel = loaded ? loaded.meta : null;
  if (loaded) setPartEdits(CUSTOM_MODEL_ID, loaded.meta.parts);
  emit('custom');

  // Keep the stored settings in step with part edits made in the tunnel.
  const persist = () => {
    if (lab.modelId !== CUSTOM_MODEL_ID || lab.draggingPart !== null || !lab.customModel) return;
    lab.customModel.parts = partEditsOf(CUSTOM_MODEL_ID);
    scheduleMetaSave();
  };
  on('partMove', persist);
  on('partVisibility', persist);
  on('resetParts', persist);
}

function scheduleMetaSave(): void {
  if (metaSaveTimer) clearTimeout(metaSaveTimer);
  metaSaveTimer = setTimeout(() => {
    metaSaveTimer = null;
    const meta = lab.customModel;
    if (!meta) return;
    if (handle) handle.meta = meta;
    updateStoredMeta(meta).catch((err: unknown) => console.warn('[ModelImport] could not save settings', err));
  }, 300);
}

export function defaultMeta(name: string, kind: ModelKind = 'ground'): CustomModelMeta {
  return {
    name,
    kind,
    orientation: { up: 'y', yawQuarterTurns: 0 },
    flipNose: false,
    parts: {},
  };
}

/**
 * Store a packed model as the user's model, stage it and announce it.
 * The previous custom model (if any) is disposed. Part edits start empty.
 */
export async function importCustomModel(packed: PackedModel, kind: ModelKind = 'ground'): Promise<CustomModelMeta> {
  if (!storageAvailable()) {
    throw new ModelImportError('This browser cannot keep an imported model (no IndexedDB). Try another browser.');
  }
  const name = packed.fileName.replace(/\.(glb|gltf)$/iu, '');
  const meta = defaultMeta(name, kind);
  const record: StoredModel = { blob: packed.blob, fileName: packed.fileName, meta, savedAt: Date.now() };

  // Stage first so a broken file is rejected before anything is overwritten.
  const next = await stage(record);
  const auto = orientModel(next.cloneScene(), { up: 'y' });
  meta.orientation.yawQuarterTurns = auto.yawQuarterTurns;

  await saveStoredModel(record);
  handle?.dispose();
  handle = next;
  lab.customModel = meta;
  setPartEdits(CUSTOM_MODEL_ID, {});
  emit('custom');
  return meta;
}

/** Apply new settings (kind, orientation, nose flip) to the stored model. */
export function updateCustomModel(patch: {
  kind?: ModelKind;
  orientation?: GltfOrientation;
  flipNose?: boolean;
}): void {
  const meta = lab.customModel;
  if (!meta) return;
  if (patch.kind) meta.kind = patch.kind;
  if (patch.orientation) meta.orientation = { ...meta.orientation, ...patch.orientation };
  if (patch.flipNose !== undefined) meta.flipNose = patch.flipNose;
  scheduleMetaSave();
  emit('custom');
}

/** Forget the user's model on this device. */
export async function removeCustomModel(): Promise<void> {
  await deleteStoredModel();
  handle?.dispose();
  handle = null;
  lab.customModel = null;
  setPartEdits(CUSTOM_MODEL_ID, {});
  emit('custom');
}
