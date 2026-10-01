import { clamp, wrap, angle, lerp } from './math.js';

// Cartesian navigation seed. No controller, line, ghost or oracle is read.
// Projection to the actual road, rather than authored station normals, permits
// a smooth gate sequence through centreline hooks and near-singular tangents.
export class RoadGates {
  constructor(track, options = {}) {
    this.track = track;
    this.options = { spacing: 4, inset: 1.8, gateSpacing: 40, tangentScale: 1, blur: 36,
      shapePasses: 0, shapeWidth: 28, shapeStep: 1.1, shapeMode: 'arrival', portGeometry: false, ...options };
    this.n = Math.ceil(track.length / this.options.spacing);
    this.ds = track.length / this.n;
    const limit = track.halfWidth - this.options.inset;
    const raw = Array.from({ length: this.n }, (_, i) => ({ ...track.at(i * this.ds), station: i * this.ds }));
    const gateCount = Math.ceil(track.length / this.options.gateSpacing), gateDs = track.length / gateCount;
    const anchors = Array.from({ length: gateCount }, (_, i) => ({ ...track.at(i * gateDs), station: i * gateDs }));
    let j = 0;
    this.points = raw.map((p, i) => {
      while (j + 1 < anchors.length && anchors[j + 1].station <= p.station) j++;
      const a = anchors[j], b = anchors[(j + 1) % anchors.length], prev = anchors[wrap(j - 1, anchors.length)], next = anchors[(j + 2) % anchors.length];
      const end = j === anchors.length - 1 ? track.length : b.station, u = (p.station - a.station) / (end - a.station);
      const span = Math.hypot(b.x - a.x, b.z - a.z) * this.options.tangentScale;
      const headingA = bisector(prev, a, b), headingB = bisector(a, b, next);
      const h0 = 2 * u ** 3 - 3 * u * u + 1, h1 = u ** 3 - 2 * u * u + u;
      const h2 = -2 * u ** 3 + 3 * u * u, h3 = u ** 3 - u * u;
      let x = h0 * a.x + h1 * span * headingA.tx + h2 * b.x + h3 * span * headingB.tx;
      let z = h0 * a.z + h1 * span * headingA.tz + h2 * b.z + h3 * span * headingB.tz;
      if (this.options.blur > 0) {
        const sigma = this.options.blur / this.ds, radius = Math.ceil(3 * sigma);
        let sum = 0; x = 0; z = 0;
        for (let k = -radius; k <= radius; k++) {
          const w = Math.exp(-.5 * (k / sigma) ** 2), point = raw[wrap(i + k, this.n)];
          x += point.x * w; z += point.z * w; sum += w;
        }
        x /= sum; z /= sum;
      }
      const ground = track.nearest(x, z), excess = ground.lateral - clamp(ground.lateral, -limit, limit);
      if (this.options.blur <= 0) { x -= ground.nx * excess; z -= ground.nz * excess; }
      return { x, z, station: p.station };
    });
    // Spread obstacle/edge corrections across neighbouring Cartesian gates.
    // Independent hard projections create new curvature spikes at a kink.
    for (let pass = 0; pass < 220 && this.options.blur > 0; pass++) {
      let peak = 0;
      const corrections = this.points.map(p => {
        const g = track.nearest(p.x, p.z), excess = g.lateral - clamp(g.lateral, -limit, limit);
        peak = Math.max(peak, Math.abs(excess)); return { x: g.nx * excess, z: g.nz * excess };
      });
      if (peak < .015) break;
      this.points = this.points.map((p, i) => {
        let x = 0, z = 0, sum = 0;
        for (let k = -7; k <= 7; k++) { const w = Math.exp(-.5 * (k / 3) ** 2), c = corrections[wrap(i + k, this.n)]; x += c.x * w; z += c.z * w; sum += w; }
        return { x: p.x - .7 * x / sum, z: p.z - .7 * z / sum, station: p.station };
      });
    }
    this.rebuild();
    if (this.options.deformations?.length) {
      for (const warp of this.options.deformations) {
        const anchor = this.points.reduce((a, p) => Math.abs(deltaStation(p.station, warp.station, track.length))
          < Math.abs(deltaStation(a.station, warp.station, track.length)) ? p : a);
        const nx = warp.nx ?? anchor.nx, nz = warp.nz ?? anchor.nz, width = warp.width ?? 40;
        for (const p of this.points) {
          const weight = Math.exp(-.5 * (deltaStation(p.station, warp.station, track.length) / width) ** 2);
          p.x += (warp.offset ?? 0) * weight * nx; p.z += (warp.offset ?? 0) * weight * nz;
        }
      }
      this.rebuild();
    }
    if (this.options.shapePasses > 0) this.improveGates();
  }

