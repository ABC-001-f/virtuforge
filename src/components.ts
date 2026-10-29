/**
 * Project components exposed to the scene file and the editor.
 */

import { defineComponents } from '@iwsdk/core';
import { AngleDial, ShapeHandle, WindLever } from './aero-components.js';

export default defineComponents([WindLever, AngleDial, ShapeHandle]);
