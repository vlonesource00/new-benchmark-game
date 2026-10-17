// Line solve with the car's transient limit on: the lateral force cannot swing faster than the tyres, the yaw
// inertia and the steering let it (v³·dκ/ds ≤ jerk), and no bump of the offsets is narrower than minSigma stations,
// so the line has no wiggle the point-mass model would not pay for but the real car would. Reports model lap time
// and roughness (rms difference of 10 m- and 60 m-chord curvature, 1/km); with "out", stores the line there.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/resolve.mjs <cls> <track> [json]
//   json: { iters, seed, jerk, minSigma, from: 'baked'|'scratch', out, smooth }
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { envelope } from '../src/envelope.js';
import { Line } from '../src/line.js';
import { lineData } from '../src/store.js';
import { jsonArg } from './bench.mjs';

export function roughness(L) {
  const n = L.n, k = (h, i) => { const a = (i - h + n) % n, b = (i + h) % n; const cr = (L.x[i] - L.x[a]) * (L.z[b] - L.z[a]) - (L.z[i] - L.z[a]) * (L.x[b] - L.x[a]), d = Math.hypot(L.x[i] - L.x[a], L.z[i] - L.z[a]) * Math.hypot(L.x[b] - L.x[i], L.z[b] - L.z[i]) * Math.hypot(L.x[b] - L.x[a], L.z[b] - L.z[a]); return d > 1e-9 ? 2 * cr / d : 0; };
  let s = 0; for (let i = 0; i < n; i++) s += (k(2, i) - k(12, i)) ** 2; return Math.sqrt(s / n) * 1000;
}
/** Box smoothing of the offsets inside the road (three passes approximate a Gaussian). */
export function smoothOffsets(L, radius = 4, passes = 3) {
  const n = L.n, w = L.w, t = new Float64Array(n);
  for (let p = 0; p < passes; p++) { for (let i = 0; i < n; i++) { let s = 0; for (let d = -radius; d <= radius; d++) s += w[(i + d + n) % n]; t[i] = s / (2 * radius + 1); } for (let i = 0; i < n; i++) w[i] = Math.min(L.hi[i], Math.max(L.lo[i], t[i])); }
}
if (process.argv[1]?.endsWith('resolve.mjs')) {
  const [cls = 'gt', trackName = 'harbor-ring', json = '{}'] = process.argv.slice(2), o = { iters: 60000, seed: 1, jerk: 45, minSigma: 5, from: 'baked', ...jsonArg(json) };
  const track = new Track(trackName), env = envelope(cls), base = o.fromFile ? JSON.parse(readFileSync(o.fromFile, 'utf8'))[`${track.id}:${cls}`] : o.from === 'baked' ? lineData(track.id, cls) : null, wall = Date.now();
  const L = new Line(track, carSpecFor(cls), env, base ? { ...base, grip: null, latScale: o.latScale ?? 1 } : null, { latScale: o.latScale ?? 1, jerk: o.jerk, minSigma: o.minSigma, crossRate: o.crossRate ?? 0.15, hops: o.hops ?? 0 });
  const t0 = L.build(), r0 = roughness(L);
  if (o.smooth) smoothOffsets(L, o.smooth);
  const r = base ? L.optimise(o.iters, o.seed) : L.solve(o.iters, o.seed);
  console.log(`${cls} ${track.id} start ${t0.toFixed(2)} rough ${r0.toFixed(2)} -> ${r.time.toFixed(2)} rough ${roughness(L).toFixed(2)} kept ${r.kept} wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
  if (o.out) { let all = {}; try { all = JSON.parse(readFileSync(o.out, 'utf8')); } catch {} all[`${track.id}:${cls}`] = { ...L.data(), jerk: o.jerk, minSigma: o.minSigma }; writeFileSync(o.out, JSON.stringify(all)); console.log('saved', o.out); }
}
