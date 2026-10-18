import { Vehicle } from '../../../game/engine/sim/vehicle.js';

// Copy mutable vehicle state into a reusable graph. Do not alias the source's
// tyres, controls or optional hybrid fields, or retain fields removed on reset.
function copyState(target, source) {
  for (const k of Object.keys(target)) if (k !== 'spec' && !(k in source)) delete target[k];
  for (const k of Object.keys(source)) {
    if (k === 'spec' || typeof source[k] === 'function') continue;
    const value = source[k];
    if (ArrayBuffer.isView(value)) {
      if (target[k]?.constructor !== value.constructor || target[k].length !== value.length) target[k] = value.slice();
      else target[k].set(value);
    } else if (value && typeof value === 'object') {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k]) !== Array.isArray(value)) {
        target[k] = Array.isArray(value) ? [] : {};
      }
      if (Array.isArray(value)) target[k].length = value.length;
      copyState(target[k], value);
    } else target[k] = value;
  }
  return target;
}

/** Calls the game's unmodified Vehicle.step for a short held-control forecast.
 * Surface deposits happen in pooled private buffers, never in the live world.
 * Wake is held at its observed value; this is not a forecast of future contacts. */
export class HeldPredictor {
  constructor(track) { this.track = track; this.surface = Object.create(track); }
  /** Reset a private plant for either held-control or closed-loop previews. */
  begin(car) {
    if (!this.car || this.car.classId !== car.classId) this.car = new Vehicle(car.id, car.name, car.color, car.classId);
    const predicted = copyState(this.car, car), source = this.track, surface = this.surface;
    if (!Object.hasOwn(surface, 'rubber')) surface.rubber = new Float32Array(source.rubber.length);
    surface.rubber.set(source.rubber);
    if (source.water) {
      if (!this.water || Object.getPrototypeOf(this.water) !== source.water) {
        this.water = Object.create(source.water);
        this.water.depth = new Float32Array(source.water.depth.length);
        this.water.track = surface;
      }
      this.water.depth.set(source.water.depth);
      surface.water = this.water;
    } else surface.water = null;
    return predicted;
  }
  predict(car, seconds, step = 1 / 120) {
    const predicted = this.begin(car), surface = this.surface;
    let remaining = Number.isFinite(seconds) ? Math.max(0, Math.min(0.2, seconds)) : 0;
    const quantum = Number.isFinite(step) && step > 0 ? Math.min(step, 1 / 120) : 1 / 120;
    const wake = car.aero?.wake ?? 0;
    while (remaining > 1e-10) {
      const dt = Math.min(quantum, remaining);
      predicted.step(dt, surface, wake);
      remaining -= dt;
    }
    return predicted;
  }
}
