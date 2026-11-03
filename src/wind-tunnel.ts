/**
 * WindTunnelSystem: owns the model inside the tunnel, the LBM solver client,
 * the flow visuals, the pressure skin, metrics, shape-handle and part anchors,
 * part edits (move / hide), the exploded view and the design-A ghost.
 *
 * Scene graph (all under the `tunnel` node, tunnel-local frame):
 *   tunnel
 *   ├─ FlowViz.object
 *   └─ ModelPivot (entity; position = fit centre, rotation.z = -angle)
 *      ├─ model root (scale = fit.scale, centred on the pivot)
 *      └─ ghost of design A (same transform as the model)
 *
 * Results are a 2D educational approximation for comparing designs, not validated CFD.
 */

import {
  AssetManager,
  Box3,
  createSystem,
  Group,
  MeshBasicMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity, Mesh, Object3D } from '@iwsdk/core';
import { CUSTOM_MODEL_ID, GLTF_MODELS } from './aero/catalog.js';
import { FlowViz } from './aero/flow-viz.js';
import { clearPartEdits, emit, lab, on, partEdit, partKey, DEFAULT_CAR_PARAMS } from './aero/lab-state.js';
import type { HandleWorld, PartEdit, PartWorld } from './aero/lab-state.js';
import { getCustomModel, orientModel } from './aero/model-import.js';
import { buildAirplane, buildDrone, buildWing } from './aero/models/aircraft.js';
import { buildCar, disposeCar } from './aero/models/car.js';
import { PressureSkin } from './aero/pressure-skin.js';
import { computeFit, rasterizeSilhouette } from './aero/silhouette.js';
import type { Fit } from './aero/silhouette.js';
import { SolverClient } from './aero/solver-client.js';
import type { FlowFrame } from './aero/solver-client.js';
import { GRID_NX, GRID_NY, MAX_WIND_KMH, windToLattice } from './aero/tunnel.js';
import { isCarId, modelInfo } from './aero/types.js';
import type { HandleAnchor, ModelId, ModelInfo } from './aero/types.js';

const DEG = Math.PI / 180;
const SHAPE_REBUILD_INTERVAL = 1 / 6;    // seconds between car rebuilds while dragging
const PART_MASK_INTERVAL = 1 / 8;        // seconds between silhouette updates while a part is dragged
const METRICS_INTERVAL_MS = 250;         // metrics emitted at most 4x/s
const EXPLODE_DISTANCE = 0.6;            // model-local units (car length = 1)
const EXPLODE_RATE = 5;                  // 1/s, exponential approach
const FAN_MAX_SPIN = 30;                 // rad/s at MAX_WIND_KMH
/** A very detailed import gets handles on its largest parts only; the rest stay listed. */
const MAX_PART_HANDLES = 24;
/** World metres a part handle floats in front of its part (handle radius 15 mm + a gap). */
const PART_HANDLE_STANDOFF = 0.02;
/** Minimum world distance between two part handles (two handle diameters plus a gap). */
const PART_HANDLE_SPACING = 0.04;

/** One ghost material shared by every design-A ghost. */
const GHOST_MAT = new MeshBasicMaterial({
  color: 0x22e5ff,
  wireframe: true,
  transparent: true,
  opacity: 0.25,
  depthWrite: false,
});

/** Everything known about the model currently in the tunnel. */
interface LoadedModel {
  id: ModelId;
  info: ModelInfo;
  root: Object3D;
  fit: Fit;
  handles: HandleAnchor[];
  /** Parts (exploded view + part editing): rest positions as built, current rest (with edits), explode offsets. */
  parts: Object3D[];
  names: string[];
  rest0: Vector3[];
  rest: Vector3[];
  offset: Vector3[];
  /** Which parts get a grab handle (largest MAX_PART_HANDLES). */
  handleable: boolean[];
  /** Procedural car: its per-build geometries are ours to dispose. */
  ownsGeometry: boolean;
}

