// PHANTOM plant layer.
//
// PHANTOM does not model the car. It borrows the benchmark's exact Vehicle
// integrator and runs it on private copies of the car state. This file
// provides the two things that makes cheap and safe:
//   RolloutTrack  a read-only view of the host track. It returns the same
//                 surface as Track.surface, but finds the nearest node by a
//                 local walk from a hint instead of hashing a grid, and it
//                 never writes rubber.
//   copyVehicle   a deep copy of every field Vehicle.step reads or writes.

import { Vehicle } from '../../../host/astra/src/sim/vehicle.js';

const ZONE_BASE = { asphalt: 1, kerb: 0.88, gravel: 0.52, grass: 0.42 };

export class RolloutTrack {
  constructor(track) {
    this.track = track;
    this.length = track.length;
    this.halfWidth = track.halfWidth;
    this.curbWidth = track.curbWidth;
    this.runoffWidth = track.runoffWidth;
    this.barrierOffset = track.barrierOffset;
    this.laneWidth = track.laneWidth;
    this.nodes = track.nodes;
    this.count = track.nodes.length;
    this.rubber = track.rubber; // shared read-only view, refreshed by the host
    this.wetness = track.wetness;
    this.hint = 0;
    this.ring = Array.from({ length: 8 }, () => ({}));
    this.ringIndex = 0;
  }

  setHint(index) { this.hint = index; }
  locate(x, z) { this.hint = this.track.nearest(x, z).index; return this.hint; }
  sync() { this.wetness = this.track.wetness; }

  nearestIndex(x, z, hint = this.hint) {
    const nodes = this.nodes, n = this.count;
    let best = hint, bd = (nodes[hint].x - x) ** 2 + (nodes[hint].z - z) ** 2;
    // Walk downhill in both directions; nodes are ~1 m apart so a car moves a
    // handful of nodes per call. A window avoids stopping on tiny plateaus.
    for (const dir of [1, -1]) {
      let i = hint, miss = 0;
      while (miss < 4) {
        i = (i + dir + n) % n;
        const d = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
        if (d < bd) { bd = d; best = i; miss = 0; } else miss += 1;
      }
    }
    return best;
  }

  // Same numbers as Track.nearest + Track.surface, written into a reused object.
  surface(x, z) {
    const track = this.track;
    const index = this.nearestIndex(x, z);
    this.hint = index;
    const node = this.nodes[index];
    const along = (x - node.x) * node.tx + (z - node.z) * node.tz;
    const p = track.at(node.s + along);
    const lateral = (x - p.x) * p.nx + (z - p.z) * p.nz;
    const l = Math.abs(lateral);
    const zone = l < this.halfWidth ? 'asphalt' : l < this.halfWidth + this.curbWidth ? 'kerb' : l < this.halfWidth + this.curbWidth + this.runoffWidth - 1 ? 'gravel' : 'grass';
    const lane = Math.max(0, Math.min(12, Math.floor((lateral + this.halfWidth) / this.laneWidth)));
    const rubber = this.rubber[p.index * 13 + lane];
    const out = this.ring[this.ringIndex];
    this.ringIndex = (this.ringIndex + 1) & 7;
    out.s = p.s; out.lateral = lateral; out.nx = p.nx; out.nz = p.nz; out.tx = p.tx; out.tz = p.tz;
    out.curvature = p.curvature; out.index = p.index; out.zone = zone; out.rubber = rubber;
    out.grip = ZONE_BASE[zone] * (1 + rubber * 0.10) * (1 - this.wetness * (0.36 + rubber * 0.2));
    out.bump = zone === 'kerb' ? 0.028 + Math.sin(p.s * 4) * 0.012 : 0;
    out.resistance = zone === 'gravel' ? 0.09 : zone === 'grass' ? 0.06 : 0.013;
    return out;
  }

  deposit() {}
  at(s, offset) { return this.track.at(s, offset); }
}

const TYRE_KEYS = ['surface', 'core', 'inner', 'outer', 'coldPressure', 'pressure', 'wear', 'alpha', 'kappa', 'fx', 'fy', 'utilisation', 'slipPower'];
const CAR_KEYS = ['x', 'z', 'y', 'yaw', 'vx', 'vz', 'u', 'v', 'speed', 'yawRate', 'ax', 'ay', 'roll', 'pitch', 'heave',
  'steering', 'gear', 'rpm', 'shiftTimer', 'fuel', 'damage', 's', 'lateral', 'impact', 'automatic'];

export function makeShadow(car) {
  const shadow = new Vehicle(-1, 'PHANTOM-SHADOW', '#000', car.classId);
  copyVehicle(shadow, car);
  return shadow;
}

export function copyVehicle(dst, src) {
  for (const k of CAR_KEYS) dst[k] = src[k];
  dst.spec = src.spec;
  dst.setup.wing = src.setup.wing; dst.setup.brakeBias = src.setup.brakeBias; dst.setup.tc = src.setup.tc;
  dst.setup.abs = src.setup.abs; dst.setup.pressure = src.setup.pressure; dst.setup.fuel = src.setup.fuel;
  dst.controls.throttle = src.controls?.throttle ?? 0; dst.controls.brake = src.controls?.brake ?? 0;
  dst.controls.steer = src.controls?.steer ?? 0; dst.controls.reverse = false;
  for (let i = 0; i < 4; i++) {
    const a = dst.wheels[i], b = src.wheels[i];
    a.x = b.x; a.z = b.z; a.omega = b.omega; a.steer = b.steer; a.compression = b.compression; a.load = b.load; a.brakeTemp = b.brakeTemp;
    for (const k of TYRE_KEYS) a.tyre[k] = b.tyre[k];
  }
  return dst;
}
