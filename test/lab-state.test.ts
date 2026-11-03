import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTOM_MODEL_ID, GLTF_MODELS } from '../src/aero/catalog.js';
import { clearPartEdits, emit, lab, on, partEdit, partEditsOf, setPartEdits } from '../src/aero/lab-state.js';
import { isCarId, MODEL_CATALOG, modelInfo } from '../src/aero/types.js';

test('every catalog glTF entry is well formed and has a picker entry', () => {
  const ids = new Set<string>();
  for (const entry of GLTF_MODELS) {
    assert.match(entry.id, /^[a-z0-9-]+$/u, `id "${entry.id}" must be lowercase with no spaces`);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.file, /\.(glb|gltf)$/u, `${entry.id}: file must be a .glb or .gltf`);
    assert.ok(!entry.file.startsWith('/'), `${entry.id}: file path is relative to public/`);
    assert.equal(modelInfo(entry.id).source, 'gltf');
    assert.ok(!isCarId(entry.id));
  }
  assert.equal(modelInfo(CUSTOM_MODEL_ID).source, 'custom');
  assert.equal(new Set(MODEL_CATALOG.map((m) => m.id)).size, MODEL_CATALOG.length);
});

test('part edits are keyed per model and only non-trivial ones are exported', () => {
  clearPartEdits('drone');
  clearPartEdits('wing');
  partEdit('drone', 2).offset = [0.1, 0, 0];
  partEdit('drone', 5).hidden = true;
  partEdit('drone', 7); // untouched
  partEdit('wing', 1).hidden = true;

  const drone = partEditsOf('drone');
  assert.deepEqual(Object.keys(drone).sort(), ['2', '5']);
  assert.deepEqual(drone[2].offset, [0.1, 0, 0]);
  assert.equal(drone[5].hidden, true);
  assert.deepEqual(Object.keys(partEditsOf('wing')), ['1']);

  setPartEdits('drone', { 3: { offset: [0, 0.2, 0], hidden: false } });
  assert.deepEqual(Object.keys(partEditsOf('drone')), ['3']);
  assert.deepEqual(Object.keys(partEditsOf('wing')), ['1'], 'other models keep their edits');

  clearPartEdits('drone');
  clearPartEdits('wing');
  assert.deepEqual(partEditsOf('drone'), {});
});

test('events reach listeners until they unsubscribe', () => {
  let hits = 0;
  const off = on('partEdit', () => hits++);
  emit('partEdit');
  off();
  emit('partEdit');
  assert.equal(hits, 1);
  assert.equal(lab.modelId, 'ev');
});
