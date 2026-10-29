/**
 * VIRTUFORGE: AeroLab entry point - a hands-first WebXR wind tunnel.
 * Creates the IWSDK world from the project config and registers the lab systems.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ControlsSystem } from './controls.js';
import { UiSystem } from './ui.js';
import { WindTunnelSystem } from './wind-tunnel.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(WindTunnelSystem);
  world.registerSystem(ControlsSystem);
  world.registerSystem(UiSystem);
});
