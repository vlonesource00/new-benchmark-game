import { clamp } from './math.js';

// Surface water: a depth field in millimetres over the track's rubber grid (one cell per track node and rubber lane).
// Rain fills it, drainage and evaporation empty it, low spots (the edges, the inside of corners, dips in the tarmac)
// drain slowly and hold puddles, and every tyre that rolls through a cell squeezes part of its water out as spray,
// so a dry line appears where the cars drive while the rest of the road stays wet.
//   film      wetFrac(mm) - how much of the dry grip the water takes (0 dry .. 1 fully wet), ~63 % at 0.35 mm
//   puddle    deeper than ~1.5 mm; slicks start to aquaplane on it at speed, wets much later
export const LANES = 13;
export const wetFrac = (mm) => 1 - Math.exp(-Math.max(0, mm) / 0.35);
// Share of the grip lost to aquaplaning (0..1 of the 75 % that goes) for a tyre whose tread clears `aqV` m/s on 1 mm.
// Worn tread clears less water; deeper water lowers the onset speed with the square root of the depth.
export function aquaplane(mm, speed, aqV = 38, wear = 0) {
  if (mm < 0.5) return 0;
  const onset = aqV * (1 - 0.3 * clamp(wear, 0, 1)) / Math.sqrt(mm);
  return clamp((speed - onset) / 12, 0, 1);
}

const hash = (i, seed) => { let h = (i * 374761393 + seed * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export class WaterField {
  constructor(track, seed = 7) {
    const n = track.nodes.length, cells = n * LANES;
    this.track = track; this.n = n; this.live = false;
    this.depth = new Float32Array(cells);
    this.basin = new Float32Array(cells);   // 0 drains freely .. 1 a puddle that holds water
    this.cx = new Float32Array(cells); this.cz = new Float32Array(cells);
    this.cellLen = track.length / n;
    // Value noise along the lap (~35 m features) picks where the dips are; the profile across the road adds the
    // gutters at both edges and the inside of corners, where the camber sends the water.
    const period = Math.max(4, Math.round(35 / this.cellLen)), knots = Math.ceil(n / period) + 1;
    const noise = (i) => { const k = i / period, a = Math.floor(k), t = k - a, f = t * t * (3 - 2 * t); return hash(a % knots, seed) * (1 - f) + hash((a + 1) % knots, seed) * f; };
    for (let i = 0; i < n; i++) {
      const p = track.nodes[i], dip = clamp((noise(i) - 0.58) / 0.3, 0, 1), curve = clamp(Math.abs(p.curvature) * 60, 0, 1), inside = -Math.sign(p.curvature);
      for (let l = 0; l < LANES; l++) {
        const k = i * LANES + l, lat = (l + 0.5) * track.laneWidth - track.halfWidth, u = lat / track.halfWidth;
        this.cx[k] = p.x + p.nx * lat; this.cz[k] = p.z + p.nz * lat;
        const edge = clamp((Math.abs(u) - 0.62) / 0.38, 0, 1), sideIn = clamp(u * inside, 0, 1) * curve;
        const patch = dip * (0.35 + 0.65 * Math.max(edge, clamp(1 - Math.abs(u - (hash(i + 7, seed) * 1.4 - 0.7)) * 2.2, 0, 1)));
        this.basin[k] = clamp(0.3 * edge + 0.35 * sideIn + patch, 0, 1);
      }
    }
  }
  /** Advance by dt seconds. rainAt(x, z) gives the rain rate in mm/h; evap is the evaporation in mm/s. */
  step(dt, rainAt, evap) {
    const d = this.depth, b = this.basin, n = this.n;
    this.live = true;
    // Rain is sampled once per node (centre of the road): fronts are hundreds of metres across, a road is 13 m.
    for (let i = 0; i < n; i++) {
      const p = this.track.nodes[i], inflow = Math.max(0, rainAt(p.x, p.z)) / 3600;
      for (let l = 0; l < LANES; l++) {
        const k = i * LANES + l, bk = b[k];
        let w = d[k] + (inflow * (1 + 2 * bk) - 0.0045 * (1 - 0.85 * bk) * d[k] - evap * (1 - 0.6 * bk)) * dt;
        d[k] = clamp(w, 0, 1.6 + 5 * bk);
      }
    }
  }
  /** A tyre at `speed` rolling `dt` through cell k squeezes out part of the water; returns the depth removed (mm). */
  clear(k, dt, speed) {
    const w = this.depth[k]; if (w <= 0.005) return 0;
    const out = w * Math.min(0.5, 0.3 * speed * dt / this.cellLen);
    this.depth[k] = w - out; return out;
  }
  at(index, lane) { return this.depth[index * LANES + lane]; }
  /** Mean film wetness on the racing surface (outer gutters excluded): the scalar older code reads as track.wetness. */
  meanWet() {
    let s = 0, c = 0;
    for (let k = 0; k < this.depth.length; k++) { const l = k % LANES; if (l < 2 || l > LANES - 3) continue; s += wetFrac(this.depth[k]); c++; }
    return c ? s / c : 0;
  }
}

/**
 * The road wetness a car's tyres actually feel: a treaded tyre keeps part of the grip a slick loses on water
 * (`wetHold`), so a planner that scales grip by (1 - wetness * 0.36) should feed it this instead of track.wetness.
 */
export const tyreWet = (track, car) => (track?.wetness ?? 0) * (1 - (car?.wheels?.[0]?.tyre?.wetHold ?? 0));
