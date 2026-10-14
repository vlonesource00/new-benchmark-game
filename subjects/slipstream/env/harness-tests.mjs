// Regression tests for the env harness (each reproduces a reported bug against the fixed code).
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/harness-tests.mjs
import { World, OBS, ROW } from './world.mjs';

const mk = (seed) => { let s = seed; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const base = { track: 'harbor-ring', learners: 2, ai: [], seed: 3, lifetime: 900, latency: { min: 1, max: 6, longP: 0.03, longMin: 8, longMax: 30 }, episode: { min: 60, max: 120 }, starts: { snapshot: 0, standing: 0 } };
const stats = () => ({ ticks: 0, dist: 0, legal: 0, speed: 0, episodes: 0, terminal: 0, why: {}, laps: [], lap(t, x) { this.laps.push([t, x]); } });
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const drive = (w, n, steer, pedal, st = stats()) => {
  const act = new Float32Array(w.agents.length * 2), out = new Float32Array(w.agents.length * ROW), rows = [];
  for (let k = 0; k < n; k++) { for (let i = 0; i < w.agents.length; i++) { act[2 * i] = steer; act[2 * i + 1] = pedal; } w.tick(act, out, 4, st); rows.push(out.slice()); }
  return rows;
};

// 1. A disqualified learner is fully reinstated by its episode reset and drives again.
{
  const w = new World({ ...base }, mk(1)); drive(w, 30, 0, 0.5);
  const a = w.agents[0]; w.env.race.stewards.disqualify(a.entry, 'TEST');
  const dqd = Boolean(a.entry.retired);
  w.resetAgent(a); a.first = 0;
  drive(w, 90, 0, 1);
  check('dq-reset', dqd && !a.entry.retired && !a.car.race.dq && a.car.race.finishTime === null && a.car.speed > 8,
    `retiredAfter=${a.entry.retired} speed=${a.car.speed.toFixed(1)}`);
}

// 2. World recycling ends every episode as a truncation; the next rows start new episodes.
{
  const w = new World({ ...base, lifetime: 4 }, mk(2));
  const rows = drive(w, 160, 0, 0.4), n = w.agents.length;
  let truncTick = -1;
  rows.forEach((r, k) => { if (truncTick < 0 && k > 10 && [...Array(n).keys()].every((i) => r[i * ROW + OBS + 2] === 1)) truncTick = k; });
  const next = truncTick >= 0 ? rows[truncTick + 1] : null, after = truncTick >= 0 ? rows[truncTick + 2] : null;
  const firstNext = next && [...Array(n).keys()].every((i) => next[i * ROW + OBS + 3] === 1 || after[i * ROW + OBS + 3] === 1);
  check('recycle-boundary', truncTick > 0 && firstNext, `truncTick=${truncTick}`);
}

// 3. One reply in flight: a later decision cannot be blocked behind, or overtake, an earlier one.
{
  const w = new World({ ...base, latency: { min: 1, max: 1, longP: 1, longMin: 25, longMax: 25 } }, mk(3));
  drive(w, 2, 0, 0);
  const a = w.agents[0], act = new Float32Array(w.agents.length * 2), out = new Float32Array(w.agents.length * ROW), st = stats();
  while (a.inflight) w.tick(act, out, 4, st);                   // let the warm-up reply land first
  act[0] = 0.5; act[1] = 0.9; w.tick(act, out, 4, st);           // reply A, lands after 25 physics ticks
  const busy0 = a.busy ?? 0;
  act[0] = -0.5; act[1] = -0.9; w.tick(act, out, 4, st);         // decision B while A is in flight: not delivered
  const dropped = (a.busy ?? 0) === busy0 + 1 && a.inflight.steer === 0.5;
  for (let k = 0; k < 6; k++) w.tick(act, out, 4, st);           // A lands (25 ticks), then a fresh B goes out
  const appliedA = a.applied[0] === 0.5 || a.applied[0] === -0.5;
  check('single-inflight', dropped && appliedA && !(a.inflight && a.inflight.at < 0), `applied=${a.applied} inflight=${JSON.stringify(a.inflight)}`);
}

// 4. Laps are scored only from the game's own lap verdicts (purple/green/yellow).
{
  const w = new World({ ...base, learners: 1, episode: { min: 400, max: 400 } }, mk(4)), st = stats();
  const a = w.agents[0], c = a.car;
  let gameClean = 0, laps0 = c.race.lap;
  const act = new Float32Array(2), out = new Float32Array(ROW), road = w.road;
  for (let k = 0; k < 30 * 600 && c.race.lap - laps0 < 4; k++) {
    // Stand-in driver (pursuit + curvature speed) only to generate laps; it is not part of SLIPSTREAM.
    const s = Math.floor(c.s), q = (s + 5 + Math.floor(c.speed * 0.3)) % road.n, h = Math.atan2(road.x[q] - c.x, road.z[q] - c.z);
    let kk = 1e-3; for (let d = 10; d < 120; d += 5) kk = Math.max(kk, Math.abs(road.k[(s + d) % road.n]));
    act[0] = Math.max(-1, Math.min(1, 1.3 * Math.atan2(Math.sin(h - c.yaw), Math.cos(h - c.yaw)))); act[1] = c.speed < Math.sqrt(7 / kk) ? 0.7 : -0.5;
    const before = c.race.lap; w.tick(act, out, 4, st);
    if (c.race.lap !== before && ['purple', 'green', 'yellow'].includes(c.race.lastState)) gameClean++;
  }
  check('laps-from-game', c.race.lap - laps0 >= 3 && st.laps.length === gameClean, `scored=${st.laps.length} gameClean=${gameClean} lapsRun=${c.race.lap - laps0}`);
}

// 5. The decide flag on a row says exactly whether the action taken on it is delivered (seat free) or dropped (busy).
{
  const w = new World({ ...base, learners: 3 }, mk(5)), st = stats(), n = w.agents.length;
  const act = new Float32Array(n * 2), out = new Float32Array(n * ROW);
  let wrong = 0, decided = 0, rows = 0;
  w.tick(act, out, 4, st);
  for (let k = 0; k < 600; k++) {
    const dec = w.agents.map((a, i) => out[i * ROW + OBS + 4]), ended = w.agents.map((a) => a.end), busy0 = w.agents.map((a) => a.busy ?? 0);
    for (let i = 0; i < n; i++) { act[2 * i] = Math.sin(k * 0.1 + i) * 0.3; act[2 * i + 1] = 0.6; }
    w.tick(act, out, 4, st);
    w.agents.forEach((a, i) => { if (ended[i]) return; rows++; decided += dec[i]; if ((dec[i] === 1) === ((a.busy ?? 0) > busy0[i])) wrong++; });
  }
  check('decide-flag', wrong === 0 && decided > 0 && decided < rows, `wrong=${wrong} decideRate=${(decided / rows).toFixed(3)} (${(30 * decided / rows).toFixed(1)} Hz)`);
}

// 6. Frame latency model (browser measurements): replies land exactly one frame (or, at extraP, two) after the observation,
// the frame time is fixed within an episode, and the decide flag stays exact.
{
  const latency = { frames: [[1, 0.3], [2, 0.35], [3, 0.1], [4, 0.15], [8, 0.1]], extraP: 0.05, longP: 0, longMin: 8, longMax: 30 };
  const w = new World({ ...base, learners: 3, latency }, mk(6)), st = stats(), n = w.agents.length;
  const act = new Float32Array(n * 2), out = new Float32Array(n * ROW);
  let wrong = 0, decided = 0, rows = 0, badLat = 0, sends = 0;
  w.tick(act, out, 4, st);
  for (let k = 0; k < 600; k++) {
    const dec = w.agents.map((a, i) => out[i * ROW + OBS + 4]), ended = w.agents.map((a) => a.end), busy0 = w.agents.map((a) => a.busy ?? 0), sub0 = w.sub;
    for (let i = 0; i < n; i++) { act[2 * i] = Math.sin(k * 0.1 + i) * 0.3; act[2 * i + 1] = 0.6; }
    w.tick(act, out, 4, st);
    w.agents.forEach((a, i) => {
      if (ended[i]) return; rows++; decided += dec[i]; if ((dec[i] === 1) === ((a.busy ?? 0) > busy0[i])) wrong++;
      if (dec[i] === 1 && a.inflight) { sends++; const lat = a.inflight.at - sub0; if (lat !== a.frame && lat !== 2 * a.frame) badLat++; }
    });
  }
  check('frame-latency', wrong === 0 && badLat === 0 && sends > 0, `wrong=${wrong} badLatency=${badLat}/${sends} decideRate=${(30 * decided / rows).toFixed(1)} Hz`);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
