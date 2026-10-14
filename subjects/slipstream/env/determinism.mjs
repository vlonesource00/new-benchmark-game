// Two envs, same seed and same action stream, must produce bit-identical car states.
//   node determinism.mjs [ai-id:count ...] [--ticks 2000]
import { createRaceEnv } from './race-env.mjs';
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const seats = [{ learner: true }, { learner: true }, { learner: true }];
for (const a of args) if (!a.startsWith('--') && a.includes(':')) { const [id, n] = a.split(':'); for (let k = 0; k < +n; k++) seats.push({ ai: id }); }
const ticks = +opt('ticks', 2000);
const run = () => {
  const env = createRaceEnv({ track: opt('track', 'harbor-ring'), seats, seed: 11, weather: opt('weather', 'clear') });
  let r = 12345; const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const trace = [];
  for (let k = 0; k < ticks; k++) {
    for (let i = 0; i < env.actions.length; i++) env.actions[i] = i % 2 ? 0.2 + 0.6 * rnd() : (rnd() - 0.5) * 0.3;
    env.step(4);
    if (k % 100 === 99) trace.push(env.cars.map((c) => [c.x, c.z, c.yaw, c.speed, c.damage, c.fuel].join(',')).join(';'));
  }
  return trace;
};
const a = run(), b = run(), first = a.findIndex((x, i) => x !== b[i]);
console.log(JSON.stringify({ seats: seats.map((s) => s.ai ?? 'L').join(','), ticks, identical: first < 0, firstDiffTick: first < 0 ? null : (first + 1) * 100 }));