/** A part drag in progress: where the handle started and the edit it started from. */
interface PartDrag {
  index: number;
  anchorWorld: Vector3;
  offset0: [number, number, number];
}

/** Every mesh under `root`, in traversal order, with a readable name each. */
function collectMeshParts(root: Object3D): { parts: Object3D[]; names: string[] } {
  const parts: Object3D[] = [];
  const names: string[] = [];
  root.traverse((obj) => {
    if (!(obj as Mesh).isMesh) return;
    parts.push(obj);
    const own = obj.name || obj.parent?.name || '';
    names.push(own ? own : `Part ${parts.length}`);
  });
  return { parts, names };
}

export class WindTunnelSystem extends createSystem({}) {
  private ready = false;
  private tunnelEntity!: Entity;
  private tunnelObject!: Object3D;
  private pivot!: Group;
  private fan: Object3D | null = null;
  private flowViz!: FlowViz;
  private solver!: SolverClient;
  private skin!: PressureSkin;

  private readonly mask = new Uint8Array(GRID_NX * GRID_NY);
  private current: LoadedModel | null = null;
  private ghost: Object3D | null = null;
  private ghostOwnsGeometry = false;
  private drag: PartDrag | null = null;

  private loadToken = 0;
  private maskDirty = false;
  private shapePending = false;
  private sinceShapeBuild = SHAPE_REBUILD_INTERVAL;
  private partMaskPending = false;
  private sincePartMask = PART_MASK_INTERVAL;
  private explodeT = 0;
  private lastMetricsEmit = 0;
  private lastSettled = false;
  private readonly scratch = new Vector3();
  private readonly scratch2 = new Vector3();
  private readonly scratchBox = new Box3();

  init(): void {
    // The scene JSON may still be loading; finish setup once the tunnel node exists.
    this.trySetup();
    this.cleanupFuncs.push(() => this.teardown());
  }

  private trySetup(): boolean {
    if (this.ready) return true;
    const tunnelEntity = this.world.getSceneEntity('tunnel');
    const tunnelObject = tunnelEntity?.object3D;
    if (!tunnelEntity || !tunnelObject) return false;
    this.ready = true;
    this.tunnelEntity = tunnelEntity;
    this.tunnelObject = tunnelObject;
    this.fan = tunnelObject.getObjectByName('tunnel-fan') ?? null;

    this.pivot = new Group();
    this.pivot.name = 'ModelPivot';
    this.world.createTransformEntity(this.pivot, { parent: this.tunnelEntity });

    this.flowViz = new FlowViz();
    tunnelObject.add(this.flowViz.object);
    this.flowViz.setMode(lab.view);

    this.skin = new PressureSkin(this.flowViz.skinTexture);

    this.solver = new SolverClient();
    this.solver.onFrame = (frame) => this.onFrame(frame);
    this.solver.onError = (message) => this.setStatus(`Solver stopped: ${message} - reload the page`);

    const subs = [
      on('model', () => this.loadModel(lab.modelId)),
      on('shape', () => {
        if (this.current && isCarId(this.current.id)) this.shapePending = true;
      }),
      on('angle', () => this.applyAngle()),
      on('wind', () => this.applyWind()),
      on('view', () => this.flowViz.setMode(lab.view)),
      on('skin', () => this.applySkin()),
      on('explode', () => this.applyWind()),
      on('saveA', () => this.saveA()),
      on('clearA', () => this.clearA()),
      on('partMove', () => this.onPartMove()),
      on('partVisibility', () => this.applyPartEdits(true)),
      on('resetParts', () => this.resetParts()),
      on('custom', () => {
        if (lab.modelId === CUSTOM_MODEL_ID && lab.customModel) this.loadModel(CUSTOM_MODEL_ID);
      }),
    ];
    for (const unsubscribe of subs) this.cleanupFuncs.push(unsubscribe);

    this.applyWind();
    this.loadModel(lab.modelId);
    return true;
  }

