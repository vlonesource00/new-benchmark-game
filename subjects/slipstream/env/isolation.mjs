// World isolation, through the worker's own world builder (env/build.mjs): a world's trajectory must not depend on
//   1. what the other worlds in its process do (their actions: throttle vs braking),
//   2. how the worlds are split over workers (4 worlds in one worker vs 2 + 2).
// Both catch shared mutable state: track / AI state and, before per-world generators, one random stream per worker
// (a neighbour's driving shifted the tested world's latency and reset draws within seconds).
import { buildWorlds } from './build.mjs';
import { ROW } from './world.mjs';

const ticks = +(process.argv[2] ?? 1500);
const base = { learners: 2, classId: 'gt', lifetime: 900, latency: { min: 1, max: 6, longP: 0.03, longMin: 8, longMax: 30, dropP: 0.01 },
  episode: { min: 20, max: 40 }, starts: { standing: 0.2, grid: 0.3 } };
const cfg = (worlds) => ({ worlds, seed: 3, tracks: ['harbor-ring'], world: { ...base, ai: ['intercept', 'apex', 'razor'] }, alt: { ...base, ai: [] } });

/** Steps the worlds; `drive(i, k, j)` is world i's action j at tick k. Returns per-world traces sampled every 25 ticks. */
function run(ws, drive) {
  const act = ws.map((w) => new Float32Array(w.agents.length * 2)), out = ws.map((w) => new Float32Array(w.agents.length * ROW));
  const st = { ticks: 0, dist: 0, legal: 0, speed: 0, episodes: 0, terminal: 0, why: {}, lap() {}, wrecks: [], lapEv: [], endEv: [] };
  const trace = ws.map(() => []);
  for (let k = 0; k < ticks; k++) {
    ws.forEach((w, i) => { for (let j = 0; j < act[i].length; j++) act[i][j] = drive(i, k, j); });
    ws.forEach((w, i) => w.tick(act[i], out[i], 4, st));
    if (k % 25 === 24) ws.forEach((w, i) => trace[i].push(w.env.race.cars.map((c) => [c.x, c.z, c.speed, c.damage].join(',')).join(';') + '|' + Array.from(out[i]).join(',')));
  }
  return trace;
}
const tested = (k, j) => (j % 2 ? 0.55 + 0.35 * Math.sin(k * 0.013 + j) : 0.15 * Math.sin(k * 0.021 + j));
const diff = (a, b) => { const i = a.findIndex((x, n) => x !== b[n]); return i < 0 ? null : (i + 1) * 25; };

// 1. neighbours throttle vs brake; world 0 drives the same
const thr = run(buildWorlds(cfg(3), 0), (i, k, j) => (i === 0 ? tested(k, j) : j % 2 ? 0.9 : Math.sin(k * 0.05)));
const brk = run(buildWorlds(cfg(3), 0), (i, k, j) => (i === 0 ? tested(k, j) : j % 2 ? -0.8 : -Math.sin(k * 0.03)));
// 2. worlds 0..3 in one worker vs worker 0 (g 0, 1) + worker 1 (g 2, 3); world g drives tested(k, j + g)
const one = run(buildWorlds(cfg(4), 0), (i, k, j) => tested(k, j + i));
const split = [...run(buildWorlds(cfg(2), 0), (i, k, j) => tested(k, j + i)), ...run(buildWorlds(cfg(2), 1), (i, k, j) => tested(k, j + 2 + i))];
const neighbours = diff(thr[0], brk[0]), splitDiff = one.map((t, g) => diff(t, split[g]));
const ok = neighbours === null && splitDiff.every((d) => d === null);
console.log(JSON.stringify({ ticks, ok, neighboursFirstDiffTick: neighbours, splitFirstDiffTick: splitDiff }));
process.exit(ok ? 0 : 1);
