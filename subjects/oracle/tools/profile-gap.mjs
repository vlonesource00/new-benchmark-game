// Where a solo lap falls short of ORACLE's own speed profile: per 20 m, actual vs profile speed, tracking error,
// body slip and pedals, plus the time lost against the profile.
import { soloLaps } from './lap.mjs';
const [cls = 'gt', trackName = 'harbor-ring', opts = '{}', laps = '3'] = process.argv.slice(2);
const BIN = 20; let bins = null, lap = 0, line = null;
const r = await soloLaps({ cls, trackName, laps: Number(laps), compound: process.env.TYRE ?? 'soft', options: JSON.parse(opts), onStep: (c, d) => {
  if (!d?.trace) return;
  line ??= d.line; if (c.race.lap !== lap) { lap = c.race.lap; if (lap === Number(laps)) bins = Array.from({ length: Math.ceil(line.track.length / BIN) }, () => ({ n: 0, v: 0, p: 0, e: 0, b: 0, th: 0, br: 0, ay: 0 })); }
  if (!bins) return;
  const x = bins[Math.floor(d.loc.s / BIN) % bins.length];
  x.n++; x.v += c.speed; x.p += d.trace.vNow; x.e = Math.max(x.e, Math.abs(d.trace.e)); x.b = Math.max(x.b, d.trace.slide); x.th += c.controls.throttle; x.f = c.fuel; x.br += c.controls.brake; x.ay = Math.max(x.ay, Math.abs(c.ay));
} });
console.log(r.rows.map((x) => `L${x.lap} ${x.time?.toFixed(2)}`).join(' '), 'model', line.time.toFixed(2));
let lost = 0;
console.log(bins.map((x, i) => { if (!x.n) return ''; const v = x.v / x.n, p = x.p / x.n; lost += BIN / v - BIN / p; return `${i * BIN}: v${v.toFixed(0)} p${p.toFixed(0)} e${x.e.toFixed(1)} b${x.b.toFixed(2)} ay${x.ay.toFixed(0)} t${(x.th / x.n).toFixed(1)} B${(x.br / x.n).toFixed(1)} L${lost.toFixed(1)}`; }).join('\n'));
