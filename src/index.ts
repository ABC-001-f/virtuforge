/**
 * VIRTUFORGE: AeroLab entry point - a hands-first WebXR wind tunnel.
 * Creates the IWSDK world from the project config, registers the lab systems,
 * adds the browser-side import panel and restores the user's imported model.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { initCustomModel } from './aero/model-import.js';
import { ControlsSystem } from './controls.js';
import { ImportOverlay } from './import-overlay.js';
import { PointerVisualsSystem } from './pointer-visuals.js';
import { UiSystem } from './ui.js';
import { WindTunnelSystem } from './wind-tunnel.js';

const container = document.getElementById('scene-container') as HTMLDivElement;

function showFatal(err: unknown): void {
  console.error('[AeroLab] failed to start', err);
  const message = err instanceof Error ? err.message : String(err);
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:#0b0e14;color:#e6e9f0;' +
    'font:16px/1.5 system-ui,sans-serif;text-align:center;';
  box.innerHTML =
    '<div style="max-width:520px"><h1 style="font-size:22px;color:#4fd8ff;margin:0 0 8px">AeroLab could not start</h1>' +
    '<p>This app needs a browser with WebGL 2 and Web Workers (Meta Quest Browser, or a recent desktop browser).</p>' +
    `<p style="color:#9aa6bf;font-size:13px;word-break:break-word">${message.replace(/[<>&]/gu, '')}</p></div>`;
  document.body.appendChild(box);
}

World.create(container, projectOptions)
  .then(async (world) => {
    world.registerSystem(WindTunnelSystem);
    world.registerSystem(ControlsSystem);
    world.registerSystem(UiSystem);
    world.registerSystem(PointerVisualsSystem);
    new ImportOverlay(world);
    await initCustomModel();
  })
  .catch(showFatal);
