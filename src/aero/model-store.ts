/**
 * On-device storage for the user's imported model (IndexedDB).
 *
 * One record is kept: the self-contained glTF file plus its settings, so the
 * model survives a reload and is available after entering XR, where the file
 * picker cannot be used. Nothing is uploaded anywhere.
 */

import type { CustomModelMeta } from './lab-state.js';

const DB_NAME = 'virtuforge-aerolab';
const DB_VERSION = 1;
const STORE = 'models';
const KEY = 'custom';

export interface StoredModel {
  /** A .glb, or a .gltf whose buffers and images are inlined as data URIs. */
  blob: Blob;
  fileName: string;
  meta: CustomModelMeta;
  savedAt: number;
}

export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!storageAvailable()) {
      reject(new Error('This browser has no IndexedDB, so an imported model cannot be kept.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the model store'));
    request.onblocked = () => reject(new Error('The model store is blocked by another tab'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Model store request failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const result = await run(tx.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Model store transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Model store transaction aborted'));
    });
    return result;
  } finally {
    db.close();
  }
}

export async function loadStoredModel(): Promise<StoredModel | null> {
  if (!storageAvailable()) return null;
  const record = await withStore('readonly', (store) => requestToPromise(store.get(KEY)));
  if (!record || typeof record !== 'object') return null;
  const stored = record as Partial<StoredModel>;
  if (!(stored.blob instanceof Blob) || !stored.meta || typeof stored.fileName !== 'string') return null;
  return stored as StoredModel;
}

export async function saveStoredModel(model: StoredModel): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put(model, KEY));
  });
}

export async function updateStoredMeta(meta: CustomModelMeta): Promise<void> {
  await withStore('readwrite', async (store) => {
    const existing = (await requestToPromise(store.get(KEY))) as StoredModel | undefined;
    if (!existing) return;
    await requestToPromise(store.put({ ...existing, meta }, KEY));
  });
}

export async function deleteStoredModel(): Promise<void> {
  if (!storageAvailable()) return;
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.delete(KEY));
  });
}
