// Shadow copies for ORACLE's forward model. The game's Vehicle is deterministic, so a copy of the car stepped with
// a copy of the driver predicts the real car to millimetres over seconds: ORACLE's model of itself is exact.
import { Vehicle } from '../../../game/engine/sim/vehicle.js';

/** A car copy that steps exactly like the original (every field but the shared, read-only spec). */
export function cloneCar(c) {
  const s = new Vehicle(c.id, c.name, c.color, c.classId);
  for (const k of Object.keys(c)) {
    const x = c[k];
    if (k === 'spec' || typeof x === 'function') continue;
    s[k] = x && typeof x === 'object' ? structuredClone(x) : x;
  }
  return s;
}

/** The driver's own state over the same (shared) line and envelope; options may be overridden for the run. */
export function cloneDriver(d, extra = {}) {
  const x = Object.assign(Object.create(Object.getPrototypeOf(d)), d);
  x.options = { ...d.options, ...extra }; x.trace = null;
  return x;
}

/** The track as the shadow sees it: the same road, but a shadow car lays no rubber. */
export function shadowTrack(track) { const t = Object.create(track); t.deposit = () => 0; return t; }