  improveGates() {
    // Descent in world coordinates: a distributed gate displacement changes
    // the actual segment lengths and curvature, including across the T1 hook.
    // This is a proposal seed; every online transfer still runs the full plant.
    const sigma = this.options.shapeWidth / this.ds, radius = Math.ceil(sigma * 3);
    const stride = Math.max(3, Math.round(sigma * 1.2)), bound = this.track.halfWidth - this.options.inset;
    let cost = this.gateCost();
    for (let pass = 0; pass < this.options.shapePasses; pass++) {
      const step = this.options.shapeStep * .78 ** Math.floor(pass / 3);
      for (let centre = pass % stride; centre < this.n; centre += stride) {
        const direction = { x: this.points[centre].nx, z: this.points[centre].nz };
        const changes = Array.from({ length: radius * 2 + 1 }, (_, j) => {
          const k = j - radius, i = wrap(centre + k, this.n), w = Math.exp(-.5 * (k / sigma) ** 2);
          return { i, x: this.points[i].x, z: this.points[i].z, w };
        });
        let chosen = 0, candidateCost = cost;
        for (const sign of [-1, 1]) {
          let legal = true;
          for (const c of changes) {
            const p = this.points[c.i]; p.x = c.x + sign * step * c.w * direction.x; p.z = c.z + sign * step * c.w * direction.z;
            if (Math.abs(this.track.nearest(p.x, p.z).lateral) > bound) legal = false;
          }
          if (legal) {
            this.rebuild(); const score = this.gateCost();
            if (score < candidateCost - 1e-5) { candidateCost = score; chosen = sign; }
          }
        }
        for (const c of changes) {
          const p = this.points[c.i]; p.x = c.x + chosen * step * c.w * direction.x; p.z = c.z + chosen * step * c.w * direction.z;
        }
        this.rebuild(); cost = candidateCost;
      }
    }
    this.seedCost = cost;
  }

