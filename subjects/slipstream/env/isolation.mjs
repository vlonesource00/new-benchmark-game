// World isolation: world A's trajectory must be identical whether it runs alone or beside
// other worlds (same track, real AI seats) in one process — no shared mutable track or AI state.
import { World, ROW } from './world.mjs';
const mk = (seed) => { let s = seed; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const base = { learners: 2, classId: 'gt', lifetime: 900, latency: { min: 1, max: 6, longP: 0.03, longMin: 8, longMax: 30, dropP: 0.01 }, episode: { min: 60, max: 120 } };
const A = { ...base, track: 'harbor-ring', ai: ['intercept', 'apex', 'razor'], seed: 5 };
const others = [{ ...base, track: 'harbor-ring', ai: ['intercept', 'razor', 'apex'], seed: 9 }, { ...base, track: 'solenne', ai: ['apex', 'intercept'], seed: 3 }];
const ticks = +(process.argv[2] ?? 1500);
function run(withOthers) {
  const ws = [new World(A, mk(1)), ...(withOthers ? others.map((c, i) => new World(c, mk(50 + i))) : [])];
  const act = ws.map((w) => new Float32Array(w.agents.length * 2)), out = ws.map((w) => new Float32Array(w.agents.length * ROW));
  const st = { ticks: 0, dist: 0, legal: 0, speed: 0, episodes: 0, terminal: 0, why: {}, lap() {} };
  let r = 7; const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const trace = [];
  for (let k = 0; k < ticks; k++) {
    ws.forEach((w, i) => { for (let j = 0; j < act[i].length; j++) act[i][j] = i === 0 ? (j % 2 ? 0.3 + 0.5 * rnd() : (rnd() - 0.5) * 0.2) : Math.sin(k * 0.1 + j); });
    ws.forEach((w, i) => w.tick(act[i], out[i], 4, st));
    if (k % 50 === 49) trace.push(ws[0].env.race.cars.map((c) => [c.x, c.z, c.speed, c.damage].join(',')).join(';') + '|' + Array.from(out[0]).join(','));
  }
  return trace;
}
const a = run(false), b = run(true), first = a.findIndex((x, i) => x !== b[i]);
console.log(JSON.stringify({ ticks, identical: first < 0, firstDiffTick: first < 0 ? null : (first + 1) * 50 }));
