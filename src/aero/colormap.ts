/**
 * Colour maps for the flow visuals. Both write sRGB bytes (0..255) as
 * out[offset], out[offset + 1], out[offset + 2] and never allocate.
 *
 *   speedColor:     0..1  -> deep blue -> blue -> cyan -> white -> amber
 *   divergingColor: -1..1 -> blue -> near-white -> red (pressure coefficient)
 */

type ColorOut = Uint8Array | Uint8ClampedArray | number[];

// Stops as [t, r, g, b] in sRGB bytes, flattened.
const SPEED_STOPS = [
  0.0, 10, 22, 70,
  0.3, 24, 86, 196,
  0.55, 40, 196, 228,
  0.78, 236, 246, 250,
  1.0, 255, 176, 46,
];

const DIVERGING_STOPS = [
  -1.0, 30, 70, 190,
  -0.5, 110, 160, 230,
  0.0, 238, 240, 242,
  0.5, 236, 130, 100,
  1.0, 186, 26, 40,
];

function sample(stops: number[], t: number, out: ColorOut, offset: number): void {
  const last = stops.length - 4;
  if (!(t > stops[0])) t = stops[0];        // also catches NaN
  if (t > stops[last]) t = stops[last];
  let k = 0;
  while (k < last - 4 && t > stops[k + 4]) k += 4;
  const t0 = stops[k];
  const t1 = stops[k + 4];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  out[offset] = Math.round(stops[k + 1] + (stops[k + 5] - stops[k + 1]) * f);
  out[offset + 1] = Math.round(stops[k + 2] + (stops[k + 6] - stops[k + 2]) * f);
  out[offset + 2] = Math.round(stops[k + 3] + (stops[k + 7] - stops[k + 3]) * f);
}

/** Flow speed, t in 0..1 (clamped). */
export function speedColor(t: number, out: ColorOut, offset: number): void {
  sample(SPEED_STOPS, t, out, offset);
}

/** Signed quantity such as normalised Cp, t in -1..1 (clamped). */
export function divergingColor(t: number, out: ColorOut, offset: number): void {
  sample(DIVERGING_STOPS, t, out, offset);
}