  gateCost() {
    if (this.options.shapeMode === 'work') return this.points.reduce((sum, p, i) => {
      const distance = wrap(this.points[(i + 1) % this.n].d - p.d, this.length);
      return sum + distance * (p.curvature * p.curvature * 5000 + .001);
    }, 0);
    const speed = new Float64Array(this.n), segment = new Float64Array(this.n);
    const mu = 1.36 * .78, aero = .5 * 1.225 * 1.9 * 2.25 / 1316;
    for (let i = 0; i < this.n; i++) {
      const p = this.points[i], coefficient = Math.abs(p.curvature) - mu * aero;
      speed[i] = coefficient > 0 ? Math.min(72, Math.sqrt(mu * 9.81 / coefficient)) : 72;
      segment[i] = wrap(this.points[(i + 1) % this.n].d - p.d, this.length);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let i = this.n - 1; i >= 0; i--) speed[i] = Math.min(speed[i], Math.sqrt(speed[(i + 1) % this.n] ** 2 + 20 * segment[i]));
      for (let i = 0; i < this.n; i++) { const j = wrap(i - 1, this.n); speed[i] = Math.min(speed[i], Math.sqrt(speed[j] ** 2 + 9 * segment[j])); }
    }
    return speed.reduce((sum, v, i) => sum + 2 * segment[i] / (v + speed[(i + 1) % this.n]), 0);
  }

  rebuild() {
    this.portCache = new Map();
    let distance = 0;
    for (let i = 0; i < this.n; i++) {
      const p = this.points[i], a = this.points[wrap(i - 1, this.n)], b = this.points[(i + 1) % this.n];
      if (i) distance += Math.hypot(p.x - a.x, p.z - a.z);
      p.d = distance;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      p.tx = (b.x - a.x) / length; p.tz = (b.z - a.z) / length;
      p.nx = p.tz; p.nz = -p.tx; p.heading = Math.atan2(p.tx, p.tz);
      const ab = Math.hypot(p.x - a.x, p.z - a.z), bc = Math.hypot(b.x - p.x, b.z - p.z), ac = length;
      // Signed circumcircle curvature; never use centreline curvature here.
      p.curvature = -2 * ((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / Math.max(.01, ab * bc * ac);
    }
    this.length = distance + Math.hypot(this.points[0].x - this.points.at(-1).x, this.points[0].z - this.points.at(-1).z);
  }

  at(d, lateral = 0) {
    d = wrap(d, this.length);
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.points[mid].d <= d) lo = mid; else hi = mid - 1; }
    const a = this.points[lo], b = this.points[(lo + 1) % this.n];
    const f = clamp((d - a.d) / ((lo === this.n - 1 ? this.length : b.d) - a.d), 0, 1);
    const heading = a.heading + angle(b.heading - a.heading) * f;
    const tx = Math.sin(heading), tz = Math.cos(heading), nx = tz, nz = -tx;
    return { x: lerp(a.x, b.x, f) + nx * lateral, z: lerp(a.z, b.z, f) + nz * lateral,
      tx, tz, nx, nz, heading, curvature: lerp(a.curvature, b.curvature, f), d,
      s: wrap(a.station + this.ds * f, this.track.length), index: lo };
  }

  project(car) {
    // The canonical track station only locates a neighbourhood. The actual
    // nearest Cartesian segment supplies navigation progress and lateral error.
    const centre = Math.floor(wrap(car.s ?? this.track.nearest(car.x, car.z).s, this.track.length) / this.ds);
    let best = Infinity, result = null;
    for (let off = -10; off <= 10; off++) {
      const i = wrap(centre + off, this.n), a = this.points[i], b = this.points[(i + 1) % this.n];
      const dx = b.x - a.x, dz = b.z - a.z, norm = dx * dx + dz * dz;
      const f = clamp(((car.x - a.x) * dx + (car.z - a.z) * dz) / Math.max(.01, norm), 0, 1);
      const x = a.x + dx * f, z = a.z + dz * f, err = (car.x - x) ** 2 + (car.z - z) ** 2;
      if (err >= best) continue;
      best = err;
      const m = Math.sqrt(norm), d = wrap(a.d + f * m, this.length);
      result = { d, x, z, lateral: ((car.x - x) * dz - (car.z - z) * dx) / m,
        heading: Math.atan2(dx, dz), index: i, error: Math.sqrt(err) };
    }
    return result;
  }

  // Move a gate port into the actually usable road, including bent normals.
  port(d, extra = 0) {
    if (!this.options.portGeometry) {
      const p = this.at(d, extra), ground = this.track.nearest(p.x, p.z);
      const bound = this.track.halfWidth - this.options.inset;
      const correction = ground.lateral - clamp(ground.lateral, -bound, bound);
      p.x -= correction * ground.nx; p.z -= correction * ground.nz;
      p.roadLateral = ground.lateral - correction;
      return p;
    }
    if (Math.abs(extra) < .01) return this.at(d);
    const curve = this.portCurve(extra), p = this.at(d), a = curve[p.index], b = curve[(p.index + 1) % this.n];
    const phase = wrap(p.d - a.d, this.length) / wrap(b.d - a.d, this.length), f = clamp(phase, 0, 1);
    const heading = a.heading + angle(b.heading - a.heading) * f;
    return { ...p, x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), heading,
      tx: Math.sin(heading), tz: Math.cos(heading), nx: Math.cos(heading), nz: -Math.sin(heading),
      curvature: lerp(a.curvature, b.curvature, f), roadLateral: lerp(a.roadLateral, b.roadLateral, f) };
  }

  portCurve(extra) {
    // A displaced/clipped port has its own executable geometry. Using the
    // centre gate's curvature for every port overdrives an inside arrival and
    // unnecessarily slows an outside arrival. Cache the actual world curve.
    const key = Math.round(extra * 4) / 4;
    if (key === 0) return this.points;
    if (this.portCache.has(key)) return this.portCache.get(key);
    const bound = this.track.halfWidth - this.options.inset;
    const curve = this.points.map(p => {
      let x = p.x + p.nx * key, z = p.z + p.nz * key;
      const ground = this.track.nearest(x, z), correction = ground.lateral - clamp(ground.lateral, -bound, bound);
      x -= correction * ground.nx; z -= correction * ground.nz;
      return { x, z, d: p.d, station: p.station, roadLateral: ground.lateral - correction };
    });
    for (let i = 0; i < this.n; i++) {
      const p = curve[i], a = curve[wrap(i - 1, this.n)], b = curve[(i + 1) % this.n];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const ab = Math.hypot(p.x - a.x, p.z - a.z), bc = Math.hypot(b.x - p.x, b.z - p.z);
      p.heading = Math.atan2(b.x - a.x, b.z - a.z);
      p.curvature = -2 * ((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / Math.max(.01, ab * bc * length);
      p.segment = bc;
    }
    this.portCache.set(key, curve);
    return curve;
  }
}

function bisector(a, b, c) {
  const da = Math.max(.01, Math.hypot(b.x - a.x, b.z - a.z)), db = Math.max(.01, Math.hypot(c.x - b.x, c.z - b.z));
  const tx = (b.x - a.x) / da + (c.x - b.x) / db, tz = (b.z - a.z) / da + (c.z - b.z) / db;
  const m = Math.max(.01, Math.hypot(tx, tz)); return { tx: tx / m, tz: tz / m };
}

function deltaStation(a, b, length) { return wrap(a - b + length * .5, length) - length * .5; }
