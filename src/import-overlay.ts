/**
 * Browser-side "Import model" panel (plain DOM, outside the 3D scene).
 *
 * Headsets cannot open a file picker from inside an immersive session, so
 * importing happens here, on the 2D page, before pressing Enter XR: choose a
 * .glb / .gltf (drag it onto the page, pick it, or paste a URL), set how it
 * sits in the tunnel (ground or air, up axis, yaw, nose direction) and tick
 * the parts that should not count. The model is kept on this device, so it
 * is still there after a reload and inside XR.
 *
 * The panel hides itself while an XR session is visible and never touches
 * the ECS directly: it talks to the lab through state + events like the
 * UIKit panels do.
 */

import { VisibilityState } from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { CUSTOM_MODEL_ID } from './aero/catalog.js';
import { clearPartEdits, emit, lab, on, partEdit } from './aero/lab-state.js';
import {
  fetchModelFromUrl,
  importCustomModel,
  MAX_IMPORT_BYTES,
  ModelImportError,
  packModelFiles,
  removeCustomModel,
  updateCustomModel,
} from './aero/model-import.js';
import { isCarId, modelInfo } from './aero/types.js';

const STYLE = /* css */ `
.vf-import { position: fixed; right: 16px; bottom: 16px; z-index: 20; font: 14px/1.4 system-ui, sans-serif; color: #e6e9f0; }
.vf-import * { box-sizing: border-box; }
.vf-import__toggle { background: #0a7f99; color: #fff; border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
.vf-import__toggle:hover { background: #0b93b1; }
.vf-import__panel { display: none; width: min(360px, calc(100vw - 32px)); max-height: min(78vh, 640px); overflow: auto; margin-bottom: 10px; padding: 16px; border-radius: 14px; background: rgba(16,19,27,.96); border: 1px solid #2a2f3a; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.vf-import--open .vf-import__panel { display: block; }
.vf-import h2 { margin: 0 0 4px; font-size: 16px; color: #4fd8ff; letter-spacing: .5px; }
.vf-import h3 { margin: 14px 0 6px; font-size: 12px; letter-spacing: 1.2px; color: #8a96b0; text-transform: uppercase; }
.vf-import p { margin: 0 0 8px; color: #9aa6bf; font-size: 13px; }
.vf-import__drop { border: 1px dashed #3a4252; border-radius: 10px; padding: 12px; text-align: center; color: #b9c2d6; cursor: pointer; }
.vf-import__drop:hover, .vf-import--dragging .vf-import__drop { border-color: #4fd8ff; background: rgba(79,216,255,.08); }
.vf-import__drop input { display: none; }
.vf-import__row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
.vf-import__row label { color: #b9c2d6; font-size: 13px; }
.vf-import input[type=url], .vf-import select { flex: 1 1 120px; min-width: 0; padding: 7px 9px; border-radius: 8px; border: 1px solid #3a4252; background: #0d1017; color: #e6e9f0; font: inherit; }
.vf-import button.vf-btn { padding: 7px 12px; border-radius: 8px; border: 1px solid #3a4252; background: #1b2130; color: #e6e9f0; font: inherit; cursor: pointer; }
.vf-import button.vf-btn:hover { background: #242c3d; }
.vf-import button.vf-btn--primary { background: #0a7f99; border-color: #0a7f99; color: #fff; }
.vf-import button.vf-btn--danger { color: #ff8a8a; }
.vf-import button:disabled { opacity: .5; cursor: default; }
.vf-import__msg { min-height: 18px; margin-top: 8px; font-size: 13px; color: #9aa6bf; white-space: pre-line; }
.vf-import__msg--error { color: #ff8a8a; }
.vf-import__msg--ok { color: #39ff88; }
.vf-import__parts { max-height: 180px; overflow: auto; border: 1px solid #2a2f3a; border-radius: 8px; padding: 6px 8px; }
.vf-import__parts label { display: flex; gap: 8px; align-items: center; padding: 3px 0; color: #dddfe3; font-size: 13px; cursor: pointer; }
.vf-import__parts label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vf-import__hint { font-size: 12px; color: #6f7a92; }
@media (max-width: 480px) { .vf-import { right: 8px; bottom: 8px; } }
`;

