// SLIPSTREAM env worker: a set of worlds stepped in lockstep with the learner over binary pipes.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/worker.mjs <config.json> <worker-index>
// Handshake: one JSON line on stdout {agents, obs, row, ...}. Then per tick:
//   stdin  <- Float32 [agents x 2]       (steer, pedal) per learner
//   stdout -> Float32 [agents x ROW]     obs | reward, done, truncated, first
// Stats: one JSON line on stderr every `statsEvery` ticks.
import { readFileSync } from 'node:fs';
import { World, OBS, ROW, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F } from './world.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const index = +process.argv[3] || 0;
let seed = (cfg.seed ?? 1) * 7919 + index * 104729;
const rng = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// World list: explicit, or drawn round-robin from the track / weather pools.
const worlds = [];
const tracks = cfg.tracks ?? ['harbor-ring'], weathers = cfg.weathers ?? ['clear'];
for (let w = 0; w < cfg.worlds; w++) {
  const g = index * cfg.worlds + w;
  worlds.push(new World({ ...cfg.world, track: tracks[g % tracks.length], weather: weathers[Math.floor(g / tracks.length) % weathers.length], seed: 1000 + g * 31 + (cfg.seed ?? 1) }, rng));
}
const offsets = []; let agents = 0;
for (const w of worlds) { offsets.push(agents); agents += w.agents.length; }
const actions = new Float32Array(agents * 2), out = new Float32Array(agents * ROW), outBuf = Buffer.from(out.buffer);
const substeps = cfg.substeps ?? 4;

process.stdout.write(JSON.stringify({ agents, obs: OBS, row: ROW, ego: EGO_F, roadK: ROAD_K, roadF: ROAD_F, rivalN: RIVAL_N, rivalF: RIVAL_F, worlds: worlds.map((w) => ({ track: w.track.id, agents: w.agents.length, ai: w.cfg.ai ?? [] })) }) + '\n');

const stats = () => ({ ticks: 0, dist: 0, legal: 0, speed: 0, episodes: 0, terminal: 0, why: {}, laps: {}, lap(track, t) { (this.laps[track] ??= []).push(+t.toFixed(3)); } });
let st = stats(), tick = 0, busy = 0; const t0 = performance.now(); let tStats = t0;

function step() {
  const ts = performance.now();
  worlds.forEach((w, i) => w.tick(actions.subarray(offsets[i] * 2), out.subarray(offsets[i] * ROW), substeps, st));
  busy += performance.now() - ts;
  process.stdout.write(outBuf);
  if (++tick % (cfg.statsEvery ?? 600) === 0) {
    const now = performance.now(), wall = (now - tStats) / 1000;
    process.stderr.write(JSON.stringify({ w: index, tick, sps: Math.round(st.ticks / wall), busy: +(busy / (now - tStats)).toFixed(3),
      speed: +(st.speed / Math.max(1, st.ticks)).toFixed(2), legal: +(st.legal / Math.max(1, st.ticks)).toFixed(4), eps: st.episodes, term: st.terminal, why: st.why, laps: st.laps }) + '\n');
    st = stats(); busy = 0; tStats = now;
  }
}

// Read exactly agents*8 bytes per tick; the first tick runs on an all-zero action so the learner gets initial obs.
const need = agents * 8; let pend = Buffer.alloc(0);
step();
process.stdin.on('data', (chunk) => {
  pend = pend.length ? Buffer.concat([pend, chunk]) : chunk;
  while (pend.length >= need) {
    const msg = pend.subarray(0, need); pend = pend.subarray(need);
    new Uint8Array(actions.buffer).set(msg);
    step();
  }
});
process.stdin.on('end', () => process.exit(0));
