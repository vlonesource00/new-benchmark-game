// SLIPSTREAM env worker: a set of worlds stepped in lockstep with the learner over binary pipes.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/worker.mjs <config.json> <worker-index>
// Handshake: one JSON line on stdout {agents, obs, row, ...}. Then per tick:
//   stdin  <- Float32 [agents x 2]       (steer, pedal) per learner
//   stdout -> Float32 [agents x ROW]     obs | reward, done, truncated, first, decide
// Stats: one JSON line on stderr every `statsEvery` ticks.
import { readFileSync, writeFileSync } from 'node:fs';
import { OBS, ROW, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F, EGO_X, RIVAL_X, CORR_X } from './world.mjs';
import { buildWorlds } from './build.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const index = +process.argv[3] || 0;
const worlds = buildWorlds(cfg, index);
const offsets = []; let agents = 0;
for (const w of worlds) { offsets.push(agents); agents += w.agents.length; }
const actions = new Float32Array(agents * 2), out = new Float32Array(agents * ROW), outBuf = Buffer.from(out.buffer);
const substeps = cfg.substeps ?? 4;

process.stdout.write(JSON.stringify({ agents, obs: OBS, row: ROW, ego: EGO_F, roadK: ROAD_K, roadF: ROAD_F, rivalN: RIVAL_N, rivalF: RIVAL_F, egoX: EGO_X, rivalX: RIVAL_X, corrX: CORR_X, worlds: worlds.map((w) => ({ track: w.track.id, agents: w.agents.length, ai: w.cfg.ai ?? [] })) }) + '\n');

const stats = () => ({ ticks: 0, dist: 0, legal: 0, speed: 0, episodes: 0, terminal: 0, why: {}, laps: {}, wrecks: [], lapEv: [], endEv: [], lap(track, t) { (this.laps[track] ??= []).push(+t.toFixed(3)); } });
// Replay recording (viewer): world 0 only, written when the learner closes the pipe.
const rec = cfg.record ? { geometry: worlds[0].geometry(), cars: worlds[0].env.race.cars.map((c, i) => ({ id: i, name: c.team?.short, color: c.color, learner: worlds[0].env.learners.includes(i), ai: worlds[0].cfg.ai?.[i - worlds[0].cfg.learners] ?? null })), frames: [] } : null;
let st = stats(), tick = 0, busy = 0; const t0 = performance.now(); let tStats = t0;

function step() {
  const ts = performance.now();
  st.tick = tick;
  worlds.forEach((w, i) => { st.base = offsets[i]; w.tick(actions.subarray(offsets[i] * 2), out.subarray(offsets[i] * ROW), substeps, st); });
  busy += performance.now() - ts;
  if (rec) rec.frames.push(worlds[0].frame());
  process.stdout.write(outBuf);
  if (++tick % (cfg.statsEvery ?? 600) === 0) {
    const now = performance.now(), wall = (now - tStats) / 1000;
    process.stderr.write(JSON.stringify({ w: index, tick, sps: Math.round(st.ticks / wall), busy: +(busy / (now - tStats)).toFixed(3),
      speed: +(st.speed / Math.max(1, st.ticks)).toFixed(2), legal: +(st.legal / Math.max(1, st.ticks)).toFixed(4), eps: st.episodes, term: st.terminal, inc: st.incidents ?? 0, rear: st.rearEnds ?? 0, ttc: +(st.ttc ?? 0).toFixed(2), rub: +(st.rub ?? 0).toFixed(2), clear: +(st.clear ?? 0).toFixed(2), passes: st.passes ?? 0, dirty: st.dirty ?? 0, lostP: st.lostP ?? 0, closes: st.closes ?? 0, stuckS: +(st.stuckS ?? 0).toFixed(1), leadS: +(st.leadS ?? 0).toFixed(1), followS: +(st.followS ?? 0).toFixed(1), closeS: +(st.closeS ?? 0).toFixed(1), relV: +(st.relV ?? 0).toFixed(1), ticks: st.ticks, ledger: Object.fromEntries(Object.entries(st.ledger ?? {}).map(([k, v]) => [k, +v.toFixed(3)])), why: st.why, laps: st.laps, wrecks: st.wrecks, lapEv: st.lapEv, endEv: st.endEv }) + '\n');
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
process.stdin.on('end', () => { if (rec) writeFileSync(cfg.record, JSON.stringify(rec)); process.exit(0); });
