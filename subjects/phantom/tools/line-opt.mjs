// Line optimiser: a quasi-steady lap model of the GT car on Harbor Ring
// (grip g0 + g2 v^2, power/drag-limited drive, the plant's measured braking,
// friction ellipse), fitted to the ghost tape's speed profile, then a
// minimum-time lateral line found by smooth Gaussian-bump descent from the
// ghost's own line. Writes the line as JSON (one q per ghost station).
// usage: node subjects/phantom/tools/line-opt.mjs [out.json] [LIM=7.0]
import fs from 'node:fs';
import { Track } from '../../../host/astra/src/sim/track.js';
import { Vehicle } from '../../../host/astra/src/sim/vehicle.js';
import { Ghost } from '../src/ghost.js';
import { GHOST } from '../src/ghost-data.js';
const track = new Track('harbor-ring');
const ghost = new Ghost(GHOST); ghost.calibrate(track, new Vehicle(0, 'x', '#000', 'gt'));
const n = ghost.n, ds = ghost.ds, L = ghost.length;
const cx = new Float64Array(n), cz = new Float64Array(n), nx = new Float64Array(n), nz = new Float64Array(n);
for (let i = 0; i < n; i++) { const p = track.at(ghost.origin + i * ds); cx[i] = p.x; cz[i] = p.z; nx[i] = p.nx; nz[i] = p.nz; }
const W = (i) => (i % n + n) % n;
// Path curvature and segment length of a lateral profile q.
function geom(q, h = 10) {
  const k = new Float64Array(n), sl = new Float64Array(n);
  const X = (i) => cx[W(i)] + nx[W(i)] * q[W(i)], Z = (i) => cz[W(i)] + nz[W(i)] * q[W(i)];
  for (let i = 0; i < n; i++) {
    const ax = X(i - h), az = Z(i - h), bx = X(i), bz = Z(i), qx = X(i + h), qz = Z(i + h);
    const cr = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
    const a = Math.hypot(bx - ax, bz - az), b = Math.hypot(qx - bx, qz - bz), c = Math.hypot(qx - ax, qz - az);
    k[i] = 2 * cr / (a * b * c + 1e-9);
    sl[i] = Math.hypot(X(i + 1) - bx, Z(i + 1) - bz);
  }
  return { k, sl };
}
// Grip / power model (fitted): alat(v) = g0 + g2 v^2 ; accel(v) = min(a0, P/v) - cd v^2
const P = { g0: 12.55, g2: 0.0008609, a0: 9.497, pw: 329.7, cd: 0.0009429, brk: 0.7786 };
function lap(q, p = P) {
  const { k, sl } = geom(q);
  const vmax = new Float64Array(n);
  for (let i = 0; i < n; i++) { const kk = Math.abs(k[i]); const den = kk - p.g2; vmax[i] = den <= 0 ? 90 : Math.min(90, Math.sqrt(p.g0 / den)); }
  const v = Float64Array.from(vmax);
  const ell = (vv, i) => { const al = vv * vv * Math.abs(k[i]), am = p.g0 + p.g2 * vv * vv; return Math.sqrt(Math.max(0, 1 - (al / am) ** 2)); };
  for (let pass = 0; pass < 2; pass++) for (let j = 0; j < n; j++) { const i = W(j - 1), a = (Math.min(p.a0, p.pw / Math.max(v[i], 1)) - p.cd * v[i] * v[i]) * ell(v[i], i); v[j] = Math.min(v[j], Math.sqrt(Math.max(0, v[i] * v[i] + 2 * a * sl[i]))); }
  for (let pass = 0; pass < 2; pass++) for (let j = n - 1; j >= 0; j--) { const i = W(j + 1), a = (ghost.decel(v[i]) * p.brk + p.cd * v[i] * v[i]) * ell(v[i], i); v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * a * sl[j])); }
  let t = 0; const tt = new Float64Array(n);
  for (let i = 0; i < n; i++) { tt[i] = t; t += 2 * sl[i] / (v[i] + v[W(i + 1)]); }
  return { time: t, v, t: tt, k };
}
const LIM = +(process.argv[3] ?? 7.0);
let q = Float64Array.from(ghost.q, (x) => Math.max(-LIM, Math.min(LIM, x)));
let best = lap(q).time; console.log('start', best.toFixed(3));
const t0 = Date.now();
for (const [sig, amps] of [[40, [1.5, 0.6]], [20, [1, 0.4]], [10, [0.6, 0.25]], [6, [0.3, 0.1]], [20, [0.2, 0.08]]]) {
  const R = Math.ceil(sig * 2.5), ker = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-((k - R) ** 2) / (2 * sig * sig)));
  for (const a of amps) for (let sweep = 0; sweep < 6; sweep++) {
    let imp = 0;
    for (let c = 0; c < n; c += Math.max(2, sig >> 1)) for (const d of [a, -a]) {
      const old = []; for (let k = 0; k <= 2 * R; k++) { const i = W(c - R + k); old.push(q[i]); q[i] = Math.max(-LIM, Math.min(LIM, q[i] + d * ker[k])); }
      const t = lap(q).time; if (t < best - 1e-4) { best = t; imp++; break; }
      for (let k = 0; k <= 2 * R; k++) q[W(c - R + k)] = old[k];
    }
    if (!imp) break;
  }
  console.log('sig', sig, best.toFixed(3), ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
fs.writeFileSync(process.argv[2] ?? 'line.json', JSON.stringify(Array.from(q, (x) => +x.toFixed(3))));
const g = lap(ghost.q), o = lap(q);
let s = ''; for (let u = 0; u < n; u += 100) { const b = Math.min(n - 1, u + 100); let mx = 0; for (let i = u; i < b; i++) mx = Math.max(mx, Math.abs(q[i] - ghost.q[i])); s += `${u}: ${((g.t[b] - g.t[u]) - (o.t[b] - o.t[u])).toFixed(2)}s maxdq ${mx.toFixed(1)}\n`; } console.log(s);
