import { PitLane } from '../../../game/core/pit.js';
import { clamp } from './math.js';

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

/**
 * In-lap guidance. The host autopilot takes the wheel at the pit entry and expects the car on the pit-side
 * edge at the entry speed; it only governs speed over its last `approach` metres. APEX keeps the wheel until
 * then, so it peels to the pit-side edge on a lane of its own line and slows along the host's own braking
 * envelope (never above it, so the two never fight).
 */
export class PitGuide {
  constructor(track, cars = 8) {
    const t = track;
    this.lane = new PitLane({ id: t.id, scenario: t.scenario, length: t.length, halfWidth: t.halfWidth, curbWidth: t.curbWidth, finishS: t.finishS, setPitLane() {} }, Math.max(1, cars));
    this.path = null; this.key = null;
  }
  reset() { this.path = null; this.key = null; }
  /** Distance still to run to the pit entry (m), or Infinity if the entry is not in range. */
  toEntry(s) { const d = this.lane.d(s, this.lane.entry); return d < 600 ? d : Infinity; }
  /** Highest speed that still reaches the entry at the entry speed on the host's braking envelope. */
  cap(d) { const l = this.lane; return Math.sqrt(l.entryV ** 2 + 2 * 0.9 * l.approachDecel * Math.max(0, d - 2)); }
  /** Lane that takes the car from the racing line to the pit-side edge by the entry; built once per approach. */
  build(line, model, speedOpts = {}) {
    const lane = this.lane, N = line.N, shift = new Float64Array(N);
    // the move to the edge: a cosine over D metres at about the entry speed
    const iEntry = Math.round(lane.entry / line.ds) % N, delta = Math.abs(lane.edgeLat - line.lat[iEntry]);
    const D = clamp(Math.PI * lane.entryV * 1.4 * Math.sqrt(Math.max(1, delta) / 8), 70, 190);
    for (let i = 0; i < N; i++) {
      const s = line.st[i], back = lane.d(s, lane.entry);
      if (back > D && back < lane.L / 2) continue;
      const u = back > lane.L / 2 ? 1 : 1 - back / D;
      shift[i] = (lane.edgeLat - line.lat[i]) * smooth(u);
    }
    this.path = line.lane(shift); this.path.speeds(model, { ...speedOpts, notch: false }); this.key = 'pit';
    return this.path;
  }
}
