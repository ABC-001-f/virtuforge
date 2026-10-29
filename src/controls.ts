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
import { AngleDial, ShapeHandle, WindLever } from './aero-components.js';
import { ANGLE_LIMITS, emit, lab, on, type HandleWorld } from './aero/lab-state.js';
import { DIAL_POSITION, LEVER_RAIL, MAX_WIND_KMH, MIN_WIND_KMH } from './aero/tunnel.js';
import { CAR_PARAM_LIMITS, type CarParam } from './aero/types.js';

/**
 * Hand controls: the wind-speed lever (a knob that slides along LEVER_RAIL),
 * the angle knob (pinch it and lift your hand to raise the nose, lower it to
 * drop the nose; it springs back to its base on release) and the shape
 * handles (grabbable spheres on the parametric car, one per lab.handleAnchors
 * entry, each sliding along one world axis).
 *
 * GrabSystem runs at priority -3, so this system (default priority 0) runs
 * after it each frame and its rail / axis constraints win over the raw grab.
 * Lab events are throttled while dragging and flushed once on release.
 */

const WIND_EMIT_INTERVAL = 0.1;   // s, ~10 Hz
const ANGLE_EMIT_INTERVAL = 0.1;  // s, ~10 Hz
const SHAPE_EMIT_INTERVAL = 0.125; // s, ~8 Hz
/** Degrees of model angle per metre the angle knob is lifted (10 cm = 20 deg). */
const DIAL_GAIN = 200;
/** How far the angle knob can travel up or down from its base. */
const DIAL_TRAVEL = 0.1;
const HOVER_SCALE = 1.3;
const HANDLE_RADIUS = 0.015;
const HALO_RADIUS = 0.022;
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

export class ControlsSystem extends createSystem({
  lever: { required: [WindLever] },
  heldLever: { required: [WindLever, Grabbed] },
  dial: { required: [AngleDial] },
  heldDial: { required: [AngleDial, Grabbed] },
  handles: { required: [ShapeHandle] },
  heldHandles: { required: [ShapeHandle, Grabbed] },
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

  // Handles
  private readonly records = new Map<CarParam, HandleRecord>();
  private readonly recordsByEntity = new Map<Entity, HandleRecord>();
  private shapePending = false;
  private lastShapeEmit = -1;

  // Shared handle resources (never disposed per entity).
  private coreGeometry!: SphereGeometry;
  private haloGeometry!: SphereGeometry;
  private coreMaterial!: MeshBasicMaterial;
  private haloMaterial!: MeshBasicMaterial;

  // Scratch
  private readonly tmpVec = new Vector3();

  init(): void {
    this.coreGeometry = new SphereGeometry(HANDLE_RADIUS, 20, 14);
    this.haloGeometry = new SphereGeometry(HALO_RADIUS, 20, 14);
    this.coreMaterial = new MeshBasicMaterial({ color: 0x4ff3ff });
    this.haloMaterial = new MeshBasicMaterial({
      color: 0x4ff3ff,
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
      on('explode', () => this.refreshHandleVisibility()),
    );
    this.syncHandles();

    this.cleanupFuncs.push(() => {
      for (const rec of this.records.values()) rec.entity.destroy();
      this.records.clear();
      this.recordsByEntity.clear();
      this.coreGeometry.dispose();
      this.haloGeometry.dispose();
      this.coreMaterial.dispose();
      this.haloMaterial.dispose();
    });
  }

  update(delta: number): void {
    this.clock += delta;
    this.updateLever();
    this.updateDial();
    this.updateHandles();
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

  // ---- Shape handles ----

  private createHandle(param: CarParam): HandleRecord {
    const core = new Mesh(this.coreGeometry, this.coreMaterial);
    core.userData.noSilhouette = true;
    const halo = new Mesh(this.haloGeometry, this.haloMaterial);
    halo.userData.noSilhouette = true;
    halo.renderOrder = 2;
    core.add(halo);

    const entity = this.world.createTransformEntity(core);
    entity.addComponent(ShapeHandle, { param });
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      rotate: false,
      scale: false,
    });

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
    const obj = rec.entity.object3D;
    if (obj) {
      this.tmpVec.set(0, PARK_Y, 0);
      setWorldPosition(obj, this.tmpVec);
      obj.visible = false;
    }
  }

  /** Match handle entities to lab.handleAnchors (event-time, may allocate). */
  private syncHandles(): void {
    const wanted = new Set<CarParam>();
    for (const anchor of lab.handleAnchors) {
      wanted.add(anchor.param);
      const rec = this.records.get(anchor.param) ?? this.createHandle(anchor.param);
      rec.parked = false;
      if (rec.held) continue; // the drag owns its position
      const obj = rec.entity.object3D;
      if (!obj) continue;
      this.tmpVec.set(anchor.world[0], anchor.world[1], anchor.world[2]);
      setWorldPosition(obj, this.tmpVec);
    }
    for (const rec of [...this.records.values()]) {
      if (wanted.has(rec.param)) continue;
      if (rec.held) rec.parked = true;
      else this.parkHandle(rec);
    }
    this.refreshHandleVisibility();
  }

  private refreshHandleVisibility(): void {
    const show = !lab.exploded && lab.handleAnchors.length > 0;
    for (const rec of this.records.values()) {
      const obj = rec.entity.object3D;
      if (obj) obj.visible = show && !rec.parked;
    }
  }

  private beginHandleDrag(entity: Entity): void {
    const rec = this.recordsByEntity.get(entity);
    const obj = entity.object3D;
    if (!rec || !obj) return;
    rec.held = true;
    obj.getWorldPosition(rec.start);
    const anchor = findAnchor(rec.param);
    const params = lab.carParams;
    if (!anchor || !params || anchor.metresPerUnit === 0 || lab.exploded) {
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
      const obj = entity.object3D;
      if (anchor && obj) {
        this.tmpVec.set(anchor.world[0], anchor.world[1], anchor.world[2]);
        setWorldPosition(obj, this.tmpVec);
      }
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
}
