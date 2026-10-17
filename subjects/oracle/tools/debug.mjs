// Prints the controller trace around the first slide or excursion of a solo run.
import { soloLaps } from './lap.mjs';
const [cls = 'gt', trackName = 'harbor-ring', opts = '{}', from = '0'] = process.argv.slice(2);
const hist = []; let done = false, t = 0;
await soloLaps({ cls, trackName, laps: 1, compound: 'soft', options: JSON.parse(opts), onStep: (c, d) => {
  t += 1 / 120; if (done || !d?.trace || t < Number(from)) return;
  const x = d.trace; hist.push(`t${t.toFixed(2)} s${d.loc.s.toFixed(0)} v${c.speed.toFixed(1)} vN${x.vNow.toFixed(1)} vA${x.vAhead.toFixed(1)} e${x.e.toFixed(2)} b${x.beta.toFixed(3)} r${c.yawRate.toFixed(2)} st${c.controls.steer.toFixed(3)} th${c.controls.throttle.toFixed(2)} br${c.controls.brake.toFixed(2)} lat${c.lateral.toFixed(1)}`);
  if (hist.length > 90) hist.shift();
  if (Math.abs(x.beta) > 0.4 || Math.abs(x.e) > 3) { done = true; console.log(hist.filter((_, i) => i % 3 === 0 || i > 80).join('\n')); }
} });
