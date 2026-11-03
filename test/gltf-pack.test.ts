import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseName, extensionOf, inlineGltf, ModelImportError, packModelFiles } from '../src/aero/gltf-pack.js';

const minimalGltf = (uris: { buffer?: string; image?: string }) =>
  JSON.stringify({
    asset: { version: '2.0' },
    buffers: uris.buffer ? [{ uri: uris.buffer, byteLength: 4 }] : [],
    images: uris.image ? [{ uri: uris.image }] : [],
  });

test('name helpers', () => {
  assert.equal(extensionOf('Car.GLB'), '.glb');
  assert.equal(extensionOf('noext'), '');
  assert.equal(baseName('https://x.test/a/b/My%20Car.gltf?v=1#top'), 'My Car.gltf');
  assert.equal(baseName('textures/paint.png'), 'paint.png');
});

test('a .glb passes through untouched', async () => {
  const glb = new File([new Uint8Array([1, 2, 3])], 'car.glb');
  const packed = await packModelFiles([glb]);
  assert.equal(packed.fileName, 'car.glb');
  assert.equal(packed.blob, glb);
});

test('a .gltf with its .bin and texture becomes one self-contained file', async () => {
  const gltf = new File([minimalGltf({ buffer: 'scene.bin', image: 'tex/paint.png' })], 'scene.gltf');
  const bin = new File([new Uint8Array([0, 1, 2, 3])], 'scene.bin');
  const png = new File([new Uint8Array([9, 9])], 'paint.png');
  const packed = await packModelFiles([png, gltf, bin]);
  const json = JSON.parse(await packed.blob.text()) as { buffers: Array<{ uri: string }>; images: Array<{ uri: string }> };
  assert.equal(json.buffers[0].uri, 'data:application/octet-stream;base64,AAECAw==');
  assert.equal(json.images[0].uri, 'data:image/png;base64,CQk=');
});

test('a .gltf with a missing sibling is rejected with the file name', async () => {
  const gltf = new File([minimalGltf({ buffer: 'scene.bin' })], 'scene.gltf');
  await assert.rejects(packModelFiles([gltf]), (err: unknown) => {
    assert.ok(err instanceof ModelImportError);
    assert.match(err.message, /scene\.bin/u);
    return true;
  });
});

test('non-model selections and non-glTF JSON are rejected', async () => {
  await assert.rejects(packModelFiles([new File(['x'], 'notes.txt')]), ModelImportError);
  await assert.rejects(inlineGltf('{"hello":1}', async () => null), ModelImportError);
  await assert.rejects(inlineGltf('not json', async () => null), ModelImportError);
});

test('data URIs are left alone', async () => {
  const blob = await inlineGltf(minimalGltf({ buffer: 'data:application/octet-stream;base64,AAAA' }), async () => {
    throw new Error('should not resolve');
  });
  const json = JSON.parse(await blob.text()) as { buffers: Array<{ uri: string }> };
  assert.equal(json.buffers[0].uri, 'data:application/octet-stream;base64,AAAA');
});
