// Where a lap goes: per-segment time, speed, track position and pedals on a flying lap, for any two drivers
// (each "ai" or "ai@{json}" with ORACLE options), measured on the track's own distance so both share one ruler.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/segments.mjs <cls> <track> <seg-m> <A> [B] [lap]
import { bench, jsonArg } from './bench.mjs';
const [cls = 'gt', trackName = 'harbor-ring', segArg = '100', a = 'oracle', b = null, lapArg = '2'] = process.argv.slice(2), SEG = Number(segArg), LAP = Number(lapArg);
const parse = (x) => { const i = x.indexOf('@'); return i < 0 ? { ai: x, o: {} } : { ai: x.slice(0, i), o: jsonArg(x.slice(i + 1)) }; };
async function run({ ai, o }) {
  const segs = new Map();
  await bench({ ais: [ai], cls, trackName, laps: LAP + 1, raceLaps: 12, compound: 'hard', oracle: o, onStep: (race, drivers) => {
    const c = race.cars[0]; if (c.race.lap !== LAP) return;
    const k = Math.floor(c.s / SEG), s = segs.get(k) ?? { t: 0, v: 0, vmin: 99, lat: 0, thr: 0, brk: 0, b: 0, n: 0, cat: 0 }; segs.set(k, s);
    s.n++; s.t += 1 / 120; s.v += c.speed; s.vmin = Math.min(s.vmin, c.speed); s.lat += c.lateral; s.thr += c.controls.throttle; s.brk += c.controls.brake; s.b = Math.max(s.b, Math.abs(Math.atan2(c.v, Math.max(2, c.u))));
    if (drivers.get(c)?.catching) s.cat++;
  } });
  return segs;
}
const A = await run(parse(a)), B = b ? await run(parse(b)) : null;
let ta = 0, tb = 0;
const f = (s) => s ? `${s.t.toFixed(2)}s v${(s.v / s.n).toFixed(1)} min${s.vmin.toFixed(1)} y${(s.lat / s.n).toFixed(1)} β${(s.b * 57.3).toFixed(0)} thr${(s.thr / s.n).toFixed(2)} brk${(s.brk / s.n).toFixed(2)}${s.cat ? ` cat${(s.cat / s.n * 100).toFixed(0)}%` : ''}` : '-';
for (const k of [...A.keys()].sort((x, y) => x - y)) {
  const x = A.get(k), y = B?.get(k); ta += x.t; tb += y?.t ?? 0;
  console.log(`${String(k * SEG).padStart(5)}  ${f(x).padEnd(58)}${B ? `|  ${f(y).padEnd(58)} Δ${((y?.t ?? 0) - x.t).toFixed(2)}` : ''}`);
}
console.log('total', ta.toFixed(2), B ? tb.toFixed(2) : '');
