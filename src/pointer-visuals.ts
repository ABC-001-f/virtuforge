import {
  CircleGeometry,
  Color,
  createSystem,
  RayDisplayMode,
  type Mesh,
  type MeshBasicMaterial,
  type RayPointer,
} from '@iwsdk/core';

/**
 * Makes the hand / controller pointer easy to see. IWSDK draws it as a 1 mm
 * white line that only appears while it already hits something, with an 8 mm
 * white cursor disc. In the lab that is nearly invisible against the smoke
 * and the pale tunnel, so aiming at a button, the lever, the knob or a handle
 * is guesswork. This system keeps the ray visible whenever the hand is
 * tracked, makes it thicker and yellow (cyan while pinching, matching the
 * shape handles), and tints and enlarges the cursor to match.
 *
 * MultiPointer keeps its RayPointer and CursorVisual private; they are reached
 * through a narrow cast rather than copying the pointer pipeline.
 */

const RAY_IDLE = new Color(0xffd23c);
const RAY_PRESSED = new Color(0x4ff3ff);
/** Multiplier on the library's 1 mm ray radius. */
const RAY_THICKNESS = 3.5;
/** Cursor disc radius in metres (library default 0.008). */
const CURSOR_RADIUS = 0.014;

interface PointerInternals {
  ray?: { visual?: RayPointer };
  cursorVisual?: { cursor?: Mesh<CircleGeometry, MeshBasicMaterial> };
}

export class PointerVisualsSystem extends createSystem({}) {
  private readonly rays: RayPointer[] = [];

  init(): void {
    const pointers = this.world.input.xr.multiPointers;
    for (const hand of ['left', 'right'] as const) {
      const internals = pointers[hand] as unknown as PointerInternals;
      const rayPointer = internals.ray?.visual;
      if (rayPointer?.ray) {
        rayPointer.rayDisplayMode = RayDisplayMode.Visible;
        // The ray cylinder runs along -z; x and y are its radius.
        rayPointer.ray.scale.set(RAY_THICKNESS, RAY_THICKNESS, 1);
        rayPointer.ray.material.uniforms.color.value.copy(RAY_IDLE);
        this.rays.push(rayPointer);
      }
      const cursor = internals.cursorVisual?.cursor;
      if (cursor) {
        cursor.geometry.dispose();
        cursor.geometry = new CircleGeometry(CURSOR_RADIUS);
        cursor.material.color.copy(RAY_IDLE);
      }
    }
  }

  update(): void {
    // RayPointer resets its colour to white on every release; re-apply ours.
    for (let i = 0; i < this.rays.length; i++) {
      const rayPointer = this.rays[i];
      const pressed = rayPointer.pointer.getButtonsDown().size > 0;
      rayPointer.ray.material.uniforms.color.value.copy(pressed ? RAY_PRESSED : RAY_IDLE);
    }
  }
}
