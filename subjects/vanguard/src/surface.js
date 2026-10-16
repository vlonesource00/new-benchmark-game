import { Line } from '../../apex/src/line.js';
import { wetFrac } from '../../../game/engine/sim/water.js';
import { clamp } from './math.js';

/** The existing line solver with local surface ceilings applied before its
 * forward/backward passes, including the acceleration and braking envelopes. */
export class PaceLine extends Line {
  constructor(track, options) {
    super(track, options);
    this.surfaceCaps = new Float64Array(this.N).fill(Infinity);
    this.paceTrim = new Float64Array(this.N).fill(1);
    this.brakeTrim = new Float64Array(this.N).fill(1);
    this.surfaceNodes = null;
    this.wetOffsets = new Float64Array(this.N);
  }
  applyNotches() {
    super.applyNotches();
    for (let i = 0; i < this.N; i++) {
      this.cap[i] = Math.min(this.cap[i], this.surfaceCaps[i]);
      this.vmax[i] = Math.min(this.vmax[i], this.surfaceCaps[i]);
    }
  }
}

/** Slowly morph the clear-air line towards connected, shallower wheel tracks.
 * Work is sliced; the caller swaps the completed geometry/profile atomically. */
export function* wetLineGen(line, track, car, model, elapsed = 1) {
  const dry = line.dryGeometry;
  if (!dry) return { changed: false, moving: false };
  const wet = track.water?.live && track.wetness > 0.03, n = line.N;
  const targets = new Float64Array(n), scratch = new Float64Array(n);
  const tyre = car.wheels[0].tyre, hold = tyre.wetHold ?? 0,
    wear = Math.max(...car.wheels.map(w => w.tyre.wear)), halfTrack = car.spec.track * 0.5;
  let work = 0;
  for (let i = 0; i < n; i++) {
    let best = 0, cost = Infinity;
    if (wet) {
      const node = track.at(dry.st[i]).index,
        desired = Math.min(95, Math.sqrt(model.lat(60) / Math.max(1e-5, Math.abs(dry.ks[i]))));
      for (let j = -3; j <= 3; j++) {
        const lateral = clamp(dry.lat[i] + j * (2.5 / 3), -track.halfWidth + 1.12, track.halfWidth - 1.12);
        const offset = lateral - dry.lat[i];
        let speed = desired, grip = 1;
        for (const wheel of [lateral - halfTrack, lateral + halfTrack]) {
          const k = node * 13 + track.laneAt(wheel), depth = track.water.depth[k], rubber = track.rubber[k];
          grip = Math.min(grip, (1 + rubber * 0.1) * (1 - wetFrac(depth) * (0.36 + rubber * 0.2) * (1 - hold)));
          if (depth > 0.5) speed = Math.min(speed, (tyre.aqV ?? 38) * (1 - 0.3 * wear) / Math.sqrt(depth));
        }
        const candidate = line.ds / Math.max(10, speed * Math.sqrt(grip)) + 0.0008 * offset * offset;
        if (candidate < cost) { cost = candidate; best = offset; }
      }
    }
    targets[i] = best;
    if (++work >= 512) { work = 0; yield; }
  }
  // Circular smoothing avoids a seam at the start/finish and prevents small
  // water cells from asking the car to weave between lanes.
  const radius = Math.max(4, Math.ceil(24 / line.ds));
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0;
    for (let j = -radius; j <= radius; j++) sum += targets[line.idx(j)];
    for (let i = 0; i < n; i++) {
      scratch[i] = sum / (2 * radius + 1);
      sum += targets[line.idx(i + radius + 1)] - targets[line.idx(i - radius)];
      if (++work >= 1024) { work = 0; yield; }
    }
    targets.set(scratch);
  }
  let changed = false, moving = false;
  const rate = Math.min(0.3, Math.max(0.01, elapsed) * 0.25);
  for (let i = 0; i < n; i++) {
    const desired = clamp(targets[i], -track.halfWidth + 1.12 - dry.lat[i], track.halfWidth - 1.12 - dry.lat[i]);
    const offset = wet ? line.wetOffsets[i] + clamp(desired - line.wetOffsets[i], -rate, rate)
      : line.wetOffsets[i] + clamp(-line.wetOffsets[i], -rate, rate);
    changed ||= Math.abs(offset - line.wetOffsets[i]) > 1e-5;
    moving ||= Math.abs((wet ? desired : 0) - offset) > 0.01;
    line.wetOffsets[i] = offset;
    line.px[i] = dry.px[i] + Math.cos(dry.h[i]) * offset;
    line.pz[i] = dry.pz[i] - Math.sin(dry.h[i]) * offset;
    const road = track.nearest(line.px[i], line.pz[i]);
    line.lat[i] = road.lateral; line.st[i] = road.s;
    line.surfaceNodes[i] = road.index;
    if (++work >= 1024) { work = 0; yield; }
  }
  if (changed) line.geometry();
  return { changed, moving };
}

/** Sample both wheel tracks, not average circuit wetness. Keep the game's
 * aquaplaning onset, tread wear and wet-rubber loss in the pace forecast. */
export function surfaceProfile(line, track, car, { maxAquaplane = 0.08 } = {}) {
  const active = track.water?.live && track.wetness > 0.015;
  if (!line.surfaceNodes) {
    line.surfaceNodes = new Uint32Array(line.N);
    for (let i = 0; i < line.N; i++) line.surfaceNodes[i] = track.at(line.st[i]).index;
  }
  const tyre = car.wheels[0].tyre, hold = tyre.wetHold ?? 0,
    wear = Math.max(...car.wheels.map(w => w.tyre.wear)),
    average = 1 - 0.36 * (track.wetness ?? 0) * (1 - hold),
    n = track.nodes.length, halfTrack = car.spec.track * 0.5;
  let minimum = Infinity, maxDepth = 0;
  for (let i = 0; i < line.N; i++) {
    let cap = Infinity, ratio = 1;
    if (active) {
      for (const lateral of [line.lat[i] - halfTrack, line.lat[i] + halfTrack]) {
        const lane = track.laneAt(lateral), node = line.surfaceNodes[i];
        for (let j = -1; j <= 1; j++) {
          const k = ((node + j + n) % n) * 13 + lane,
            depth = track.water.depth[k], rubber = track.rubber[k],
            loss = wetFrac(depth) * (0.36 + rubber * 0.2);
          ratio = Math.min(ratio, (1 + rubber * 0.1) * (1 - loss * (1 - hold)) / Math.max(0.2, average));
          maxDepth = Math.max(maxDepth, depth);
          if (depth > 0.5) {
            const onset = (tyre.aqV ?? 38) * (1 - 0.3 * clamp(wear, 0, 1)) / Math.sqrt(depth);
            cap = Math.min(cap, onset * 0.97 + clamp(maxAquaplane, 0, 0.2) * 12);
          }
        }
      }
    }
    line.surfaceCaps[i] = cap;
    line.trim[i] = line.paceTrim[i] * ratio;
    line.btrim[i] = line.brakeTrim[i] * ratio;
    minimum = Math.min(minimum, cap);
  }
  return { active: Boolean(active), minimumSpeed: Number.isFinite(minimum) ? minimum : null, maxDepth };
}
