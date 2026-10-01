import { Vehicle, wakes } from '../../../host/astra/src/sim/vehicle.js';
import { tyreGrip } from '../../../host/astra/src/sim/tyre.js';

// Canonical force solver, with a read-only track facade for hypothetical edges.
export class Plant {
  constructor(track) {
    this.track = Object.create(track);
    this.track.deposit = () => {};
    this.shadow = new Vehicle();
  }
  copy(car) {
    for (const [key, value] of Object.entries(car)) {
      // Observers can bind instance methods to a live vehicle. A rollout must
      // always retain Vehicle.prototype methods on its own disposable body.
      if (key === 'wheels' || typeof value === 'function') continue;
      if (value && typeof value === 'object') this.shadow[key] = key === 'spec' ? value : { ...value };
      else this.shadow[key] = value;
    }
    this.shadow.wheels = car.wheels.map(w => ({ ...w, tyre: { ...w.tyre } }));
    return this.shadow;
  }
  step(car, controls, dt, rivals = []) {
    car.controls = { ...controls };
    const wake = rivals.length ? wakes([car, ...rivals])[0] : 0;
    car.step(dt, this.track, wake);
  }
}

export function resources(car) {
  const wheels = car.wheels.map(w => ({ core: w.tyre.core, surface: w.tyre.surface, wear: w.tyre.wear,
    grip: tyreGrip(w.tyre, 3300), work: w.tyre.slipPower }));
  return { wheels, front: (wheels[0].grip + wheels[1].grip) / 2,
    rear: (wheels[2].grip + wheels[3].grip) / 2,
    wear: wheels.reduce((s, w) => s + w.wear, 0), maxCore: Math.max(...wheels.map(w => w.core)) };
}

// OBB separating-axis clearance. Positive values are separating distance;
// negative values mean body overlap. The host uses these same body dimensions.
export function clearance(a, b, margin = .18) {
  const ar = [Math.cos(a.yaw), -Math.sin(a.yaw)], af = [Math.sin(a.yaw), Math.cos(a.yaw)];
  const br = [Math.cos(b.yaw), -Math.sin(b.yaw)], bf = [Math.sin(b.yaw), Math.cos(b.yaw)];
  let separation = -Infinity;
  for (const axis of [ar, af, br, bf]) {
    const dot = v => Math.abs(axis[0] * v[0] + axis[1] * v[1]);
    const extent = .98 * (dot(ar) + dot(br)) + 2.28 * (dot(af) + dot(bf)) + margin;
    separation = Math.max(separation, Math.abs((b.x - a.x) * axis[0] + (b.z - a.z) * axis[1]) - extent);
  }
  return separation;
}

export function footprint(track, car) {
  const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
  let lateral = 0;
  for (const x of [-.98, .98]) for (const z of [-2.28, 2.28]) {
    const p = track.nearest(car.x + x * c + z * s, car.z - x * s + z * c);
    lateral = Math.max(lateral, Math.abs(p.lateral));
  }
  return lateral;
}