  update(delta: number): void {
    if (!this.ready && !this.trySetup()) return;

    // Throttled car rebuild while a shape handle is dragged (the last change always lands).
    this.sinceShapeBuild += delta;
    if (this.shapePending && this.sinceShapeBuild >= SHAPE_REBUILD_INTERVAL) {
      this.shapePending = false;
      this.sinceShapeBuild = 0;
      this.rebuildCar();
    }

    // Throttled silhouette update while a part is dragged.
    this.sincePartMask += delta;
    if (this.partMaskPending && this.sincePartMask >= PART_MASK_INTERVAL) {
      this.partMaskPending = false;
      this.sincePartMask = 0;
      this.maskDirty = true;
    }

    this.animateExplode(delta);

    // The mask always reflects the assembled model.
    if (this.maskDirty && this.explodeT === 0 && this.current) {
      this.maskDirty = false;
      this.tunnelObject.updateMatrixWorld(true);
      const info = rasterizeSilhouette(this.current.root, this.tunnelObject, this.mask);
      this.solver.setMask(this.mask, info.frontalCells, info.lengthCells);
    }

    this.flowViz.tick(delta);
    this.skin.update(this.tunnelObject);

    if (this.fan && lab.windOn && !lab.exploded) {
      this.fan.rotation.x += delta * FAN_MAX_SPIN * (lab.windKmh / MAX_WIND_KMH);
    }
  }

  // ---- Solver ----

  private onFrame(frame: FlowFrame): void {
    this.flowViz.update(frame, this.mask);
    const m = lab.metrics;
    m.cd = frame.cd;
    m.cl = frame.cl;
    m.re = frame.re;
    m.stepsPerSecond = frame.stepsPerSecond;
    m.settled = frame.settled;

    if (frame.settled !== this.lastSettled) {
      this.lastSettled = frame.settled;
      if (lab.windOn && !lab.exploded && this.current) this.setStatus(this.windStatus());
    }

    const now = performance.now();
    if (now - this.lastMetricsEmit >= METRICS_INTERVAL_MS) {
      this.lastMetricsEmit = now;
      emit('metrics');
    }
  }

  private applyWind(): void {
    const running = lab.windOn && !lab.exploded;
    this.solver.setWind(windToLattice(lab.windKmh));
    this.solver.setRunning(running);
    this.flowViz.setFlowing(running);
    this.lastSettled = false;
    if (this.current) this.setStatus(this.windStatus());
  }

  private windStatus(): string {
    if (lab.exploded) return 'Exploded view - inspect the parts';
    if (!lab.windOn) return 'Wind off';
    const speed = `Wind on - ${Math.round(lab.windKmh)} km/h`;
    return this.lastSettled ? `${speed} - flow settled (2D approximation)` : `${speed} - flow settling...`;
  }

  private setStatus(text: string): void {
    if (lab.status === text) return;
    lab.status = text;
    emit('status');
  }

  // ---- Model loading ----

  private loadModel(id: ModelId): void {
    const token = ++this.loadToken;
    const info = modelInfo(id);
    this.shapePending = false;
    this.partMaskPending = false;
    this.drag = null;
    this.clearGhost();

    if (info.source === 'custom') {
      this.loadCustom(token);
      return;
    }

    if (info.source === 'gltf') {
      const entry = GLTF_MODELS.find((m) => m.id === id);
      this.setStatus(`Loading ${info.label.replace(/ \(.*\)$/u, '')}...`);
      AssetManager.loadGLTFById(id)
        .then((gltf) => {
          if (token !== this.loadToken) return;   // a newer selection won
          const { root } = orientModel(gltf.scene.clone(true), entry?.orientation);
          root.name = `model-${id}`;
          const { parts, names } = collectMeshParts(root);
          this.install(id, info, root, parts, names, [], false);
        })
        .catch((err: unknown) => {
          if (token !== this.loadToken) return;
          console.error('[WindTunnel] failed to load', id, err);
          this.setStatus(`Could not load ${info.label}`);
        });
      return;
    }

    if (isCarId(id)) {
      if (!lab.carParams) lab.carParams = { ...DEFAULT_CAR_PARAMS[id] };
      const built = buildCar(lab.carParams, id);
      this.install(id, info, built.root, built.parts, built.parts.map((p) => p.name), built.handles, true);
      return;
    }

    const built = id === 'airplane' ? buildAirplane() : id === 'drone' ? buildDrone() : buildWing();
    this.install(id, info, built.root, built.parts, built.parts.map((p) => p.name), built.handles, false);
  }