type Msg = 'info' | 'error' | 'ok';

export class ImportOverlay {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  private readonly urlInput: HTMLInputElement;
  private readonly message: HTMLDivElement;
  private readonly modelName: HTMLSpanElement;
  private readonly useButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  private readonly kindSelect: HTMLSelectElement;
  private readonly upSelect: HTMLSelectElement;
  private readonly yawSelect: HTMLSelectElement;
  private readonly flipInput: HTMLInputElement;
  private readonly settings: HTMLDivElement;
  private readonly partsTitle: HTMLHeadingElement;
  private readonly partsList: HTMLDivElement;
  private readonly partsHint: HTMLParagraphElement;
  private readonly resetPartsButton: HTMLButtonElement;
  private busy = false;
  private dragDepth = 0;
  private partsSignature = '';

  constructor(private readonly world: World) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'vf-import';
    this.root.innerHTML = `
      <div class="vf-import__panel" role="dialog" aria-label="Import your own model">
        <h2>Bring your own model</h2>
        <p>Load a glTF of your product, then press Enter XR. It stays on this device only.</p>
        <label class="vf-import__drop">
          <input type="file" multiple accept=".glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.ktx2" />
          <strong>Drop a .glb / .gltf here</strong> or click to choose<br />
          <span class="vf-import__hint">For a .gltf, select its .bin and textures too. Max ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB.</span>
        </label>
        <div class="vf-import__row">
          <input type="url" placeholder="https://example.com/model.glb" aria-label="Model URL" />
          <button class="vf-btn" data-action="url">Load URL</button>
        </div>
        <div class="vf-import__msg" aria-live="polite"></div>

        <div data-section="model">
          <h3>Your model</h3>
          <div class="vf-import__row">
            <span data-field="name" style="flex:1 1 auto"></span>
            <button class="vf-btn vf-btn--primary" data-action="use">Put in tunnel</button>
            <button class="vf-btn vf-btn--danger" data-action="remove">Remove</button>
          </div>
          <div class="vf-import__row">
            <label>Sits</label>
            <select data-field="kind"><option value="ground">on the ground</option><option value="air">in the air</option></select>
            <label>Up axis</label>
            <select data-field="up"><option value="y">Y (glTF default)</option><option value="z">Z</option></select>
          </div>
          <div class="vf-import__row">
            <label>Turn</label>
            <select data-field="yaw"><option value="0">0 deg</option><option value="1">90 deg</option><option value="2">180 deg</option><option value="3">270 deg</option></select>
            <label><input type="checkbox" data-field="flip" /> Flip nose (nose must face the fan)</label>
          </div>
        </div>

        <div data-section="parts">
          <h3 data-field="parts-title">Parts</h3>
          <p class="vf-import__hint" data-field="parts-hint"></p>
          <div class="vf-import__parts" data-field="parts"></div>
          <div class="vf-import__row">
            <button class="vf-btn" data-action="reset-parts">Reset parts</button>
            <span class="vf-import__hint">Untick a part to leave it out of the airflow. In XR, press Edit parts and drag the orange handles.</span>
          </div>
        </div>
      </div>
      <button class="vf-import__toggle" type="button" aria-expanded="false">Import model</button>
    `;
    document.body.appendChild(this.root);

    const q = <T extends HTMLElement>(selector: string): T => this.root.querySelector(selector) as T;
    this.panel = q('.vf-import__panel');
    this.fileInput = q('input[type=file]');
    this.urlInput = q('input[type=url]');
    this.message = q('.vf-import__msg');
    this.modelName = q('[data-field=name]');
    this.useButton = q('[data-action=use]');
    this.removeButton = q('[data-action=remove]');
    this.kindSelect = q('[data-field=kind]');
    this.upSelect = q('[data-field=up]');
    this.yawSelect = q('[data-field=yaw]');
    this.flipInput = q('[data-field=flip]');
    this.settings = q('[data-section=model]');
    this.partsTitle = q('[data-field=parts-title]');
    this.partsList = q('[data-field=parts]');
    this.partsHint = q('[data-field=parts-hint]');
    this.resetPartsButton = q('[data-action=reset-parts]');

