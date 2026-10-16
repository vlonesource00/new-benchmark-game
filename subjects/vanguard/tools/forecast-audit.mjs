// Compare public rival forecasts with the subsequent actual trajectory in a
// two-car combat-bench trace. Interpolate time and unwrap road coordinates;
// choosing a nearby sample directly would add a speed-dependent timing error.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Track } from '../../../game/engine/sim/track.js';
import { gap } from '../src/math.js';

const filename = process.argv[2];
if (!filename) throw Error('Usage: forecast-audit.mjs <combat-bench-vanguard-trace.json>');
const raw = readFileSync(filename), data = JSON.parse(raw), rows = data.trace;
if (data.driver !== 'vanguard' || data.control || !rows?.length || rows.some(r => r.cars?.length !== 2))
  throw Error('Expected a two-car VANGUARD encounter trace, not a solo control or full-race trace');
if (rows.some((r, i) => !Number.isFinite(r.t) || (i && r.t <= rows[i - 1].t)))
  throw Error('Trace times must be finite and strictly increasing');
const length = new Track(data.track).length, summary = [];
for (const horizon of [0.5, 1.5]) {
  const errors = [];
  for (const row of rows) {
    const p = row.cars[1].debug?.observed?.find(r => r.id === 0)?.forecast?.find(p => p.t === horizon);
    if (!p?.valid) continue;
    const target = row.t + horizon, j = rows.findIndex(r => r.t >= target);
    if (j <= 0 || rows[j].t - rows[j - 1].t > 0.2) continue;
    const a = rows[j - 1], b = rows[j], f = (target - a.t) / (b.t - a.t),
      at = k => a.cars[0][k] + f * (b.cars[0][k] - a.cars[0][k]),
      road = a.cars[0].s + f * gap(b.cars[0].s, a.cars[0].s, length);
    const e = { road: gap(p.s, road, length), speed: p.v - at('speed'),
      distance: Math.hypot(p.x - at('x'), p.z - at('z')) };
    if (Object.values(e).every(Number.isFinite)) errors.push(e);
  }
  const abs = k => errors.map(e => Math.abs(e[k])).sort((a, b) => a - b),
    mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null,
    p90 = a => a.length ? a[Math.floor((a.length - 1) * 0.9)] : null;
  summary.push({ horizon, samples: errors.length, roadMAE: mean(abs('road')),
    roadP90: p90(abs('road')), speedMAE: mean(abs('speed')), distanceP90: p90(abs('distance')) });
}
console.log(JSON.stringify({ trace: filename, traceHash: createHash('sha256').update(raw).digest('hex'),
  scene: data.scene, summary,
  scope: 'Diagnostic errors along one closed-loop encounter; overlapping samples are not independent trials.' }, null, 2));
