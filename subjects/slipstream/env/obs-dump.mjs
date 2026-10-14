// Deterministic observation dump (refactor guard).  node --import ./scripts/json-loader.mjs subjects/slipstream/env/obs-dump.mjs <out.bin>
import { writeFileSync } from 'node:fs';
import { World, ROW } from './world.mjs';
const mk = (seed) => { let s = seed; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const st = { ticks: 0, dist: 0, legal: 0, speed: 0, episodes: 0, terminal: 0, why: {}, laps: [], lap() {} };
const chunks = [];
for (const track of ['harbor-ring', 'alpine']) {
  const w = new World({ track, learners: 2, ai: ['intercept'], seed: 5, lifetime: 900, latency: { min: 1, max: 6, longP: 0.03, longMin: 8, longMax: 30 }, episode: { min: 60, max: 120 }, starts: { snapshot: 0.3, failure: 0.25, standing: 0.1 } }, mk(9));
  const n = w.agents.length, act = new Float32Array(n * 2), out = new Float32Array(n * ROW);
  for (let k = 0; k < 400; k++) { for (let i = 0; i < n; i++) { act[2 * i] = Math.sin(k * 0.07 + i) * 0.4; act[2 * i + 1] = 0.7 - 0.5 * Math.sin(k * 0.03); } w.tick(act, out, 4, st); chunks.push(Buffer.from(out.slice().buffer)); }
}
writeFileSync(process.argv[2], Buffer.concat(chunks));
console.log('rows', chunks.length);
