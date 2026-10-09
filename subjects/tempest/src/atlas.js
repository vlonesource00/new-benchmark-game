import { clamp } from '../../apex/src/math.js';

// Nominal offsets of the library lanes from the racing line, metres (+ right). Clamped to the road and smoothed,
// so near an apex the inside lanes merge with the line and the outside ones spread across the road.
export const OFFSETS = [-6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6];
export const LINE_LANE = OFFSETS.indexOf(0);

/**
 * Static knowledge of the circuit, computed once per track and class.
 *
 *  lanes        the manoeuvre library: the racing line moved sideways by a smooth, road-bounded shift. Each lane is
 *               a real drivable path with its own quasi-steady speed profile from the same model and solver the
 *               controller executes, stored as its shift and its speed and arc length relative to the line, so with
 *               today's live line profile it says what driving that lane costs, station by station.
 *               At a corner the lane on the corner's inside is the dive, the one on the outside the switchback.
 *  zones        corners: braking point, apex, inside side, straight before it, pass-ability.
 *  next[i]      index of the next corner zone whose apex lies ahead of station i.
 *  cell[i]      track node under station i (water map rows).
 */
export class Atlas {
  constructor(line, model, mass, sopt = {}) {
    const N = line.N, track = line.track;
    this.line = line; this.N = N;
    this.bound = track.halfWidth - 0.6;
    const base = line.lane(new Float64Array(N));
    base.speeds(model, { ...sopt, notch: false, mass });
    this.baseV = Float32Array.from(base.v);
    this.lanes = OFFSETS.map((off, m) => this.buildLane(off, m, base, model, mass, sopt));
    this.cell = new Int32Array(N);
    this.kc = new Float64Array(N);
    for (let i = 0; i < N; i++) { this.cell[i] = track.nearest(line.px[i], line.pz[i]).index; this.kc[i] = track.nodes[this.cell[i]].curvature ?? 0; }
    this.buildZones(base);
  }
  buildLane(off, m, base, model, mass, sopt) {
    const line = this.line, N = this.N, b = this.bound, shift = new Float64Array(N);
    const lane = { off, m, shift: new Float32Array(N), ratio: new Float32Array(N).fill(1), lenR: new Float32Array(N).fill(1) };
    if (off === 0) return lane;
    for (let i = 0; i < N; i++) shift[i] = clamp(off, -b - line.lat[i], b - line.lat[i]);
    // the clamp folds the lane at the road edge; smooth the fold into a drivable bend (±7 stations, 3 passes), and
    // clamp again so the smoothing never leaves the road
    const R = 7, tmp = new Float64Array(N);
    for (let pass = 0; pass < 3; pass++) {
      tmp.set(shift);
      for (let i = 0; i < N; i++) { let s = 0; for (let q = -R; q <= R; q++) s += tmp[line.idx(i + q)]; shift[i] = s / (2 * R + 1); }
      for (let i = 0; i < N; i++) shift[i] = clamp(shift[i], -b - line.lat[i], b - line.lat[i]);
    }
    const L = line.lane(shift); L.speeds(model, { ...sopt, notch: false, mass });
    for (let i = 0; i < N; i++) {
      lane.shift[i] = shift[i];
      lane.ratio[i] = clamp(L.v[i] / Math.max(1, base.v[i]), 0.3, 1.3);
      lane.lenR[i] = L.len[i] / Math.max(1e-6, base.len[i]);
    }
    return lane;
  }
  buildZones(base) {
    const L = this.line, N = this.N, v = base.v;
    const zones = L.zones(4).map((z) => {
      // the braking point is the speed maximum before the apex
      let b = z.apex, steps = 0;
      while (steps++ < N / 2 && v[L.idx(b - 1)] >= v[b] - 0.05) b = L.idx(b - 1);
      const drop = v[b] - v[z.apex], brakeLen = ((z.apex - b + N) % N) * L.ds;
      const inside = Math.sign(L.ks[z.apex]) || 1;
      return { brake: b, apex: z.apex, exit: z.b, inside, drop, brakeLen, vApex: v[z.apex] };
    });
    zones.forEach((z, k) => {
      const prev = zones[(k - 1 + zones.length) % zones.length];
      z.straight = ((z.brake - prev.apex + N) % N) * L.ds;
      // A pass needs a braking zone to out-brake in, or a straight to out-drag on; width makes either easier.
      z.pass = clamp(z.drop / 25, 0, 1) * 0.6 + clamp(z.straight / 400, 0, 1) * 0.4;
    });
    this.zones = zones;
    this.next = new Int16Array(N).fill(-1);
    if (!zones.length) return;
    const order = zones.map((z, k) => k).sort((a, b) => zones[a].apex - zones[b].apex);
    for (let i = 0; i < N; i++) {
      let pick = order[0];
      for (const k of order) if (zones[k].apex > i) { pick = k; break; }
      this.next[i] = pick;
    }
  }
  /** Distance in metres from station i forward to station j. */
  ahead(i, j) { return ((j - i + this.N) % this.N) * this.line.ds; }
}