  /** The user's imported model: staged by src/aero/model-import.ts, oriented per its settings. */
  private loadCustom(token: number): void {
    this.setStatus('Loading your model...');
    getCustomModel()
      .then((custom) => {
        if (token !== this.loadToken) return;
        if (!custom) {
          this.removeCurrent();
          this.publishHandles();
          this.publishParts();
          this.setStatus('No imported model yet - use Import model on the browser page');
          return;
        }
        const meta = custom.meta;
        const { root } = orientModel(custom.cloneScene(), meta.orientation, meta.flipNose);
        root.name = `model-${CUSTOM_MODEL_ID}`;
        const info: ModelInfo = {
          id: CUSTOM_MODEL_ID,
          label: meta.name,
          kind: meta.kind,
          source: 'custom',
          credit: `Imported model: ${custom.fileName} (${(custom.bytes / 1048576).toFixed(1)} MB)`,
        };
        const { parts, names } = collectMeshParts(root);
        this.install(CUSTOM_MODEL_ID, info, root, parts, names, [], false);
      })
      .catch((err: unknown) => {
        if (token !== this.loadToken) return;
        console.error('[WindTunnel] failed to load the imported model', err);
        this.setStatus('Could not load your model - import it again');
      });
  }

  /** Rebuild the parametric car after a shape change, keeping the ghost. */
  private rebuildCar(): void {
    const cur = this.current;
    if (!cur || !isCarId(cur.id) || !lab.carParams) return;
    const built = buildCar(lab.carParams, cur.id);
    this.install(cur.id, cur.info, built.root, built.parts, built.parts.map((p) => p.name), built.handles, true);
  }

  /** Swap `root` in as the current model: fit, place, explode data, part edits, skin, handles, mask. */
  private install(
    id: ModelId,
    info: ModelInfo,
    root: Object3D,
    parts: Object3D[],
    names: string[],
    handles: HandleAnchor[],
    ownsGeometry: boolean,
  ): void {
    this.removeCurrent();

    const explode = this.explodeData(root, parts);
    const fit = computeFit(root, info.kind);
    root.scale.setScalar(fit.scale);
    // fit.position = centre - scale * nativeBoxCentre, so this centres the model on the pivot.
    root.position.copy(fit.position).sub(fit.center);
    this.pivot.position.copy(fit.center);
    this.pivot.rotation.set(0, 0, -lab.angleDeg * DEG);
    this.pivot.add(root);

    this.current = {
      id,
      info,
      root,
      fit,
      handles,
      parts: explode.parts,
      names: explode.parts === parts ? names : explode.parts.map((p, i) => p.name || `Part ${i + 1}`),
      rest0: explode.rest,
      rest: explode.rest.map((v) => v.clone()),
      offset: explode.offset,
      handleable: explode.handleable,
      ownsGeometry,
    };
    this.applyPartEdits(false);
    this.applyExplodeOffsets();
    if (lab.skin) this.skin.apply(root);
    this.maskDirty = true;
    this.lastSettled = false;
    this.publishHandles();
    this.publishParts();
    this.setStatus(this.windStatus());
  }

