// Frame trace of one ORACLE lap stretch: pose, plan, pedals and each axle's tyre slip.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/trace2.mjs <cls> <track> <lap> <s0> <s1> [json] [every]
import { bench, jsonArg } from './bench.mjs';
const [cls = 'gt', trackName = 'harbor-ring', lapArg = '2', s0 = '0', s1 = '100', json = '{}', every = '6'] = process.argv.slice(2);
let k = 0;
await bench({ ais: ['oracle'], cls, trackName, laps: Number(lapArg), raceLaps: 12, compound: 'hard', oracle: jsonArg(json), onStep: (race, drivers) => {
  const c = race.cars[0], d = drivers.get(c); if (!d?.trace || c.race.lap !== Number(lapArg) || d.loc.s < +s0 || d.loc.s > +s1 || k++ % Number(every)) return;
  const t = d.trace, w = c.wheels, sl = (x) => Math.hypot(x.tyre.kappa * 10.5, Math.tan(x.tyre.alpha) * 8.6).toFixed(2), tr = d.trace_ ?? {};
  console.log(`s ${d.loc.s.toFixed(0)} v ${c.speed.toFixed(1)}/${t.vNow.toFixed(1)} want ${t.want.toFixed(1)} err ${t.err.toFixed(2)} β ${(t.beta * 57.3).toFixed(1)} slipX ${((tr.slip ?? 0) * 57.3).toFixed(1)} yr ${c.yawRate.toFixed(2)} ayReq ${(tr.ay ?? 0).toFixed(1)} ay ${c.ay.toFixed(1)} st ${c.controls.steer.toFixed(3)} thr ${c.controls.throttle.toFixed(2)} brk ${c.controls.brake.toFixed(2)} | slip F ${sl(w[0])} ${sl(w[1])} R ${sl(w[2])} ${sl(w[3])} κR ${w[2].tyre.kappa.toFixed(3)} ${w[3].tyre.kappa.toFixed(3)} load ${w.map((x) => (x.load / 1000).toFixed(1)).join(' ')}${d.catching ? ' CATCH' : ''}${d.tcCut ? ' TC' : ''}`);
} });
