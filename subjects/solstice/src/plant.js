import { Vehicle } from '../../../game/engine/sim/vehicle.js';

// Canonical game integrator, private state, read-only environment. No deposit
// from an imagined trajectory is allowed to change the real racing surface.
export class PredictionTrack {
  constructor(track) { this.track = track; }
  get length() { return this.track.length; }
  get halfWidth() { return this.track.halfWidth; }
  get curbWidth() { return this.track.curbWidth; }
  get barrierOffset() { return this.track.barrierOffset; }
  get pitWall() { return this.track.pitWall; }
  get ambient() { return this.track.ambient; }
  at(s, q = 0) { return this.track.at(s, q); }
  nearest(x, z) { return this.track.nearest(x, z); }
  surface(x, z) { return this.track.surface(x, z); }
  deposit() {}
}

const MOTION = ['x', 'z', 'y', 'yaw', 'vx', 'vz', 'u', 'v', 'speed', 'yawRate',
  'ax', 'ay', 'roll', 'pitch', 'heave', 'steering', 'gear', 'rpm', 'shiftTimer',
  'fuel', 'fuelScale', 'damage', 's', 'lateral', 'impact', 'automatic', 'zone'];

export function shadowOf(car) {
  return copyVehicle(new Vehicle(car.id, 'SOLSTICE PREDICTION', car.color, car.classId), car);
}

export function copyVehicle(dst, src) {
  for (const key of MOTION) dst[key] = src[key];
  dst.spec = src.spec;
  Object.assign(dst.setup, src.setup);
  dst.controls = { ...src.controls };
  for (let i = 0; i < dst.wheels.length; i++) {
    const a = dst.wheels[i], b = src.wheels[i];
    for (const key of Object.keys(b)) if (key !== 'tyre') a[key] = b[key];
    Object.assign(a.tyre, b.tyre);
  }
  return dst;
}

