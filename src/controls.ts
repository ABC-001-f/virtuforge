import {
  AdditiveBlending,
  createSystem,
  DistanceGrabbable,
  Grabbed,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  RayInteractable,
  setWorldPosition,
  SphereGeometry,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import { AngleDial, PartHandle, ShapeHandle, WindLever } from './aero-components.js';
import { ANGLE_LIMITS, emit, lab, on, type HandleWorld, type PartWorld } from './aero/lab-state.js';
import { DIAL_POSITION, LEVER_RAIL, MAX_WIND_KMH, MIN_WIND_KMH } from './aero/tunnel.js';
import { CAR_PARAM_LIMITS, type CarParam } from './aero/types.js';

/**
 * Hand controls: the wind-speed lever (a knob that slides along LEVER_RAIL),
 * the angle knob (pinch it and lift your hand to raise the nose, lower it to
 * drop the nose; it springs back to its base on release), the shape handles
 * (grabbable spheres on the parametric car, one per lab.handleAnchors entry,
 * each sliding along one world axis) and the part handles (orange spheres on
 * every movable part while part-edit mode is on, one per lab.partAnchors
 * entry, dragged freely in the tunnel's x/y plane).
 *
 * GrabSystem runs at priority -3, so this system (default priority 0) runs
 * after it each frame and its rail / axis constraints win over the raw grab.
 * Lab events are throttled while dragging and flushed once on release.
 */

const WIND_EMIT_INTERVAL = 0.1;   // s, ~10 Hz
const ANGLE_EMIT_INTERVAL = 0.1;  // s, ~10 Hz
const SHAPE_EMIT_INTERVAL = 0.125; // s, ~8 Hz
const PART_EMIT_INTERVAL = 0.1;   // s, ~10 Hz
/** Degrees of model angle per metre the angle knob is lifted (10 cm = 20 deg). */
const DIAL_GAIN = 200;
/** How far the angle knob can travel up or down from its base. */
const DIAL_TRAVEL = 0.1;
const HOVER_SCALE = 1.3;
const HANDLE_RADIUS = 0.015;
const HALO_RADIUS = 0.022;
const SHAPE_COLOR = 0x4ff3ff;
const PART_COLOR = 0xffb347;
/** Where unused handles wait, far below the floor (out of sight and out of ray reach). */
const PARK_Y = -10;

interface HandleRecord {
  entity: Entity;
  param: CarParam;
  /** Drag in progress with a valid anchor and car. */
  active: boolean;
  held: boolean;
  /** No anchor for this param right now: hidden and out of reach (or parks on release if held). */
  parked: boolean;
  axis: 'x' | 'y';
  metresPerUnit: number;
  startValue: number;
  start: Vector3;
}

interface PartRecord {
  entity: Entity;
  index: number;
  active: boolean;
  held: boolean;
  parked: boolean;
  start: Vector3;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function findAnchor(param: CarParam): HandleWorld | null {
  const anchors = lab.handleAnchors;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].param === param) return anchors[i];
  }
  return null;
}

function findPartAnchor(index: number): PartWorld | null {
  const anchors = lab.partAnchors;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].index === index) return anchors[i];
  }
  return null;
}

