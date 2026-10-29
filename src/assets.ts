/**
 * Asset manifest: the procedural AeroLab set, the three UIKitML panels and
 * the lazily loaded CC0 toy car glTF. Imported by both the runtime and the
 * editor, so it stays deterministic and side-effect free.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import {
  createDialBase,
  createDialKnob,
  createLabDesk,
  createLabFloor,
  createLeverKnob,
  createLeverRail,
  createWindTunnel,
} from './scene-assets/lab.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'lab-floor': createLabFloor(),
  'lab-desk': createLabDesk(),
  'wind-tunnel': createWindTunnel(),
  'lever-rail': createLeverRail(),
  'lever-knob': createLeverKnob(),
  'dial-base': createDialBase(),
  'dial-knob': createDialKnob(),
  'control-panel': uikitml('control.uikitml', 'Control Panel'),
  'results-panel': uikitml('results.uikitml', 'Results Panel'),
  'welcome-panel': uikitml('welcome.uikitml', 'Welcome Panel'),
  toycar: {
    url: publicAssetUrl('models/ToyCar.glb'),
    type: AssetType.GLTF,
    name: 'Toy Car (CC0)',
    priority: 'lazy',
  },
});
