/**
 * A rival architecture's own line and speed, as measured by tools/rivalprofile.mjs: per 3 m station the mean lateral offset and
 * speed over its flying laps. It answers the few questions of `Line` the combat planner asks of a rival (where along the lap,
 * what offset, what speed), so a prediction of a known architecture follows its real turn-in and braking points instead of ours.
 */
export class RivalLine {
  constructor(d) {
    this.N = d.N; this.ds = d.ds; this.length = d.N * d.ds;
    this.lat = Float64Array.from(d.lat); this.v = Float64Array.from(d.v); this.len = new Float64Array(d.N).fill(d.ds);
  }
  idx(i) { const N = this.N; return ((i % N) + N) % N; }
  stationOf(s) { return ((s % this.length) + this.length) % this.length / this.ds; }
  sample(a, i, f, ahead = 0) {
    let d = f * this.ds + ahead;
    while (d >= this.ds) { d -= this.ds; i = this.idx(i + 1); }
    while (d < 0) { i = this.idx(i - 1); d += this.ds; }
    const t = d / this.ds;
    return a[i] * (1 - t) + a[this.idx(i + 1)] * t;
  }
}
