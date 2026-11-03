/**
 * Pack a user's glTF into one self-contained file.
 *
 * A .glb already is one file. A .gltf usually references a .bin and textures
 * by relative URI; those are inlined as base64 data URIs so the result loads
 * from a blob URL (or IndexedDB) with no sibling files. Pure browser APIs
 * only (Blob, File, fetch), so this module is unit-tested in Node.
 */

/** Largest model accepted, in bytes (after inlining). Keeps Quest memory and load times sane. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MODEL_EXTENSIONS = ['.glb', '.gltf'];
const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const RESOURCE_MIME: Record<string, string> = {
  bin: 'application/octet-stream',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ktx2: 'image/ktx2',
  basis: 'image/basis',
};

export interface PackedModel {
  blob: Blob;
  fileName: string;
}

export class ModelImportError extends Error {}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function baseName(path: string): string {
  const clean = path.split(/[?#]/u)[0];
  const slash = clean.lastIndexOf('/');
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const tooLarge = (): ModelImportError =>
  new ModelImportError(`That model is larger than ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB.`);

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

interface GltfJson {
  asset?: { version?: string };
  buffers?: Array<{ uri?: string }>;
  images?: Array<{ uri?: string }>;
}

/**
 * Rewrite a .gltf so every external buffer and image is inlined. `resolve`
 * returns the bytes of a relative URI (a sibling file or a relative URL),
 * or null when it cannot be found.
 */
export async function inlineGltf(
  gltfText: string,
  resolve: (uri: string) => Promise<ArrayBuffer | null>,
): Promise<Blob> {
  let json: GltfJson;
  try {
    json = JSON.parse(gltfText) as GltfJson;
  } catch {
    throw new ModelImportError('That .gltf file is not valid JSON.');
  }
  if (!json.asset?.version) throw new ModelImportError('That file does not look like glTF (no asset.version).');

  const missing: string[] = [];
  const inline = async (items: Array<{ uri?: string }> | undefined) => {
    if (!items) return;
    for (const item of items) {
      const uri = item.uri;
      if (!uri || uri.startsWith('data:')) continue;
      const bytes = await resolve(uri);
      if (!bytes) {
        missing.push(baseName(uri));
        continue;
      }
      const mime = RESOURCE_MIME[extensionOf(uri).slice(1)] ?? 'application/octet-stream';
      item.uri = `data:${mime};base64,${toBase64(bytes)}`;
    }
  };
  await inline(json.buffers);
  await inline(json.images);
  if (missing.length > 0) {
    throw new ModelImportError(
      `The .gltf references files that were not provided: ${missing.join(', ')}. ` +
        'Select them together with the .gltf, or export a single .glb instead.',
    );
  }
  return new Blob([JSON.stringify(json)], { type: 'model/gltf+json' });
}

/** Pack a file selection (one .glb, or a .gltf plus its .bin / textures) into one self-contained file. */
export async function packModelFiles(files: File[]): Promise<PackedModel> {
  const main = files.find((f) => MODEL_EXTENSIONS.includes(extensionOf(f.name)));
  if (!main) throw new ModelImportError('Choose a .glb or .gltf file.');
  if (main.size > MAX_IMPORT_BYTES) throw tooLarge();
  if (extensionOf(main.name) === '.glb') return { blob: main, fileName: main.name };

  const siblings = new Map<string, File>();
  for (const f of files) siblings.set(f.name, f);
  const blob = await inlineGltf(await main.text(), async (uri) => {
    const file = siblings.get(baseName(uri));
    return file ? file.arrayBuffer() : null;
  });
  if (blob.size > MAX_IMPORT_BYTES) throw tooLarge();
  return { blob, fileName: main.name };
}

/** Download a model from a URL (the server must allow cross-origin requests). */
export async function fetchModelFromUrl(url: string, base: string = location.href): Promise<PackedModel> {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    throw new ModelImportError('That is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ModelImportError('Only http(s) URLs can be loaded.');
  }
  const fileName = baseName(parsed.pathname) || 'model.glb';
  const response = await fetch(parsed.href, { mode: 'cors' }).catch(() => null);
  if (!response || !response.ok) {
    throw new ModelImportError(
      `Could not download ${fileName}. The server must be reachable and send CORS headers.`,
    );
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw tooLarge();

  const isGlb =
    extensionOf(fileName) === '.glb' || (bytes.byteLength >= 4 && new DataView(bytes).getUint32(0, true) === GLB_MAGIC);
  if (isGlb) return { blob: new Blob([bytes], { type: 'model/gltf-binary' }), fileName };

  const blob = await inlineGltf(new TextDecoder().decode(bytes), async (uri) => {
    const res = await fetch(new URL(uri, parsed.href).href, { mode: 'cors' }).catch(() => null);
    return res && res.ok ? res.arrayBuffer() : null;
  });
  if (blob.size > MAX_IMPORT_BYTES) throw tooLarge();
  return { blob, fileName };
}
