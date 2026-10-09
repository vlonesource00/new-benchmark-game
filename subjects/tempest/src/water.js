import { clamp } from '../../apex/src/math.js';
import { wetFrac, aquaplane, tyreWet } from '../../../game/engine/sim/water.js';

/**
 * WaterSense: TEMPEST reads the shared water map (mm per track node and lane) the way a driver reads a wet road.
 *
 *  - Grip map: for every station of its line, the grip the tyres will really have there (water film, rubber that
 *    turns slippery in the wet, aquaplaning at the planned speed), relative to the road average the speed profile
 *    already assumes. It retrims the profile station by station, so the car brakes for the puddle in the apex and
 *    carries speed where the line has dried.
 *  - Wet line: where moving a little across the road finds drier, less rubbered tarmac, the line itself moves
 *    (bounded, smooth, rate-limited). A candidate wet line is kept only when the lap estimate says it is faster.
 *
 * Trims compose multiplicatively with the line's own learnt trims; drying back to zero water restores everything.
 */
export class WaterSense {
  constructor(driver) {
    this.driver = driver; this.line = driver.line; this.track = driver.track;
    const L = this.line, N = L.N;
    this.cell = new Int32Array(N); this.factor = new Float64Array(N).fill(1);
    for (let i = 0; i < N; i++) this.cell[i] = this.track.nearest(L.px[i], L.pz[i]).index;
    // The proven dry geometry, frozen: every wet line is a lane of it, never of a previous wet line.
    this.dry = Object.create(Object.getPrototypeOf(L));
    Object.assign(this.dry, L);
    for (const key of ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat']) this.dry[key] = L[key].slice();
    this.shift = new Float64Array(N); this.want = new Float64Array(N); this.tmp = new Float64Array(N);
    this.clock = 0; this.lineClock = 0; this.active = false; this.gain = 0; this.lineGain = 0; this.moved = 0;
  }
  /** Grip at road lateral `lat` of station i relative to the road average, for a car at speed v on these tyres. */
  local(i, lat, v, tyre) {
    const t = this.track, w = t.water, lane = t.laneAt(lat), k = this.cell[i] * 13 + lane;
    const d = w.depth[k], rub = t.rubber?.[k] ?? 0, hold = tyre.wetHold ?? 0;
    const loss = wetFrac(d) * (0.36 + rub * 0.2) * (1 - hold);
    return (1 - loss) * (1 - 0.75 * aquaplane(d, v, tyre.aqV ?? 38, tyre.wear));
  }
  wet() { return this.track.water?.live && (this.track.wetness ?? 0) > 0.01; }
  update(car, dt) {
    const o = this.driver.options;
    if (o.waterSense === false) return;
    this.clock += dt; this.lineClock += dt;
    if (this.clock < (o.waterPeriod ?? 0.8)) return;
    this.clock = 0;
    if (!this.wet()) { if (this.active) this.restore(); return; }
    this.active = true;
    if (o.wetLine !== false && this.lineClock > (o.wetLinePeriod ?? 6)) { this.lineClock = 0; this.placeLine(car); }
    this.retrim(car);
  }
  retrim(car) {
    const L = this.line, N = L.N, tyre = car.wheels[2].tyre, mean = 1 - tyreWet(this.track, car) * 0.36;
    const f = this.tmp;
    for (let i = 0; i < N; i++) f[i] = clamp(this.local(i, L.lat[i], L.v[i], tyre) / Math.max(0.3, mean), 0.55, 1.25);
    // A puddle grips less for the whole contact with it, not at one station: take the worst of the neighbours.
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.min(f[L.idx(i - 1)], f[i], f[L.idx(i + 1)]), next = this.factor[i] + (a - this.factor[i]) * 0.6;
      L.trim[i] *= next / this.factor[i]; L.btrim[i] *= next / this.factor[i]; this.factor[i] = next; sum += next;
    }
    this.gain = sum / N; this.driver.forceRefresh = true;
  }
  restore() {
    const L = this.line, N = L.N;
    for (let i = 0; i < N; i++) { L.trim[i] /= this.factor[i]; L.btrim[i] /= this.factor[i]; this.factor[i] = 1; }
    if (this.moved) { this.shift.fill(0); this.install(this.dry.lane(this.shift)); this.moved = 0; }
    this.active = false; this.gain = 1; this.driver.forceRefresh = true;
  }
  /** Search a bounded lateral move per station toward grippier tarmac, smooth it, and keep it only if it is faster. */
  placeLine(car) {
    const o = this.driver.options, D = this.dry, L = this.line, N = L.N, tyre = car.wheels[2].tyre, t = this.track;
    const reach = o.wetShift ?? 1.6, step = 0.4, edge = t.halfWidth - (car.spec.halfWidth ?? 0.98) - 0.35, cost = o.wetShiftCost ?? 0.012;
    for (let i = 0; i < N; i++) {
      let best = this.shift[i], bestScore = -Infinity;
      for (let s = -reach; s <= reach + 1e-6; s += step) {
        const lat = D.lat[i] + s; if (Math.abs(lat) > edge) continue;
        const score = this.local(i, lat, L.v[i], tyre) - cost * s * s;
        if (score > bestScore + 1e-4) { bestScore = score; best = s; }
      }
      this.want[i] = best;
    }
    // Low-pass twice over about +-40 m: a line moves in sweeps, never station by station.
    const R = Math.max(4, Math.round(40 / D.ds));
    for (let pass = 0; pass < 2; pass++) {
      const src = this.want.slice();
      for (let i = 0; i < N; i++) { let a = 0; for (let q = -R; q <= R; q++) a += src[L.idx(i + q)]; this.want[i] = a / (2 * R + 1); }
    }
    // Rate limit: the line drifts toward the wanted wet line, so a car mid-corner never sees its reference jump.
    const next = new Float64Array(N);
    for (let i = 0; i < N; i++) next[i] = this.shift[i] + clamp(this.want[i] - this.shift[i], -0.35, 0.35);
    // Both lanes are priced the same way (no gearbox notches, which only the live line carries).
    const model = this.driver.model, opts = { ...this.driver.sopt, mass: car.spec.mass + car.fuel * 0.75, notch: false };
    const candidate = D.lane(next), tNow = D.lane(this.shift).speeds(model, opts);
    // Price the candidate with the same per-station grip the car will meet there.
    const saved = L.trim.slice(), savedB = L.btrim.slice();
    for (let i = 0; i < N; i++) {
      const g = this.local(i, candidate.lat[i], L.v[i], tyre) / Math.max(0.3, this.local(i, L.lat[i], L.v[i], tyre));
      L.trim[i] *= clamp(g, 0.7, 1.4); L.btrim[i] *= clamp(g, 0.7, 1.4);
    }
    const tNew = candidate.speeds(model, opts);
    L.trim.set(saved); L.btrim.set(savedB);
    if (Number.isFinite(tNew) && tNew < tNow - (o.wetLineGain ?? 0.05)) {
      this.shift.set(next); this.install(candidate); this.moved++; this.lineGain = tNow - tNew;
    }
  }
  install(lane) {
    const L = this.line;
    for (const key of ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat']) L[key].set(lane[key]);
    this.driver.forceRefresh = true;
  }
  debug() { return { active: this.active, grip: +(this.gain ?? 1).toFixed(3), lineMoves: this.moved, lineGain: +(this.lineGain ?? 0).toFixed(2),
    shiftMax: +Math.max(...this.shift.map(Math.abs)).toFixed(2) }; }
}
