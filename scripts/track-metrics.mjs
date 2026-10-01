// Geometry check for circuit scenarios: length, straights, tightest radius, closest approach.
//   node scripts/track-metrics.mjs <track-id|module#export>
import { Track } from '../game/engine/sim/track.js';
const arg = process.argv[2] ?? 'harbor-ring';
let sc = arg;
if (arg === 'legacy') sc = null;

const t = new Track(sc);
const radius = (s) => { const a = t.at(s - 8), b = t.at(s), c = t.at(s + 8); const ab = Math.hypot(a.x - b.x, a.z - b.z), bc = Math.hypot(b.x - c.x, b.z - c.z), ca = Math.hypot(c.x - a.x, c.z - a.z); const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2; return area < 1e-6 ? 1e9 : ab * bc * ca / (4 * area); };
const n = t.nodes, L = t.length;
let minR = Infinity, minRAt = 0, close = Infinity, closeAt = null;
const straights = []; let run = 0, runFrom = 0;
for (let s = 0; s < L; s += 2) {
  const r = radius(s);
  if (r < minR) { minR = r; minRAt = s; }
  if (r > 600) { if (!run) runFrom = s; run += 2; } else if (run) { straights.push([runFrom, run]); run = 0; }
}
if (run) straights.push([runFrom, run]);
for (let i = 0; i < n.length; i += 2) for (let j = i + 2; j < n.length; j += 2) {
  const ds = Math.abs(n[i].s - n[j].s), along = Math.min(ds, L - ds); if (along < 250) continue;
  const d = Math.hypot(n[i].x - n[j].x, n[i].z - n[j].z); if (d < close) { close = d; closeAt = [n[i].s, n[j].s]; }
}
const corners = []; let inC = false, peak = 0, cs = 0;
for (let s = 0; s < L; s += 2) { const k = 1 / radius(s); if (k > 1 / 220) { if (!inC) { inC = true; cs = s; peak = 0; } peak = Math.max(peak, k); } else if (inC) { inC = false; corners.push(`${cs.toFixed(0)}:R${(1 / peak).toFixed(0)}`); } }
const xs = n.map((p) => p.x), zs = n.map((p) => p.z);
console.log(JSON.stringify({ id: t.id, length: +L.toFixed(1), minRadius: +minR.toFixed(1), minRAt: +minRAt.toFixed(0), closest: +close.toFixed(1), closeAt, barrier: t.barrierOffset,
  straights: straights.filter((x) => x[1] > 120).map(([a, b]) => `${a}+${b}`), corners, bbox: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)].map(Math.round) }));