  private removeCurrent(): void {
    const cur = this.current;
    if (!cur) return;
    this.skin.remove(cur.root);
    this.pivot.remove(cur.root);
    if (cur.ownsGeometry) disposeCar(cur.root);
    this.current = null;
  }

  // ---- Angle, skin, handles ----

  private applyAngle(): void {
    this.pivot.rotation.z = -lab.angleDeg * DEG;   // nose at -x: nose-up is a negative z rotation
    this.maskDirty = true;
    this.lastSettled = false;
    this.publishHandles();
    this.publishParts();
  }

  private applySkin(): void {
    if (!this.current) return;
    if (lab.skin) this.skin.apply(this.current.root);
    else this.skin.remove(this.current.root);
  }

  private publishHandles(): void {
    const cur = this.current;
    const anchors: HandleWorld[] = [];
    if (cur && cur.handles.length > 0) {
      this.tunnelObject.updateMatrixWorld(true);
      for (const h of cur.handles) {
        let world: [number, number, number];
        const prev = lab.draggingParam === h.param ? lab.handleAnchors.find((a) => a.param === h.param) : undefined;
        if (prev) {
          world = prev.world;   // don't move the handle out from under the user's hand
        } else {
          cur.root.localToWorld(this.scratch.copy(h.local));
          world = [this.scratch.x, this.scratch.y, this.scratch.z];
        }
        anchors.push({ param: h.param, axis: h.axis, world, metresPerUnit: cur.fit.scale });
      }
    }
    lab.handleAnchors = anchors;
    emit('handles');
  }

  // ---- Parts: edit (move / hide) and publish ----

  /** World-space centre of every part (hidden ones included, so the browser list can show them). */
  private publishParts(): void {
    const cur = this.current;
    const anchors: PartWorld[] = [];
    if (cur) {
      this.tunnelObject.updateMatrixWorld(true);
      for (let i = 0; i < cur.parts.length; i++) {
        const edit = lab.partEdits.get(partKey(cur.id, i));
        const hidden = edit?.hidden ?? false;
        const handle = cur.handleable[i] && !hidden;
        const prev = lab.draggingPart === i ? lab.partAnchors.find((a) => a.index === i) : undefined;
        let world: [number, number, number];
        if (prev) {
          world = prev.world;
        } else {
          this.partCentre(cur.parts[i], this.scratch);
          // Parts that share a top edge (a car body and its glass) would stack their
          // handles on one spot; step later ones downstream until they are apart.
          if (handle) {
            for (let guard = 0; guard < 12 && this.handleTooClose(anchors, this.scratch); guard++) {
              this.scratch.x += PART_HANDLE_SPACING;
            }
          }
          world = [this.scratch.x, this.scratch.y, this.scratch.z];
        }
        anchors.push({ index: i, name: cur.names[i], world, hidden, handle });
      }
    }
    lab.partAnchors = anchors;
    emit('parts');
  }

  private handleTooClose(anchors: PartWorld[], p: Vector3): boolean {
    for (const a of anchors) {
      if (!a.handle) continue;
      const dx = a.world[0] - p.x;
      const dy = a.world[1] - p.y;
      const dz = a.world[2] - p.z;
      if (dx * dx + dy * dy + dz * dz < PART_HANDLE_SPACING * PART_HANDLE_SPACING) return true;
    }
    return false;
  }

  /**
   * Where a part's handle goes: above the top-front edge of its bounds (+y,
   * +z toward the seated user). A handle at the part's centre would be buried
   * inside it, where neither eyes nor rays can reach; the top-front corner is
   * clear space from the seat, so the hand ray lands on it before anything else.
   */
  private partCentre(part: Object3D, out: Vector3): Vector3 {
    this.scratchBox.setFromObject(part);
    if (this.scratchBox.isEmpty()) return part.getWorldPosition(out);
    this.scratchBox.getCenter(out);
    out.y = this.scratchBox.max.y + PART_HANDLE_STANDOFF;
    out.z = this.scratchBox.max.z + PART_HANDLE_STANDOFF;
    return out;
  }

