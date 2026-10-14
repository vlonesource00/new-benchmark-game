// Throughput of the full game race loop with learner seats (pursuit stand-in policy) and real AI seats.
//   node bench-race.mjs <learners> <ai-id>:<count> ... [--secs 6] [--track harbor-ring]
import { createRaceEnv, FIXED_DT } from './race-env.mjs';
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const nl = +args[0] || 8, seats = Array.from({ length: nl }, () => ({ learner: true }));
for (const a of args.slice(1)) if (!a.startsWith('--') && a.includes(':')) { const [id, n] = a.split(':'); for (let k = 0; k < +n; k++) seats.push({ ai: id }); }
const env = createRaceEnv({ track: opt('track', 'harbor-ring'), seats, classId: opt('class', 'gt') });
const t = env.track, secs = +opt('secs', 6);
const pursue = (c) => { const p = t.nearest(c.x, c.z), a = t.at(p.s + 8 + c.speed * 0.6), h = Math.atan2(a.x - c.x, a.z - c.z), e = Math.atan2(Math.sin(h - c.yaw), Math.cos(h - c.yaw));
  // Speed target from the sharpest heading change over the next 20-120 m (stand-in policy for load, not pace).
  let k = 0; for (let d = 20; d <= 120; d += 20) { const b = t.at(p.s + d), q = t.at(p.s + d + 15); k = Math.max(k, Math.abs(Math.atan2(Math.sin(q.heading - b.heading), Math.cos(q.heading - b.heading))) / 15); }
  const vt = Math.min(60, Math.sqrt(14 / Math.max(k, 1e-3)));
  return [Math.max(-1, Math.min(1, 1.2 * e)), c.speed < vt ? 0.8 : -0.6]; };
let ticks = 0; const t0 = performance.now();
while (performance.now() - t0 < secs * 1000) {
  env.learners.forEach((ci, k) => { const [s, p] = pursue(env.cars[ci]); env.actions[2 * k] = s; env.actions[2 * k + 1] = p; });
  env.step(4); ticks++;
}
const wall = (performance.now() - t0) / 1000, sim = env.race.time;
console.log(JSON.stringify({ seats: seats.length, learners: nl, ai: seats.length - nl, simS: +sim.toFixed(1), realtimeX: +(sim / wall).toFixed(1),
  carStepsPerS: Math.round(sim / FIXED_DT * seats.length / wall), decisionsPerS: Math.round(ticks * nl / wall),
  lap: env.cars.map((c) => c.race.lap), spd: env.cars.map((c) => +c.speed.toFixed(1)), dmg: env.cars.map((c) => +c.damage.toFixed(2)) }));
