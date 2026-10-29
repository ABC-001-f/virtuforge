import { createComponent, Types } from '@iwsdk/core';

/** Grabbable slider knob that sets the wind speed (scene node `wind-lever`). */
export const WindLever = createComponent('WindLever', {});

/** Grabbable knob you twist to set the model's angle (scene node `angle-dial`). */
export const AngleDial = createComponent('AngleDial', {});

/** Grabbable sphere that reshapes the parametric car (created in code by ControlsSystem). */
export const ShapeHandle = createComponent('ShapeHandle', {
  param: { type: Types.String, default: '' },
});