  /** Put every part at rest0 + its edit offset and apply its hidden flag. */
  private applyPartEdits(republish: boolean): void {
    const cur = this.current;
    if (!cur) return;
    for (let i = 0; i < cur.parts.length; i++) {
      const edit = lab.partEdits.get(partKey(cur.id, i));
      const part = cur.parts[i];
      const rest = cur.rest[i].copy(cur.rest0[i]);
      if (edit) {
        rest.x += edit.offset[0];
        rest.y += edit.offset[1];
        rest.z += edit.offset[2];
        part.visible = !edit.hidden;
      } else {
        part.visible = true;
      }
      part.position.copy(rest);
    }
    this.applyExplodeOffsets();
    this.maskDirty = true;
    this.lastSettled = false;
    if (republish) {
      this.publishParts();
      this.setStatus(this.windStatus());
    }
  }

  /** ControlsSystem moved a part handle: convert the world travel into the part's parent frame. */
  private onPartMove(): void {
    const cur = this.current;
    if (!cur) return;
    const index = lab.draggingPart;

    if (index === null) {
      // Drag finished: the last 'partMove' already landed; snap the anchor to the new centre.
      if (this.drag) {
        this.drag = null;
        this.partMaskPending = false;
        this.maskDirty = true;
        this.lastSettled = false;
        this.publishParts();
        this.setStatus(this.windStatus());
      }
      return;
    }

    const part = cur.parts[index];
    const anchor = lab.partAnchors.find((a) => a.index === index);
    if (!part || !anchor) return;

    if (!this.drag || this.drag.index !== index) {
      const edit = partEdit(cur.id, index);
      this.drag = {
        index,
        anchorWorld: new Vector3(anchor.world[0], anchor.world[1], anchor.world[2]),
        offset0: [edit.offset[0], edit.offset[1], edit.offset[2]],
      };
    }

    const drag = this.drag;
    const parent = part.parent ?? cur.root;
    this.tunnelObject.updateMatrixWorld(true);
    const now = this.scratch.set(lab.partDragWorld[0], lab.partDragWorld[1], lab.partDragWorld[2]);
    parent.worldToLocal(now);
    const start = parent.worldToLocal(this.scratch2.copy(drag.anchorWorld));
    const edit: PartEdit = partEdit(cur.id, index);
    edit.offset = [
      drag.offset0[0] + (now.x - start.x),
      drag.offset0[1] + (now.y - start.y),
      drag.offset0[2] + (now.z - start.z),
    ];
    const rest = cur.rest[index].copy(cur.rest0[index]);
    rest.x += edit.offset[0];
    rest.y += edit.offset[1];
    rest.z += edit.offset[2];
    part.position.copy(rest);
    this.partMaskPending = true;
    this.setStatus(`Moving ${cur.names[index]}`);
  }

  private resetParts(): void {
    const cur = this.current;
    if (!cur) return;
    clearPartEdits(cur.id);
    this.drag = null;
    this.applyPartEdits(true);
  }

  // ---- Exploded view ----

