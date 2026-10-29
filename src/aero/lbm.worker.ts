/**
 * Web worker that runs the lattice-Boltzmann solver off the main thread.
 *
 * Messages in (from SolverClient):
 *   { type: 'mask', mask, frontalCells, lengthCells }  new model silhouette
 *   { type: 'wind', u0 }                                lattice inlet velocity
 *   { type: 'running', running }                        pause / resume stepping
 * Messages out:
 *   { type: 'frame', ux, uy, rho, cd, cl, re, u0, stepsPerSecond, settled }
 *   about every FRAME_INTERVAL_MS while running; the field arrays are fresh
 *   copies whose buffers are transferred.
 *
 * Steps run in short time slices and yield through a MessageChannel so
 * incoming messages are handled promptly. Drag/lift are momentum-exchange
 * forces normalised by the frontal height / length in cells, averaged over
 * roughly the last AVERAGE_STEPS steps once the start-up transient has passed.
 */

import { Lbm } from './lbm.js';
import { GRID_NX, GRID_NY, LATTICE_VISCOSITY } from './tunnel.js';

const SLICE_MS = 10;
const FRAME_INTERVAL_MS = 100;
const TRANSIENT_STEPS = 500;    // ignored after any mask/wind change
const AVERAGE_STEPS = 1500;     // EMA window
const SETTLED_STEPS = 1500;     // steps since change before a reading counts
const STEPS_PER_TIME_CHECK = 4;

type InMessage =
  | { type: 'mask'; mask: Uint8Array; frontalCells: number; lengthCells: number }
  | { type: 'wind'; u0: number }
  | { type: 'running'; running: boolean };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<InMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

const lbm = new Lbm(GRID_NX, GRID_NY, LATTICE_VISCOSITY);
let hasMask = false;
let frontalCells = 1;
let lengthCells = 1;
let running = true;
let scheduled = false;

let stepsSinceChange = 0;
let avgCount = 0;
let avgFx = 0;
let avgFy = 0;

let lastFrameTime = performance.now();
let stepsSinceFrame = 0;

function markChanged(): void {
  stepsSinceChange = 0;
  avgCount = 0;  // the next sample overwrites the old average, so readouts don't jump to 0
}

function accumulate(): void {
  stepsSinceChange++;
  if (stepsSinceChange <= TRANSIENT_STEPS) return;
  avgCount++;
  const a = Math.max(1 / AVERAGE_STEPS, 1 / avgCount);
  avgFx += a * (lbm.forceX - avgFx);
  avgFy += a * (lbm.forceY - avgFy);
}

function postFrame(now: number): void {
  const elapsed = (now - lastFrameTime) / 1000;
  const stepsPerSecond = elapsed > 0 ? stepsSinceFrame / elapsed : 0;
  lastFrameTime = now;
  stepsSinceFrame = 0;

  const u0 = lbm.u0;
  const q = 0.5 * u0 * u0;
  const cd = q > 0 ? avgFx / (q * Math.max(1, frontalCells)) : 0;
  const cl = q > 0 ? avgFy / (q * Math.max(1, lengthCells)) : 0;
  const ux = lbm.ux.slice();
  const uy = lbm.uy.slice();
  const rho = lbm.rho.slice();
  ctx.postMessage(
    {
      type: 'frame',
      ux,
      uy,
      rho,
      cd,
      cl,
      re: (u0 * lengthCells) / LATTICE_VISCOSITY,
      u0,
      stepsPerSecond,
      settled: stepsSinceChange > SETTLED_STEPS,
    },
    [ux.buffer, uy.buffer, rho.buffer],
  );
}

function slice(): void {
  scheduled = false;
  if (!running) return;

  const start = performance.now();
  let now = start;
  while (now - start < SLICE_MS) {
    for (let k = 0; k < STEPS_PER_TIME_CHECK; k++) {
      if (!lbm.step()) {
        // Blew up: restart from uniform flow around the current model.
        lbm.reset();
        markChanged();
        break;
      }
      accumulate();
      stepsSinceFrame++;
    }
    now = performance.now();
  }

  if (now - lastFrameTime >= FRAME_INTERVAL_MS) postFrame(now);
  schedule();
}

// MessageChannel yields without setTimeout's nested-timer clamping.
const channel = new MessageChannel();
channel.port1.onmessage = slice;

function schedule(): void {
  if (scheduled || !running) return;
  scheduled = true;
  channel.port2.postMessage(0);
}

ctx.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'mask':
      lbm.setSolid(msg.mask);
      frontalCells = msg.frontalCells;
      lengthCells = msg.lengthCells;
      if (!hasMask) {
        hasMask = true;
        lbm.reset();
      }
      markChanged();
      break;
    case 'wind':
      if (msg.u0 !== lbm.u0) {
        lbm.u0 = msg.u0;
        markChanged();
      }
      break;
    case 'running':
      if (msg.running && !running) {
        lastFrameTime = performance.now();
        stepsSinceFrame = 0;
      }
      running = msg.running;
      break;
  }
  schedule();
};

schedule();
