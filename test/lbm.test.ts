import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lbm } from '../src/aero/lbm.js';
import { GRID_NX, GRID_NY, MAX_WIND_KMH, MIN_WIND_KMH, windToLattice } from '../src/aero/tunnel.js';

test('windToLattice maps the lever range onto a stable inlet speed', () => {
  assert.equal(windToLattice(MIN_WIND_KMH), 0.03);
  assert.ok(Math.abs(windToLattice(MAX_WIND_KMH) - 0.11) < 1e-12);
  assert.equal(windToLattice(MIN_WIND_KMH - 50), windToLattice(MIN_WIND_KMH));
  assert.equal(windToLattice(MAX_WIND_KMH + 50), windToLattice(MAX_WIND_KMH));
});

test('empty tunnel keeps uniform flow with no force', () => {
  const lbm = new Lbm(GRID_NX, GRID_NY);
  lbm.u0 = windToLattice(90);
  lbm.reset();
  for (let i = 0; i < 50; i++) assert.ok(lbm.step(), `step ${i} blew up`);
  assert.ok(Math.abs(lbm.forceX) < 1e-6);
  assert.ok(Math.abs(lbm.forceY) < 1e-6);
  const mid = (GRID_NY >> 1) * GRID_NX + (GRID_NX >> 1);
  assert.ok(Math.abs(lbm.ux[mid] - lbm.u0) < 1e-3);
});

test('a block in the flow produces positive drag at the fastest wind', () => {
  // A quarter-size grid keeps the test fast; the physics is the same.
  const nx = GRID_NX >> 1;
  const ny = GRID_NY >> 1;
  const lbm = new Lbm(nx, ny);
  lbm.u0 = windToLattice(MAX_WIND_KMH);
  const mask = new Uint8Array(nx * ny);
  for (let j = 0; j < 12; j++) {
    for (let i = 30; i < 55; i++) mask[j * nx + i] = 1;
  }
  lbm.setSolid(mask);
  lbm.reset();
  let fx = 0;
  for (let s = 0; s < 600; s++) {
    assert.ok(lbm.step(), `step ${s} blew up`);
    if (s >= 300) fx += lbm.forceX;
  }
  assert.ok(fx / 300 > 0, 'time-averaged drag should point downstream');
  for (let c = 0; c < mask.length; c++) {
    if (mask[c]) assert.equal(lbm.ux[c], 0);
  }
});
