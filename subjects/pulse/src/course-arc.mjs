// Distances on the executable course, not road-centre progress. The two differ
// through corners; mixing them displaces a waypoint and invents curvature.
export class CourseArc {
  constructor(line) {
    this.line = line; this.starts = new Float64Array(line.N + 1);
    for (let i = 0; i < line.N; i++) this.starts[i + 1] = this.starts[i] + line.len[i];
    this.length = this.starts[line.N];
  }
  project(x, z) {
    const c = this.line.closest(x, z);
    return { ...c, arc: this.starts[c.i] + c.f * this.line.len[c.i] };
  }
  delta(to, from) {
    let d = (to - from) % this.length;
    if (d > this.length / 2) d -= this.length;
    if (d < -this.length / 2) d += this.length;
    return d;
  }
}