export class ControlsSystem extends createSystem({
  lever: { required: [WindLever] },
  heldLever: { required: [WindLever, Grabbed] },
  dial: { required: [AngleDial] },
  heldDial: { required: [AngleDial, Grabbed] },
  handles: { required: [ShapeHandle] },
  heldHandles: { required: [ShapeHandle, Grabbed] },
  partHandles: { required: [PartHandle] },
  heldParts: { required: [PartHandle, Grabbed] },
}) {
  private clock = 0;

  // Lever
  private windPending = false;
  private lastWindEmit = -1;

  // Dial
  private dialHeld = false;
  private dialStartAngle = 0;
  private anglePending = false;
  private lastAngleEmit = -1;

  // Shape handles
  private readonly records = new Map<CarParam, HandleRecord>();
  private readonly recordsByEntity = new Map<Entity, HandleRecord>();
  private shapePending = false;
  private lastShapeEmit = -1;

  // Part handles
  private readonly partRecords = new Map<number, PartRecord>();
  private readonly partsByEntity = new Map<Entity, PartRecord>();
  private partPending = false;
  private lastPartEmit = -1;

  // Shared handle resources (never disposed per entity).
  private coreGeometry!: SphereGeometry;
  private haloGeometry!: SphereGeometry;
  private coreMaterial!: MeshBasicMaterial;
  private haloMaterial!: MeshBasicMaterial;
  private partCoreMaterial!: MeshBasicMaterial;
  private partHaloMaterial!: MeshBasicMaterial;

  // Scratch
  private readonly tmpVec = new Vector3();

  init(): void {
    this.coreGeometry = new SphereGeometry(HANDLE_RADIUS, 20, 14);
    this.haloGeometry = new SphereGeometry(HALO_RADIUS, 20, 14);
    this.coreMaterial = new MeshBasicMaterial({ color: SHAPE_COLOR });
    this.haloMaterial = new MeshBasicMaterial({
      color: SHAPE_COLOR,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.partCoreMaterial = new MeshBasicMaterial({ color: PART_COLOR });
    this.partHaloMaterial = new MeshBasicMaterial({
      color: PART_COLOR,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    // Lever: start the knob at the position matching the current wind speed.
    this.cleanupFuncs.push(
      this.queries.lever.subscribe(
        'qualify',
        (entity) => {
          const obj = entity.object3D;
          if (!obj) return;
          const t = (lab.windKmh - MIN_WIND_KMH) / (MAX_WIND_KMH - MIN_WIND_KMH);
          this.tmpVec.set(
            LEVER_RAIL.minX + clamp(t, 0, 1) * (LEVER_RAIL.maxX - LEVER_RAIL.minX),
            LEVER_RAIL.y,
            LEVER_RAIL.z,
          );
          setWorldPosition(obj, this.tmpVec);
        },
        true,
      ),
      this.queries.heldLever.subscribe('disqualify', () => {
        this.flushWind();
      }),
    );

    // Angle knob: measure lift from its base while held.
    this.cleanupFuncs.push(
      this.queries.heldDial.subscribe(
        'qualify',
        () => {
          this.dialHeld = true;
          this.dialStartAngle = lab.angleDeg;
        },
        true,
      ),
      this.queries.heldDial.subscribe('disqualify', () => {
        this.dialHeld = false;
        this.flushAngle();
      }),
    );

    // Shape handles.
    this.cleanupFuncs.push(
      this.queries.heldHandles.subscribe(
        'qualify',
        (entity) => this.beginHandleDrag(entity),
        true,
      ),
      this.queries.heldHandles.subscribe('disqualify', (entity) => this.endHandleDrag(entity)),
      on('handles', () => this.syncHandles()),
    );
    this.syncHandles();

    // Part handles.
    this.cleanupFuncs.push(
      this.queries.heldParts.subscribe(
        'qualify',
        (entity) => this.beginPartDrag(entity),
        true,
      ),
      this.queries.heldParts.subscribe('disqualify', (entity) => this.endPartDrag(entity)),
      on('parts', () => this.syncParts()),
      on('partEdit', () => this.refreshVisibility()),
      on('explode', () => this.refreshVisibility()),
    );
    this.syncParts();

    this.cleanupFuncs.push(() => {
      for (const rec of this.records.values()) rec.entity.destroy();
      for (const rec of this.partRecords.values()) rec.entity.destroy();
      this.records.clear();
      this.recordsByEntity.clear();
      this.partRecords.clear();
      this.partsByEntity.clear();
      this.coreGeometry.dispose();
      this.haloGeometry.dispose();
      this.coreMaterial.dispose();
      this.haloMaterial.dispose();
      this.partCoreMaterial.dispose();
      this.partHaloMaterial.dispose();
    });
  }

  update(delta: number): void {
    this.clock += delta;
    this.updateLever();
    this.updateDial();
    this.updateHandles();
    this.updateParts();
  }

  // ---- Lever ----

  private updateLever(): void {
    for (const entity of this.queries.lever.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      // Keep the knob on its rail whether held or not.
      obj.getWorldPosition(this.tmpVec);
      const x = clamp(this.tmpVec.x, LEVER_RAIL.minX, LEVER_RAIL.maxX);
      if (this.tmpVec.x !== x || this.tmpVec.y !== LEVER_RAIL.y || this.tmpVec.z !== LEVER_RAIL.z) {
        this.tmpVec.set(x, LEVER_RAIL.y, LEVER_RAIL.z);
        setWorldPosition(obj, this.tmpVec);
      }
      if (!entity.hasComponent(Grabbed)) continue;

      const t = (x - LEVER_RAIL.minX) / (LEVER_RAIL.maxX - LEVER_RAIL.minX);
      const kmh = clamp(
        Math.round((MIN_WIND_KMH + t * (MAX_WIND_KMH - MIN_WIND_KMH)) / 5) * 5,
        MIN_WIND_KMH,
        MAX_WIND_KMH,
      );
      if (kmh !== lab.windKmh) {
        lab.windKmh = kmh;
        this.windPending = true;
      }
    }
    if (this.windPending && this.clock - this.lastWindEmit >= WIND_EMIT_INTERVAL) this.flushWind();
  }

  private flushWind(): void {
    if (!this.windPending) return;
    this.windPending = false;
    this.lastWindEmit = this.clock;
    emit('wind');
  }

  // ---- Dial ----

  private updateDial(): void {
    const baseY = DIAL_POSITION[1];
    for (const entity of this.queries.dial.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      obj.getWorldPosition(this.tmpVec);
      // Held: slide only vertically within its travel. Released: spring home.
      const y = this.dialHeld
        ? clamp(this.tmpVec.y, baseY - DIAL_TRAVEL, baseY + DIAL_TRAVEL)
        : this.tmpVec.y + (baseY - this.tmpVec.y) * 0.2;
      if (this.tmpVec.x !== DIAL_POSITION[0] || this.tmpVec.z !== DIAL_POSITION[2] || this.tmpVec.y !== y) {
        this.tmpVec.set(DIAL_POSITION[0], y, DIAL_POSITION[2]);
        setWorldPosition(obj, this.tmpVec);
        obj.quaternion.identity();
      }
      if (!this.dialHeld) continue;

      const angle = Math.round(
        clamp(this.dialStartAngle + (y - baseY) * DIAL_GAIN, ANGLE_LIMITS[0], ANGLE_LIMITS[1]),
      );
      if (angle !== lab.angleDeg) {
        lab.angleDeg = angle;
        this.anglePending = true;
      }
    }
    if (this.anglePending && this.clock - this.lastAngleEmit >= ANGLE_EMIT_INTERVAL) this.flushAngle();
  }

  private flushAngle(): void {
    if (!this.anglePending) return;
    this.anglePending = false;
    this.lastAngleEmit = this.clock;
    emit('angle');
  }

  // ---- Handle spheres (shared by shape and part handles) ----

  private createSphere(core: MeshBasicMaterial, halo: MeshBasicMaterial): Mesh {
    const mesh = new Mesh(this.coreGeometry, core);
    mesh.userData.noSilhouette = true;
    const glow = new Mesh(this.haloGeometry, halo);
    glow.userData.noSilhouette = true;
    glow.renderOrder = 2;
    mesh.add(glow);
    return mesh;
  }

  private makeGrabbable(entity: Entity): void {
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      rotate: false,
      scale: false,
    });
  }

  private park(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;
    this.tmpVec.set(0, PARK_Y, 0);
    setWorldPosition(obj, this.tmpVec);
    obj.visible = false;
  }

  private place(entity: Entity, world: [number, number, number]): void {
    const obj = entity.object3D;
    if (!obj) return;
    this.tmpVec.set(world[0], world[1], world[2]);
    setWorldPosition(obj, this.tmpVec);
  }

  /** Shape handles show outside part-edit mode, part handles inside it; neither while exploded. */
  private refreshVisibility(): void {
    const showShape = !lab.exploded && !lab.partEditing && lab.handleAnchors.length > 0;
    for (const rec of this.records.values()) {
      const obj = rec.entity.object3D;
      if (obj) obj.visible = showShape && !rec.parked;
    }
    const showParts = !lab.exploded && lab.partEditing;
    for (const rec of this.partRecords.values()) {
      const obj = rec.entity.object3D;
      if (obj) obj.visible = showParts && !rec.parked;
    }
  }

  // ---- Shape handles ----

  private createHandle(param: CarParam): HandleRecord {
    const sphere = this.createSphere(this.coreMaterial, this.haloMaterial);
    sphere.name = `shape-handle-${param}`;
    const entity = this.world.createTransformEntity(sphere);
    entity.addComponent(ShapeHandle, { param });
    this.makeGrabbable(entity);

    const rec: HandleRecord = {
      entity,
      param,
      active: false,
      held: false,
      parked: false,
      axis: 'y',
      metresPerUnit: 0,
      startValue: 0,
      start: new Vector3(),
    };
    this.records.set(param, rec);
    this.recordsByEntity.set(entity, rec);
    return rec;
  }

  /**
   * Handles are never destroyed (recycled entity ids mixed up handle params);
   * an unused one is parked out of sight and reused when its param returns.
   */
  private parkHandle(rec: HandleRecord): void {
    rec.parked = true;
    this.park(rec.entity);
  }

  /** Match handle entities to lab.handleAnchors (event-time, may allocate). */
  private syncHandles(): void {
    const wanted = new Set<CarParam>();
    for (const anchor of lab.handleAnchors) {
      wanted.add(anchor.param);
      const rec = this.records.get(anchor.param) ?? this.createHandle(anchor.param);
      rec.parked = false;
      if (rec.held) continue; // the drag owns its position
      this.place(rec.entity, anchor.world);
    }
    for (const rec of [...this.records.values()]) {
      if (wanted.has(rec.param)) continue;
      if (rec.held) rec.parked = true;
      else this.parkHandle(rec);
    }
    this.refreshVisibility();
  }

  private beginHandleDrag(entity: Entity): void {
    const rec = this.recordsByEntity.get(entity);
    const obj = entity.object3D;
    if (!rec || !obj) return;
    rec.held = true;
    obj.getWorldPosition(rec.start);
    const anchor = findAnchor(rec.param);
    const params = lab.carParams;
    if (!anchor || !params || anchor.metresPerUnit === 0 || lab.exploded || lab.partEditing) {
      rec.active = false;
      return;
    }
    rec.active = true;
    rec.axis = anchor.axis;
    rec.metresPerUnit = anchor.metresPerUnit;
    rec.startValue = params[rec.param];
    lab.draggingParam = rec.param;
  }

  private endHandleDrag(entity: Entity): void {
    const rec = this.recordsByEntity.get(entity);
    if (!rec) return;
    const wasActive = rec.active;
    rec.held = false;
    rec.active = false;
    if (lab.draggingParam === rec.param) lab.draggingParam = null;
    if (rec.parked) {
      this.parkHandle(rec);
    } else if (!wasActive) {
      // Ignored drag: snap back to the anchor.
      const anchor = findAnchor(rec.param);
      if (anchor) this.place(entity, anchor.world);
    }
    if (wasActive) {
      // Final value; WindTunnelSystem rebuilds and republishes the anchors.
      this.shapePending = false;
      this.lastShapeEmit = this.clock;
      emit('shape');
    }
  }

  private updateHandles(): void {
    for (const entity of this.queries.handles.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      const s = entity.hasComponent(Hovered) || entity.hasComponent(Grabbed) ? HOVER_SCALE : 1;
      if (obj.scale.x !== s) obj.scale.setScalar(s);
    }

    for (const entity of this.queries.heldHandles.entities) {
      const rec = this.recordsByEntity.get(entity);
      const obj = entity.object3D;
      const params = lab.carParams;
      if (!rec || !obj) continue;
      if (!rec.active || !params) {
        setWorldPosition(obj, rec.start); // pin an ignored drag in place
        continue;
      }

      obj.getWorldPosition(this.tmpVec);
      const disp = rec.axis === 'x' ? this.tmpVec.x - rec.start.x : this.tmpVec.y - rec.start.y;
      const limits = CAR_PARAM_LIMITS[rec.param];
      const value = clamp(rec.startValue + disp / rec.metresPerUnit, limits[0], limits[1]);

      // Constrain to the axis and to the clamped value's travel.
      const travel = (value - rec.startValue) * rec.metresPerUnit;
      this.tmpVec.copy(rec.start);
      if (rec.axis === 'x') this.tmpVec.x += travel;
      else this.tmpVec.y += travel;
      setWorldPosition(obj, this.tmpVec);

      if (Math.abs(params[rec.param] - value) > 1e-4) {
        params[rec.param] = value;
        this.shapePending = true;
      }
    }

    if (this.shapePending && this.clock - this.lastShapeEmit >= SHAPE_EMIT_INTERVAL) {
      this.shapePending = false;
      this.lastShapeEmit = this.clock;
      emit('shape');
    }
  }

  // ---- Part handles ----

  private createPartHandle(index: number): PartRecord {
    const sphere = this.createSphere(this.partCoreMaterial, this.partHaloMaterial);
    sphere.name = `part-handle-${index}`;
    const entity = this.world.createTransformEntity(sphere);
    entity.addComponent(PartHandle, { index });
    this.makeGrabbable(entity);
    const rec: PartRecord = { entity, index, active: false, held: false, parked: false, start: new Vector3() };
    this.partRecords.set(index, rec);
    this.partsByEntity.set(entity, rec);
    return rec;
  }

  private parkPart(rec: PartRecord): void {
    rec.parked = true;
    this.park(rec.entity);
  }

  /** Match part-handle entities to lab.partAnchors (event-time, may allocate). */
  private syncParts(): void {
    const wanted = new Set<number>();
    for (const anchor of lab.partAnchors) {
      if (!anchor.handle) continue;
      wanted.add(anchor.index);
      const rec = this.partRecords.get(anchor.index) ?? this.createPartHandle(anchor.index);
      rec.parked = false;
      if (rec.held) continue;
      this.place(rec.entity, anchor.world);
    }
    for (const rec of [...this.partRecords.values()]) {
      if (wanted.has(rec.index)) continue;
      if (rec.held) rec.parked = true;
      else this.parkPart(rec);
    }
    this.refreshVisibility();
  }

  private beginPartDrag(entity: Entity): void {
    const rec = this.partsByEntity.get(entity);
    const obj = entity.object3D;
    if (!rec || !obj) return;
    rec.held = true;
    obj.getWorldPosition(rec.start);
    const anchor = findPartAnchor(rec.index);
    if (!anchor || !anchor.handle || lab.exploded || !lab.partEditing || lab.draggingPart !== null) {
      rec.active = false;
      return;
    }
    rec.active = true;
    lab.draggingPart = rec.index;
  }

  private endPartDrag(entity: Entity): void {
    const rec = this.partsByEntity.get(entity);
    if (!rec) return;
    const wasActive = rec.active;
    rec.held = false;
    rec.active = false;
    if (rec.parked) {
      this.parkPart(rec);
    } else if (!wasActive) {
      const anchor = findPartAnchor(rec.index);
      if (anchor) this.place(entity, anchor.world);
    }
    if (wasActive && lab.draggingPart === rec.index) {
      // Final position, then tell WindTunnelSystem the drag is over so it republishes the anchor.
      const obj = entity.object3D;
      if (obj) {
        obj.getWorldPosition(this.tmpVec);
        lab.partDragWorld = [this.tmpVec.x, this.tmpVec.y, rec.start.z];
      }
      this.partPending = false;
      this.lastPartEmit = this.clock;
      emit('partMove');
      lab.draggingPart = null;
      emit('partMove');
    }
  }

  private updateParts(): void {
    for (const entity of this.queries.partHandles.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      const s = entity.hasComponent(Hovered) || entity.hasComponent(Grabbed) ? HOVER_SCALE : 1;
      if (obj.scale.x !== s) obj.scale.setScalar(s);
    }

    for (const entity of this.queries.heldParts.entities) {
      const rec = this.partsByEntity.get(entity);
      const obj = entity.object3D;
      if (!rec || !obj) continue;
      if (!rec.active) {
        setWorldPosition(obj, rec.start);
        continue;
      }
      // Free in the tunnel plane (x = along the flow, y = up); depth stays put.
      obj.getWorldPosition(this.tmpVec);
      if (this.tmpVec.z !== rec.start.z) {
        this.tmpVec.z = rec.start.z;
        setWorldPosition(obj, this.tmpVec);
      }
      const w = lab.partDragWorld;
      if (w[0] !== this.tmpVec.x || w[1] !== this.tmpVec.y || w[2] !== this.tmpVec.z) {
        w[0] = this.tmpVec.x;
        w[1] = this.tmpVec.y;
        w[2] = this.tmpVec.z;
        this.partPending = true;
      }
    }

    if (this.partPending && this.clock - this.lastPartEmit >= PART_EMIT_INTERVAL) {
      this.partPending = false;
      this.lastPartEmit = this.clock;
      emit('partMove');
    }
  }
}