  /** Rest positions, exploded offsets and handle eligibility, measured with the root at its native transform. */
  private explodeData(
    root: Object3D,
    parts: Object3D[],
  ): { parts: Object3D[]; rest: Vector3[]; offset: Vector3[]; handleable: boolean[] } {
    const list = parts.length > 0 ? parts : root.children.slice();
    root.updateMatrixWorld(true);   // root is parentless and untransformed here: world = model-local
    const modelBox = new Box3().setFromObject(root);
    const modelCentre = modelBox.getCenter(new Vector3());
    const partBox = new Box3();
    const rest: Vector3[] = [];
    const offset: Vector3[] = [];
    const size: number[] = [];
    for (const part of list) {
      rest.push(part.position.clone());
      partBox.setFromObject(part);
      const from = partBox.isEmpty() ? part.getWorldPosition(new Vector3()) : partBox.getCenter(new Vector3());
      size.push(partBox.isEmpty() ? 0 : partBox.getSize(new Vector3()).length());
      const dir = from.clone().sub(modelCentre);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      dir.normalize().multiplyScalar(EXPLODE_DISTANCE);
      const to = from.clone().add(dir);
      // Express the model-local displacement in the part's parent frame.
      const parent = part.parent ?? root;
      offset.push(parent.worldToLocal(to).sub(parent.worldToLocal(from)));
    }
    const ranked = size.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
    const handleable = list.map(() => false);
    for (let k = 0; k < Math.min(MAX_PART_HANDLES, ranked.length); k++) handleable[ranked[k][1]] = true;
    return { parts: list, rest, offset, handleable };
  }

  private animateExplode(delta: number): void {
    const target = lab.exploded ? 1 : 0;
    if (this.explodeT === target) return;
    const k = 1 - Math.exp(-EXPLODE_RATE * delta);
    this.explodeT += (target - this.explodeT) * k;
    if (Math.abs(target - this.explodeT) < 0.002) this.explodeT = target;
    this.applyExplodeOffsets();
  }

  private applyExplodeOffsets(): void {
    const cur = this.current;
    if (!cur) return;
    const t = this.explodeT * this.explodeT * (3 - 2 * this.explodeT);   // smoothstep
    for (let i = 0; i < cur.parts.length; i++) {
      cur.parts[i].position.copy(cur.rest[i]).addScaledVector(cur.offset[i], t);
    }
  }

  // ---- Design A ----

  private saveA(): void {
    const cur = this.current;
    if (!cur) return;
    const car = isCarId(cur.id) && lab.carParams;
    lab.savedA = {
      modelId: cur.id,
      label: cur.info.label,
      cd: lab.metrics.cd,
      cl: lab.metrics.cl,
      windKmh: lab.windKmh,
      angleDeg: lab.angleDeg,
      carParams: car ? { ...lab.carParams! } : null,
    };

    this.clearGhost();
    const ghost = cur.root.clone(true);
    ghost.name = 'design-a-ghost';
    ghost.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      // Procedural car geometry is rebuilt (and disposed) on every reshape: the ghost needs its own copy.
      if (cur.ownsGeometry) mesh.geometry = mesh.geometry.clone();
      mesh.material = GHOST_MAT;
      mesh.userData.noSilhouette = true;
    });
    // Snap ghost parts to the assembled pose even if saved mid-explode (clone keeps traversal order).
    if (this.explodeT > 0) {
      const originals: Object3D[] = [];
      const copies: Object3D[] = [];
      cur.root.traverse((obj) => originals.push(obj));
      ghost.traverse((obj) => copies.push(obj));
      for (let i = 0; i < cur.parts.length; i++) {
        const copy = copies[originals.indexOf(cur.parts[i])];
        if (copy) copy.position.copy(cur.rest[i]);
      }
    }
    this.pivot.add(ghost);
    this.ghost = ghost;
    this.ghostOwnsGeometry = cur.ownsGeometry;
    this.setStatus(`Saved ${cur.info.label} as design A - now change something and compare`);
  }

  private clearA(): void {
    lab.savedA = null;
    this.clearGhost();
    this.setStatus('Design A cleared');
  }

  private clearGhost(): void {
    const ghost = this.ghost;
    if (!ghost) return;
    this.pivot.remove(ghost);
    if (this.ghostOwnsGeometry) {
      ghost.traverse((obj) => {
        const mesh = obj as Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    this.ghost = null;
  }

  private teardown(): void {
    this.loadToken++;
    if (!this.ready) return;
    this.clearGhost();
    this.removeCurrent();
    this.solver.dispose();
    this.skin.dispose();
    this.tunnelObject.remove(this.flowViz.object);
    this.flowViz.dispose();
  }
}