    const toggle = q<HTMLButtonElement>('.vf-import__toggle');
    toggle.addEventListener('click', () => {
      const open = this.root.classList.toggle('vf-import--open');
      toggle.setAttribute('aria-expanded', String(open));
    });

    this.fileInput.addEventListener('change', () => {
      const files = Array.from(this.fileInput.files ?? []);
      this.fileInput.value = '';
      if (files.length > 0) void this.importFiles(files);
    });
    q('[data-action=url]').addEventListener('click', () => void this.importUrl(this.urlInput.value.trim()));
    this.urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void this.importUrl(this.urlInput.value.trim());
    });
    this.useButton.addEventListener('click', () => this.selectCustom());
    this.removeButton.addEventListener('click', () => void this.remove());
    this.kindSelect.addEventListener('change', () => updateCustomModel({ kind: this.kindSelect.value as 'ground' | 'air' }));
    this.upSelect.addEventListener('change', () =>
      updateCustomModel({ orientation: { up: this.upSelect.value as 'y' | 'z' } }),
    );
    this.yawSelect.addEventListener('change', () =>
      updateCustomModel({ orientation: { yawQuarterTurns: Number(this.yawSelect.value) as 0 | 1 | 2 | 3 } }),
    );
    this.flipInput.addEventListener('change', () => updateCustomModel({ flipNose: this.flipInput.checked }));
    this.resetPartsButton.addEventListener('click', () => {
      clearPartEdits(lab.modelId);
      emit('resetParts');
    });

    // Drag-and-drop anywhere on the page.
    document.addEventListener('dragenter', (ev) => {
      if (!this.hasFiles(ev)) return;
      this.dragDepth++;
      this.root.classList.add('vf-import--dragging', 'vf-import--open');
    });
    document.addEventListener('dragleave', () => {
      if (--this.dragDepth <= 0) {
        this.dragDepth = 0;
        this.root.classList.remove('vf-import--dragging');
      }
    });
    document.addEventListener('dragover', (ev) => {
      if (this.hasFiles(ev)) ev.preventDefault();
    });
    document.addEventListener('drop', (ev) => {
      if (!this.hasFiles(ev)) return;
      ev.preventDefault();
      this.dragDepth = 0;
      this.root.classList.remove('vf-import--dragging');
      const files = Array.from(ev.dataTransfer?.files ?? []);
      if (files.length > 0) void this.importFiles(files);
    });

    on('custom', () => this.refreshModel());
    on('model', () => this.refreshParts());
    on('parts', () => this.refreshParts());
    on('partVisibility', () => this.refreshParts());
    this.refreshModel();
    this.refreshParts();

    // Hide while immersive: the DOM is not visible in XR anyway, and a stray click must not land here.
    world.visibilityState.subscribe((state) => {
      this.root.style.display = state === VisibilityState.NonImmersive ? '' : 'none';
    });

    const fromQuery = new URLSearchParams(location.search).get('model');
    if (fromQuery) {
      this.root.classList.add('vf-import--open');
      this.urlInput.value = fromQuery;
      void this.importUrl(fromQuery);
    }
  }

  private hasFiles(ev: DragEvent): boolean {
    return Array.from(ev.dataTransfer?.types ?? []).includes('Files');
  }

  private say(text: string, kind: Msg = 'info'): void {
    this.message.textContent = text;
    this.message.className = `vf-import__msg${kind === 'info' ? '' : ` vf-import__msg--${kind}`}`;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const el of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) {
      if (!el.classList.contains('vf-import__toggle')) el.disabled = busy;
    }
  }

  private async importFiles(files: File[]): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.say(`Reading ${files.map((f) => f.name).join(', ')}...`);
    try {
      const packed = await packModelFiles(files);
      await this.finishImport(packed.fileName, () => importCustomModel(packed, this.kindSelect.value as 'ground' | 'air'));
    } catch (err) {
      this.fail(err);
    } finally {
      this.setBusy(false);
    }
  }

  private async importUrl(url: string): Promise<void> {
    if (this.busy) return;
    if (!url) {
      this.say('Paste the URL of a .glb or .gltf file first.', 'error');
      return;
    }
    this.setBusy(true);
    this.say('Downloading...');
    try {
      const packed = await fetchModelFromUrl(url);
      await this.finishImport(packed.fileName, () => importCustomModel(packed, this.kindSelect.value as 'ground' | 'air'));
    } catch (err) {
      this.fail(err);
    } finally {
      this.setBusy(false);
    }
  }

  private async finishImport(fileName: string, run: () => Promise<unknown>): Promise<void> {
    this.say(`Loading ${fileName}...`);
    await run();
    this.say(`${fileName} is in the tunnel. Check the nose faces the fan; use Turn or Flip nose if not.`, 'ok');
    this.selectCustom();
  }

  private fail(err: unknown): void {
    const text = err instanceof ModelImportError ? err.message : `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[ImportOverlay]', err);
    this.say(text, 'error');
  }

  private selectCustom(): void {
    if (!lab.customModel) return;
    if (lab.modelId !== CUSTOM_MODEL_ID) {
      lab.modelId = CUSTOM_MODEL_ID;
      lab.carParams = null;
      lab.exploded = false;
      lab.angleDeg = 0;
      lab.partEditing = false;
      emit('model');
      emit('angle');
      emit('partEdit');
    }
  }

  private async remove(): Promise<void> {
    if (this.busy || !lab.customModel) return;
    if (!confirm(`Remove ${lab.customModel.name} from this device?`)) return;
    this.setBusy(true);
    try {
      await removeCustomModel();
      this.say('Model removed.', 'ok');
    } catch (err) {
      this.fail(err);
    } finally {
      this.setBusy(false);
    }
  }

  private refreshModel(): void {
    const meta = lab.customModel;
    this.settings.style.display = meta ? '' : 'none';
    if (!meta) return;
    this.modelName.textContent = meta.name;
    this.kindSelect.value = meta.kind;
    this.upSelect.value = meta.orientation.up;
    this.yawSelect.value = String(meta.orientation.yawQuarterTurns);
    this.flipInput.checked = meta.flipNose;
  }

  /** Part checkboxes for whatever model is in the tunnel (cars reshape with handles instead). */
  private refreshParts(): void {
    const anchors = lab.partAnchors;
    const show = anchors.length > 0 && !isCarId(lab.modelId);
    this.partsList.parentElement!.style.display = show ? '' : 'none';
    if (!show) {
      this.partsSignature = '';
      return;
    }
    // Anchors are republished on every angle change; only rebuild the DOM when the list itself changed.
    const signature = `${lab.modelId}|${anchors.map((a) => `${a.index}:${a.name}:${a.hidden ? 1 : 0}`).join(',')}`;
    if (signature === this.partsSignature) return;
    this.partsSignature = signature;
    const label = lab.modelId === CUSTOM_MODEL_ID && lab.customModel ? lab.customModel.name : modelInfo(lab.modelId).label;
    this.partsTitle.textContent = `Parts of ${label}`;
    this.partsHint.textContent =
      anchors.length > 24 ? `${anchors.length} parts; the 24 largest get handles in XR.` : `${anchors.length} parts.`;

    this.partsList.replaceChildren();
    const modelId = lab.modelId;
    for (const anchor of anchors) {
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !anchor.hidden;
      box.addEventListener('change', () => {
        if (lab.modelId !== modelId) return;
        partEdit(modelId, anchor.index).hidden = !box.checked;
        emit('partVisibility');
      });
      const name = document.createElement('span');
      name.textContent = anchor.name;
      name.title = anchor.name;
      row.append(box, name);
      this.partsList.appendChild(row);
    }
  }
}
