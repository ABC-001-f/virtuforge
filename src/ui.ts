import { createSystem, UIKit, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { CUSTOM_MODEL_ID } from './aero/catalog.js';
import { GRID_NX, GRID_NY } from './aero/tunnel.js';
import { isCarId, MODEL_CATALOG, modelInfo, type ModelId, type ViewMode } from './aero/types.js';
import { clearPartEdits, DEFAULT_CAR_PARAMS, emit, lab, on, type LabEvent } from './aero/lab-state.js';

/**
 * Panels: control (model buttons, live readouts, tunnel actions, shape and
 * part editing), results (A vs B drag bars, delta and the test report) and
 * welcome (how-to, Enter / Exit XR). Buttons mutate 'lab' and emit the
 * matching event; readouts refresh from lab events and only touch UIKit when
 * a string actually changes.
 *
 * Every catalog model gets a `model-<id>` button in control.uikitml; the one
 * for the user's own import (`model-custom`) only shows once a model is stored.
 *
 * Panels may finish loading after init, so wiring is retried each frame until
 * all three are found. All runtime strings are plain ASCII (the bundled font
 * lacks many typographic glyphs).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Element = UIKit.Component<any>;

const MODEL_BUTTONS: Array<[string, ModelId]> = MODEL_CATALOG.map((m) => [`model-${m.id}`, m.id]);

const VIEW_ORDER: ViewMode[] = ['smoke', 'speed', 'pressure'];
const VIEW_LABEL: Record<ViewMode, string> = { smoke: 'Smoke', speed: 'Speed', pressure: 'Pressure' };

const BAR_MAX_PX = 300;
/** Below this relative difference A and B are reported as equal. */
const DELTA_DEADBAND = 0.01;

/** Label of a model id, using the imported model's own name. */
function labelOf(id: ModelId): string {
  if (id === CUSTOM_MODEL_ID && lab.customModel) return lab.customModel.name;
  return modelInfo(id).label;
}

function creditOf(id: ModelId): string {
  if (id === CUSTOM_MODEL_ID) return lab.customModel ? `Imported model: ${lab.customModel.name}` : '';
  return modelInfo(id).credit ?? '';
}

export class UiSystem extends createSystem({}) {
  private controlWired = false;
  private resultsWired = false;
  private welcomeWired = false;

  /** Elements by id across all panels (ids are unique project-wide). */
  private readonly elements = new Map<string, Element>();
  /** Last value written per element id + property, to skip redundant setProperties. */
  private readonly shown = new Map<string, string | number>();

  init(): void {
    const refresh: Array<[LabEvent, () => void]> = [
      ['metrics', () => {
        this.refreshMetrics();
        this.refreshResults();
      }],
      ['wind', () => {
        this.refreshWind();
        this.refreshResults();
      }],
      ['angle', () => {
        this.refreshAngle();
        this.refreshResults();
      }],
      ['model', () => {
        this.refreshModel();
        this.refreshMetrics();
        this.refreshResults();
      }],
      ['view', () => this.refreshView()],
      ['status', () => this.refreshStatus()],
      ['saveA', () => this.refreshResults()],
      ['clearA', () => this.refreshResults()],
      ['skin', () => this.refreshToggles()],
      ['explode', () => this.refreshToggles()],
      ['partEdit', () => this.refreshToggles()],
      ['parts', () => this.refreshToggles()],
      ['custom', () => this.onCustomChanged()],
    ];
    for (const [event, listener] of refresh) this.cleanupFuncs.push(on(event, listener));

    this.tryWire();
  }

  update(): void {
    if (!this.controlWired || !this.resultsWired || !this.welcomeWired) this.tryWire();
  }

  // -- wiring ----------------------------------------------------------------

  private tryWire(): void {
    if (!this.controlWired) {
      const panel = this.world.getSceneObject<UIKitMLAsset>('control-panel');
      if (panel) {
        this.wireControl(panel);
        this.controlWired = true;
        this.refreshControl();
      }
    }
    if (!this.resultsWired) {
      const panel = this.world.getSceneObject<UIKitMLAsset>('results-panel');
      if (panel) {
        this.collect(panel, ['a-text', 'a-bar', 'b-text', 'b-bar', 'delta-text', 'report-text', 'credit-text']);
        this.resultsWired = true;
        this.refreshResults();
      }
    }
    if (!this.welcomeWired) {
      const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
      if (panel) {
        this.wireWelcome(panel);
        this.welcomeWired = true;
      }
    }
  }

  private collect(panel: UIKitMLAsset, ids: string[]): void {
    for (const id of ids) {
      const element = panel.getElementById<Element>(id);
      if (element) this.elements.set(id, element);
    }
  }

  private listen(panel: UIKitMLAsset, id: string, handler: () => void): void {
    const element = panel.getElementById<Element>(id);
    if (!element) return;
    this.elements.set(id, element);
    element.addEventListener('click', handler);
    this.cleanupFuncs.push(() => element.removeEventListener('click', handler));
  }

  private wireControl(panel: UIKitMLAsset): void {
    this.collect(panel, ['model-text', 'speed-text', 'angle-text', 'cd-text', 'cl-text', 're-text', 'view-text', 'status-text']);

    for (const [id, model] of MODEL_BUTTONS) this.listen(panel, id, () => this.selectModel(model));

    this.listen(panel, 'wind-on-button', () => this.setWind(true));
    this.listen(panel, 'wind-off-button', () => this.setWind(false));
    this.listen(panel, 'view-button', () => {
      lab.view = VIEW_ORDER[(VIEW_ORDER.indexOf(lab.view) + 1) % VIEW_ORDER.length];
      emit('view');
    });
    this.listen(panel, 'skin-button', () => {
      lab.skin = !lab.skin;
      emit('skin');
    });
    this.listen(panel, 'explode-button', () => {
      lab.exploded = !lab.exploded;
      emit('explode');
    });
    this.listen(panel, 'save-a-button', () => emit('saveA'));
    this.listen(panel, 'clear-a-button', () => emit('clearA'));
    this.listen(panel, 'reset-shape-button', () => {
      if (lab.carParams === null || !isCarId(lab.modelId)) return;
      lab.carParams = { ...DEFAULT_CAR_PARAMS[lab.modelId] };
      emit('shape');
    });
    this.listen(panel, 'parts-button', () => this.setPartEditing(!lab.partEditing));
    this.listen(panel, 'reset-parts-button', () => {
      clearPartEdits(lab.modelId);
      emit('resetParts');
    });
  }

  private wireWelcome(panel: UIKitMLAsset): void {
    const xrButton = panel.getElementById<Element>('xr-button');
    const exitButton = panel.getElementById<Element>('exit-button');
    if (!xrButton || !exitButton) return;
    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      exitButton.setProperties({ display: 'none' });
      return;
    }
    const launchXR = () => this.world.launchXR();
    const exitXR = () => this.world.exitXR();
    xrButton.addEventListener('click', launchXR);
    exitButton.addEventListener('click', exitXR);
    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((state) => {
        const is2D = state === VisibilityState.NonImmersive;
        xrButton.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
      }),
    );
  }

  // -- actions ---------------------------------------------------------------

  private selectModel(id: ModelId): void {
    if (id === CUSTOM_MODEL_ID && !lab.customModel) {
      lab.status = 'Import a model first (Import model on the browser page)';
      emit('status');
      return;
    }
    lab.modelId = id;
    lab.carParams = isCarId(id) ? { ...DEFAULT_CAR_PARAMS[id] } : null;
    lab.exploded = false;
    // A new model starts level; the angle readout listens for this.
    lab.angleDeg = 0;
    emit('model');
    emit('angle');
    this.setPartEditing(false);
    this.refreshToggles();
  }

  private setPartEditing(onState: boolean): void {
    if (lab.partEditing === onState) return;
    lab.partEditing = onState;
    emit('partEdit');
    this.refreshToggles();
  }

  private setWind(onState: boolean): void {
    if (lab.windOn === onState) return;
    lab.windOn = onState;
    emit('wind');
  }

  /** The imported model appeared, changed or went away. */
  private onCustomChanged(): void {
    if (!lab.customModel && lab.modelId === CUSTOM_MODEL_ID) {
      this.selectModel('ev');
      return;
    }
    this.refreshModel();
    this.refreshResults();
  }

  // -- element writes (cached) -----------------------------------------------

  private setText(id: string, text: string): void {
    const key = `${id}:text`;
    if (this.shown.get(key) === text) return;
    const element = this.elements.get(id);
    if (!element) return;
    this.shown.set(key, text);
    element.setProperties({ text });
  }

  private setProp(id: string, prop: 'display' | 'variant' | 'width', value: string | number): void {
    const key = `${id}:${prop}`;
    if (this.shown.get(key) === value) return;
    const element = this.elements.get(id);
    if (!element) return;
    this.shown.set(key, value);
    element.setProperties({ [prop]: value });
  }

  // -- refresh ---------------------------------------------------------------

  private refreshControl(): void {
    this.refreshModel();
    this.refreshWind();
    this.refreshAngle();
    this.refreshMetrics();
    this.refreshView();
    this.refreshStatus();
    this.refreshToggles();
  }

  private refreshModel(): void {
    this.setText('model-text', labelOf(lab.modelId));
    for (const [id, model] of MODEL_BUTTONS) {
      this.setProp(id, 'variant', model === lab.modelId ? 'primary' : 'secondary');
    }
    this.setProp(`model-${CUSTOM_MODEL_ID}`, 'display', lab.customModel ? 'flex' : 'none');
    this.setProp('reset-shape-button', 'display', lab.carParams ? 'flex' : 'none');
  }

  private refreshWind(): void {
    const kmh = Math.round(lab.windKmh);
    this.setText('speed-text', lab.windOn ? `Wind ${kmh} km/h` : `Wind off (${kmh} km/h)`);
    this.setProp('wind-on-button', 'display', lab.windOn ? 'none' : 'flex');
    this.setProp('wind-off-button', 'display', lab.windOn ? 'flex' : 'none');
  }

  private refreshAngle(): void {
    this.setText('angle-text', `Angle ${Math.round(lab.angleDeg)} deg`);
  }

  private refreshMetrics(): void {
    const m = lab.metrics;
    const settling = m.settled ? '' : ' (settling...)';
    this.setText('cd-text', `Cd ${m.cd.toFixed(2)}${settling}`);
    this.setText('cl-text', `Cl ${m.cl.toFixed(2)}`);
    this.setText('re-text', `Re ${Math.round(m.re)} (2D lattice)`);
  }

  private refreshView(): void {
    this.setText('view-text', `View: ${VIEW_LABEL[lab.view]}`);
  }

  private refreshStatus(): void {
    this.setText('status-text', lab.status);
  }

  private refreshToggles(): void {
    this.setProp('skin-button', 'variant', lab.skin ? 'primary' : 'secondary');
    this.setProp('explode-button', 'variant', lab.exploded ? 'primary' : 'secondary');
    this.setProp('parts-button', 'variant', lab.partEditing ? 'primary' : 'secondary');
    const hasParts = lab.partAnchors.length > 0;
    this.setProp('parts-button', 'display', hasParts ? 'flex' : 'none');
    this.setProp('reset-parts-button', 'display', hasParts ? 'flex' : 'none');
  }

  private refreshResults(): void {
    const a = lab.savedA;
    const m = lab.metrics;
    const currentLabel = labelOf(lab.modelId);
    const kmh = Math.round(lab.windKmh);
    const angle = Math.round(lab.angleDeg);

    this.setText(
      'a-text',
      a ? `A: ${a.label}  Cd ${a.cd.toFixed(2)}  Cl ${a.cl.toFixed(2)}` : 'A: not saved - press Save A',
    );
    const settling = m.settled ? '' : ' (settling...)';
    this.setText('b-text', `B (current): ${currentLabel}  Cd ${m.cd.toFixed(2)}  Cl ${m.cl.toFixed(2)}${settling}`);

    const cdA = a ? Math.max(0, a.cd) : 0;
    const cdB = Math.max(0, m.cd);
    const max = Math.max(cdA, cdB);
    this.setProp('a-bar', 'width', max > 0 ? Math.round((cdA / max) * BAR_MAX_PX) : 0);
    this.setProp('b-bar', 'width', max > 0 ? Math.round((cdB / max) * BAR_MAX_PX) : 0);

    let delta: string;
    if (!a) delta = 'Save A, then change the design';
    else if (!m.settled) delta = 'B: flow settling...';
    else if (a.cd <= 0) delta = 'A has no valid drag reading';
    else {
      const rel = (m.cd - a.cd) / a.cd;
      const pct = Math.round(Math.abs(rel) * 100);
      if (Math.abs(rel) < DELTA_DEADBAND) delta = 'A and B have about the same drag';
      else delta = `B has ${pct}% ${rel < 0 ? 'less' : 'more'} drag than A`;
    }
    this.setText('delta-text', delta);

    const lines = [
      `TEST REPORT - ${currentLabel}`,
      `Wind ${lab.windOn ? `${kmh} km/h` : 'off'}, angle ${angle} deg`,
      a
        ? `A: ${a.label}  Cd ${a.cd.toFixed(3)}  Cl ${a.cl.toFixed(3)}  (${Math.round(a.windKmh)} km/h, ${Math.round(a.angleDeg)} deg)`
        : 'A: not saved',
      `B: ${currentLabel}  Cd ${m.cd.toFixed(3)}  Cl ${m.cl.toFixed(3)}${settling}`,
      `Method: 2D lattice-Boltzmann slice ${GRID_NX}x${GRID_NY}`,
      `Reynolds number (lattice): ${Math.round(m.re)}`,
      'LIMITATIONS: 2D centreline approximation; relative comparison only;',
      'validate with 3D CFD or a real wind tunnel before decisions.',
    ];
    this.setText('report-text', lines.join('\n'));

    const credit = creditOf(lab.modelId) || (a ? creditOf(a.modelId) : '');
    this.setProp('credit-text', 'display', credit ? 'flex' : 'none');
    if (credit) this.setText('credit-text', credit);
  }
}
