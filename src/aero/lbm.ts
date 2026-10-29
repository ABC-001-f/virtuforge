/**
 * D2Q9 lattice-Boltzmann solver for a 2D wind-tunnel slice.
 *
 * - BGK collision with a Smagorinsky sub-grid term, which keeps the solver
 *   stable at the higher wind speeds the lever allows.
 * - Half-way bounce-back on solid cells; the momentum exchanged there gives
 *   the aerodynamic force on the model (drag along x, lift along y).
 * - Fixed-velocity inlet on the left, zero-gradient outlet on the right,
 *   free-slip floor and ceiling (a moving road / open sky, not a boxed pipe).
 *
 * Everything is in lattice units: cell size 1, time step 1, inlet density 1.
 * It is a 2D centreline approximation for comparing designs, not validated CFD.
 */

const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const MIRROR_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5];   // reflect off the floor/ceiling
const SMAGORINSKY = 0.12;

export class Lbm {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  readonly solid: Uint8Array;
  readonly rho: Float32Array;
  readonly ux: Float32Array;
  readonly uy: Float32Array;
  /** Force on the model from the last step (lattice units). */
  forceX = 0;
  forceY = 0;
  u0 = 0.06;
  private tau0: number;
  private f: Float32Array;
  private f2: Float32Array;
  private feq = new Float64Array(9);

  constructor(nx: number, ny: number, viscosity = 0.012) {
    this.nx = nx;
    this.ny = ny;
    this.n = nx * ny;
    this.solid = new Uint8Array(this.n);
    this.rho = new Float32Array(this.n);
    this.ux = new Float32Array(this.n);
    this.uy = new Float32Array(this.n);
    this.f = new Float32Array(9 * this.n);
    this.f2 = new Float32Array(9 * this.n);
    this.tau0 = 3 * viscosity + 0.5;
    this.reset();
  }

  /** Uniform flow at the inlet speed everywhere outside the model. */
  reset(): void {
    const { n, f, u0 } = this;
    for (let c = 0; c < n; c++) {
      const u = this.solid[c] ? 0 : u0;
      for (let i = 0; i < 9; i++) f[i * n + c] = equilibrium(i, 1, u, 0);
      this.rho[c] = 1;
      this.ux[c] = u;
      this.uy[c] = 0;
    }
  }

  setSolid(mask: Uint8Array): void {
    this.solid.set(mask);
    // Cells that just became fluid start at rest density so nothing explodes.
    const { n, f } = this;
    for (let c = 0; c < n; c++) {
      if (!mask[c] && this.rho[c] === 0) {
        for (let i = 0; i < 9; i++) f[i * n + c] = W[i];
      }
    }
  }

  /** Advance one time step. Returns false if the solution blew up. */
  step(): boolean {
    const { nx, ny, n, f, f2, solid, rho: R, ux: UX, uy: UY, tau0 } = this;
    let fx = 0;
    let fy = 0;

    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = y * nx + x;
        if (solid[c]) {
          R[c] = 0;
          UX[c] = 0;
          UY[c] = 0;
          continue;
        }
        // Moments
        const f0 = f[c], f1 = f[n + c], f2_ = f[2 * n + c], f3 = f[3 * n + c], f4 = f[4 * n + c];
        const f5 = f[5 * n + c], f6 = f[6 * n + c], f7 = f[7 * n + c], f8 = f[8 * n + c];
        const rho = f0 + f1 + f2_ + f3 + f4 + f5 + f6 + f7 + f8;
        const ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
        const uy = (f2_ - f4 + f5 + f6 - f7 - f8) / rho;
        R[c] = rho;
        UX[c] = ux;
        UY[c] = uy;

        // Smagorinsky: effective relaxation time from the non-equilibrium stress.
        const feq = this.feq;
        const usq = 1.5 * (ux * ux + uy * uy);
        for (let i = 0; i < 9; i++) {
          const cu = 3 * (CX[i] * ux + CY[i] * uy);
          feq[i] = W[i] * rho * (1 + cu + 0.5 * cu * cu - usq);
        }
        let pxx = 0, pyy = 0, pxy = 0;
        for (let i = 1; i < 9; i++) {
          const neq = f[i * n + c] - feq[i];
          pxx += CX[i] * CX[i] * neq;
          pyy += CY[i] * CY[i] * neq;
          pxy += CX[i] * CY[i] * neq;
        }
        const q = Math.sqrt(2 * (pxx * pxx + pyy * pyy + 2 * pxy * pxy));
        const tau = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + 18 * SMAGORINSKY * SMAGORINSKY * q / rho));
        const omega = 1 / tau;

        // Collide and stream (push).
        for (let i = 0; i < 9; i++) {
          const fi = f[i * n + c];
          const post = fi - omega * (fi - feq[i]);
          const tx = x + CX[i];
          let ty = y + CY[i];
          let dir = i;
          if (ty < 0 || ty >= ny) {              // free-slip floor / ceiling
            ty = y;
            dir = MIRROR_Y[i];
          }
          if (tx < 0 || tx >= nx) continue;      // inlet/outlet columns are rebuilt below
          const t = ty * nx + tx;
          if (solid[t]) {
            // Bounce back; the reversed momentum is the force on the body.
            f2[OPP[i] * n + c] = post;
            fx += 2 * post * CX[i];
            fy += 2 * post * CY[i];
          } else {
            f2[dir * n + t] = post;
          }
        }
      }
    }

    // Inlet: prescribed velocity. Outlet: copy the neighbouring column.
    const u0 = this.u0;
    for (let y = 0; y < ny; y++) {
      const inlet = y * nx;
      const outlet = y * nx + nx - 1;
      for (let i = 0; i < 9; i++) {
        f2[i * n + inlet] = equilibrium(i, 1, u0, 0);
        f2[i * n + outlet] = f2[i * n + outlet - 1];
      }
    }

    this.f = f2;
    this.f2 = f;
    this.forceX = fx;
    this.forceY = fy;
    return Number.isFinite(fx) && Number.isFinite(fy);
  }
}

function equilibrium(i: number, rho: number, ux: number, uy: number): number {
  const cu = 3 * (CX[i] * ux + CY[i] * uy);
  return W[i] * rho * (1 + cu + 0.5 * cu * cu - 1.5 * (ux * ux + uy * uy));
}
