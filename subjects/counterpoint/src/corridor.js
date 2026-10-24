import { angle, clamp, ease } from '../../vanguard-v2/src/math.js';

/** Repair an offset join before geometry/speeds are compiled. Corrections are
 * smooth C2 bumps, with position/slope/curvature fixed at the arrival anchor.
 * This is not a legality override: the final road and body checks still decide
 * whether the resulting route can be published or used for an attack. */
export function refineCorridor(shift, i0, n, { origin, entry }) {
  const base = this.line, track = this.track,
    bound = track.halfWidth + (track.curbWidth ?? 0) - .28,
    radius = Math.max(5, Math.ceil(Math.min(32, Math.max(18, origin.speed * .3)) / base.ds)),
    anchorLength = Math.max(12, Math.min(30, entry * .4)),
    correction = new Float64Array(n + 1);
  let changed = false;
  const point = j => {
    const i = base.idx(i0 + j), h = base.h[i];
    return { x: base.px[i] + Math.cos(h) * shift[j], z: base.pz[i] - Math.sin(h) * shift[j], h };
  };
  for (let pass = 0; pass < 4; pass++) {
    correction.fill(0);
    let needed = false;
    const request = (at, x, z, heading) => {
      const road = track.nearest(x, z), excess = road.lateral - clamp(road.lateral, -bound, bound);
      if (Math.abs(excess) < .005) return;
      // A normal offset can be ill-conditioned at a folded road projection.
      // Leave that route for the final guard instead of forcing a large jump.
      const projection = Math.cos(angle(heading - track.at(road.s).heading));
      if (projection < .4) return;
      needed = true;
      const delta = clamp(-excess / projection, -1.2, 1.2);
      for (let j = Math.max(1, Math.floor(at) - radius); j <= Math.min(n - 1, Math.ceil(at) + radius); j++) {
        const weight = 1 - ease(Math.min(1, Math.abs(j - at) / radius)), v = delta * weight;
        // Same-edge constraints combine by their strongest request, avoiding
        // a correction that grows with sampling density.
        if (v * correction[j] >= 0) {
          if (Math.abs(v) > Math.abs(correction[j])) correction[j] = v;
        } else correction[j] += v;
      }
    };
    let previous = point(0);
    for (let j = 1; j <= n; j++) {
      const current = point(j);
      if (Math.abs(shift[j]) > .001) request(j, current.x, current.z, current.h);
      if (Math.abs(shift[j]) + Math.abs(shift[j - 1]) > .002)
        request(j - .5, (previous.x + current.x) * .5, (previous.z + current.z) * .5,
          previous.h + angle(current.h - previous.h) * .5);
      previous = current;
    }
    if (!needed) break;
    for (let j = 1; j < n; j++) {
      const anchor = ease(Math.min(1, j * base.ds / anchorLength)),
        tail = ease(Math.min(1, (n - j) * base.ds / 12)), delta = correction[j] * anchor * tail;
      shift[j] += delta;
      changed ||= Math.abs(delta) > 1e-6;
    }
  }
  return changed;
}
