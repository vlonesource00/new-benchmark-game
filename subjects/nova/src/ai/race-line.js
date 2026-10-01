// DeepSeek Race Line
// A baked, resolution-independent representation of the global solution: the
// smooth multi-scale bump coefficients (not station samples), so the same line
// evaluates identically on any model density. On load it rebuilds the dense
// world-space path, the physical speed profile and the spatial brake events.

import { buildPath } from './global/path-geometry.js';
import { speedProfile } from './global/speed-profile.js';
import { extractBrakeEvents } from './control/brake-intent.js';
import { makeBasis, expandBumps } from './global/line-optimizer.js';

export class RaceLine {
  constructor(model, envelope, { widths, overlap = 2, coeffs, meta = {}, iterations = 12 } = {}) {
    this.model = model;
    this.envelope = envelope;
    this.basis = makeBasis(model, { widths, overlap });
    this.widths = widths;
    this.overlap = overlap;
    if (coeffs.length !== this.basis.count) {
      throw new Error(`race line coefficient count ${coeffs.length} does not match basis ${this.basis.count}`);
    }
    this.coeffs = Float64Array.from(coeffs);
    this.q = expandBumps(model, this.basis, this.coeffs);
    this.path = buildPath(model, this.q);
    this.profile = speedProfile(this.path, envelope, { iterations });
    this.time = this.profile.time;
    this.brakeEvents = extractBrakeEvents(model, this.path, this.profile);
    this.meta = meta;
  }
}
