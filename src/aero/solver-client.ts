/**
 * Main-thread handle for the lattice-Boltzmann worker (lbm.worker.ts).
 *
 * Send it the model mask, wind and run state; it calls onFrame about 10 times
 * a second with the latest flow field and time-averaged coefficients.
 * Results are a 2D educational approximation, not validated CFD.
 */

import { GRID_NX, GRID_NY } from './tunnel.js';

export interface FlowFrame {
  /** Velocity and density fields, GRID_NX * GRID_NY row-major (fresh arrays per frame). */
  ux: Float32Array;
  uy: Float32Array;
  rho: Float32Array;
  /** Time-averaged drag / lift coefficients (2D, relative). */
  cd: number;
  cl: number;
  /** Lattice Reynolds number based on the model length in cells. */
  re: number;
  /** Lattice inlet velocity the frame was computed with. */
  u0: number;
  stepsPerSecond: number;
  /** True once the flow has run long enough since the last mask/wind change. */
  settled: boolean;
}

interface FrameMessage extends FlowFrame {
  type: 'frame';
}

export class SolverClient {
  onFrame: ((frame: FlowFrame) => void) | null = null;
  /** Called once if the worker crashes; the solver stays stopped until the page reloads. */
  onError: ((message: string) => void) | null = null;
  private worker: Worker | null;

  constructor() {
    this.worker = new Worker(new URL('./lbm.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FrameMessage>) => {
      const msg = ev.data;
      if (msg.type === 'frame' && this.onFrame) this.onFrame(msg);
    };
    this.worker.onerror = (ev) => {
      console.error('[SolverClient] worker error:', ev.message);
      this.onError?.(ev.message || 'worker error');
    };
  }

  /** mask: GRID_NX * GRID_NY row-major, 1 = solid. Copied, so the caller may reuse it. */
  setMask(mask: Uint8Array, frontalCells: number, lengthCells: number): void {
    if (!this.worker) return;
    if (mask.length !== GRID_NX * GRID_NY) {
      throw new Error(`SolverClient.setMask: expected ${GRID_NX * GRID_NY} cells, got ${mask.length}`);
    }
    const copy = mask.slice();
    this.worker.postMessage({ type: 'mask', mask: copy, frontalCells, lengthCells }, [copy.buffer]);
  }

  /** Lattice inlet velocity (see windToLattice). */
  setWind(u0: number): void {
    this.worker?.postMessage({ type: 'wind', u0 });
  }

  setRunning(running: boolean): void {
    this.worker?.postMessage({ type: 'running', running });
  }

  dispose(): void {
    this.onFrame = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
