// What crosses to the planning worker: plain copies of the cars, the pilot's running state and the road surface. The
// game's Vehicle is all plain data apart from its class spec, so a car rebuilt from its copy steps exactly like the
// original (the same rule as ORACLE's shadow copies), and the worker plans on the very state the live car is in.
import { Vehicle } from '../../../game/engine/sim/vehicle.js';

/** Every field of a car but the shared spec, as structured-clone data. */
export function carState(c) {
  const s = {};
  for (const k of Object.keys(c)) if (k !== 'spec' && typeof c[k] !== 'function') s[k] = c[k];
  return s;
}

/** A Vehicle that continues from `s` (its spec rebuilt from the class). */
export function rebuildCar(s) {
  const c = new Vehicle(s.id, s.name, s.color, s.classId);
  for (const k of Object.keys(s)) c[k] = s[k];
  return c;
}

// Prepared once per class from the track (line, envelope, spec) or tied to this thread: rebuilt on the other side.
const PREPARED = new Set(['track', 'spec', 'env', 'line', 'model', 'combat', 'shadowTrack']);

/** The pilot's running state: pedals, steering memory, lane, governor pace, command. */
export function pilotState(p) {
  const s = {};
  for (const k of Object.keys(p)) if (!PREPARED.has(k) && typeof p[k] !== 'function') s[k] = p[k];
  return s;
}

/** A pilot for this thread: the class's prepared pilot `proto` carrying the running state `s`. */
export function rebuildPilot(proto, s) {
  return Object.assign(Object.create(Object.getPrototypeOf(proto)), proto, s);
}

/** A rival record (rivals.js) without its live car and line. */
export function rivalState(r) {
  return { id: r.id, hint: r.hint, e: r.e, edot: r.edot, ratio: r.ratio, path: r.path, at: r.at, car: carState(r.car) };
}

/** The road's live surface: grip temperature and wetness every plan, the rubber and water grids when asked. */
export function surfaceState(track, grids) {
  const s = { wetness: track.wetness, tempGrip: track.tempGrip, ambient: track.ambient };
  if (grids) { s.rubber = track.rubber; if (track.water?.live) s.water = track.water.depth; }
  return s;
}

export function applySurface(track, s) {
  track.wetness = s.wetness; track.tempGrip = s.tempGrip; track.ambient = s.ambient;
  if (s.rubber) track.rubber.set(s.rubber);
  // The water film is read, never cleared: rollout cars drive on a shadow of the road that leaves no trace.
  if (s.water) track.water = { live: true, depth: s.water, clear: () => 0 };
}
