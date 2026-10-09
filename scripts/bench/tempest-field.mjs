// TEMPEST field bench: two-car same-AI teams (TEMPEST, RAZOR, Spearhead, APEX), APEX on the last two grid slots and
// the other pairs rotated by seed, rolling start, hard tyres (wets in rain). Per AI: finishing place, rank changes made
// and suffered (sampled once a second: any order change, not a clearance outcome), best lap, incident points, damage.
// For TEMPEST also its clearance outcomes (subjects/tempest/src/outcomes.js): attacks declared > started > overlap >
// completed > retained, race passes completed/retained, race places lost, traffic passed.
// TEMPEST's --opts go in after the drivers prepare (per-class config would overwrite them) and are checked.
// --path worker drives every seat through the game's seat workers (async-seats + seat-worker, replies held to frame
// boundaries by scripts/bench/lockstep-workers.mjs), as the browser does; --frameSteps/--lagFrames set the cadence.
// usage: node --import ./scripts/json-loader.mjs scripts/bench/tempest-field.mjs [--tracks harbor-ring,solenne,alpine]
//        [--laps 5] [--seeds 7,8] [--weather clear|rain] [--cls lmdh] [--jobs 3] [--opts '{"key":value}'] [--ais tempest,razor,next-racer,apex]
//        [--path native|worker] [--frameSteps 2] [--lagFrames 0]
//   worker: ... tempest-field.mjs --run <track> <laps> <seed> <weather> <cls> <optsJSON> <ais> <path> <frameSteps> <lagFrames>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

async function work([trackName, lapsArg, seedArg, weather, cls, optsArg, aisArg, pathArg = 'native', fsArg = '2', lagArg = '0']) {
  const shim = pathArg === 'worker' ? (await import('./lockstep-workers.mjs')).installWorkerShim({ frameSteps: Number(fsArg), lagFrames: Number(lagArg) }) : null;
  // on the worker path the drivers live inside the worker modules: find TEMPEST's by its class, and keep Spearhead's
  // wall-clock search budget off there too
  const found = [];
  if (shim) {
    const { TempestDriver } = await import('../../subjects/tempest/src/driver.js'), { SpearheadDriver } = await import('../../subjects/next-racer/src/driver.js');
    // both teammates' seats build a driver: the books are the ones of drivers that drove
    const u1 = TempestDriver.prototype.update; TempestDriver.prototype.update = function (...x) { if (!found.includes(this)) found.push(this); return u1.apply(this, x); };
    const u0 = SpearheadDriver.prototype.update; SpearheadDriver.prototype.update = function (...x) { if (this.o) this.o.planBudgetMs = Infinity; return u0.apply(this, x); };
  }
  const seats = shim ? new (await import('../../game/core/async-seats.js')).AsyncSeats(trackName) : null;
  const { Track } = await import('../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../game/core/race.js');
  const { FORMATS } = await import('../../game/core/rules.js');
  const { AI_DRIVERS } = await import('../../game/core/teams.js');
  const laps = Number(lapsArg), seed = Number(seedArg), track = new Track(trackName), opts = JSON.parse(optsArg || '{}');
  const ais = aisArg.split(','), last = ais.includes('apex') ? 'apex' : null, front = ais.filter((a) => a !== last);
  const rot = seed % front.length, order = [...front.slice(rot), ...front.slice(0, rot), ...(last ? [last] : [])];
  const ids = order.flatMap((id) => [id, id]);
  const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
  const teams = order.map((id, t) => ({ id: 't' + t, name: short(id), short: short(id), color: '#fff', index: t, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ kind: 'ai', id, name: id, short: short(id) }, { kind: 'ai', id, name: id, short: short(id) }], grid: t }));
  // one car per entry: two entries per AI (teammates), as in the browser field
  const entries = ids.map((id, i) => ({ ...teams[Math.floor(i / 2)], id: 'e' + i, index: i, grid: i, name: short(id) + i, short: short(id) + i }));
  const race = new EnduranceRace({ track, teams: entries, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed, weather, ...(seats ? { makeBridge: seats.factory() } : {}) });
  if (seats) { const ready = seats.start(race); await shim.settle(); await ready; if (seats.hosts.some((h) => h?.failed)) throw new Error('seat worker failed'); }
  const step = () => { race.step(FIXED_DT); shim?.step(); };
  race.start();
  const tyre = weather === 'rain' ? 'wet' : 'hard';
  for (const c of race.cars) race.fitTyres(c, tyre, true);
  for (const e of race.entries) e.strategist.decide = () => null;
  // no pit stops here, so one tank must last the distance (the race sizes it for ~0.68 of the laps and expects a stop)
  for (const c of race.cars) c.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (laps + 1);
  // Spearhead stops its search on a wall-clock budget; parallel bench jobs would make it (and the race) nondeterministic
  race.entries.forEach((e, i) => { const d = e.bridges[0]?.driver; if (d && ids[i] === 'next-racer' && d.o) d.o.planBudgetMs = Infinity; });
  let mine = race.entries.map((e, i) => (ids[i] === 'tempest' ? e.bridges[0]?.driver : null)).filter(Boolean);
  if (shim) { step(); mine = found;   // filled as the drivers drive (same array)
    if (seats.hosts.some((h) => h?.failed)) throw new Error('seat worker failed'); }
  if (Object.keys(opts).length) {
    step();
    for (const d of mine) { Object.assign(d.options, opts); d.forceRefresh = true; }
    for (const d of mine) for (const [k, v] of Object.entries(opts)) if (JSON.stringify(d.options[k]) !== JSON.stringify(v)) throw new Error(`option ${k} did not take`);
  }
  const n = race.cars.length, made = new Array(n).fill(0), lost = new Array(n).fill(0);
  let prev = null, tick = 0; const cap = 140 * laps * Math.max(1, track.length / 3000) + 200, t0 = performance.now();
  while (race.phase !== 'finished' && race.time < cap) {
    step();
    if (race.formation || ++tick % 60) continue;
    const ord = race.order().map((c) => race.cars.indexOf(c)), pos = new Array(n); ord.forEach((ci, p) => { pos[ci] = p; });
    if (prev) for (let i = 0; i < n; i++) { if (pos[i] < prev[i]) made[i] += prev[i] - pos[i]; else if (pos[i] > prev[i]) lost[i] += pos[i] - prev[i]; }
    prev = pos;
    if (performance.now() - t0 > 570000) break;
  }
  const ord = race.order();
  const rows = race.cars.map((c, i) => { const st = race.stewards.of(race.entries[i]); return { ai: ids[i], grid: i + 1, place: ord.indexOf(c) + 1, made: made[i], lost: lost[i], best: c.race.bestLap,
    inc: st.inc, dq: st.dq, kinds: st.log.reduce((m, l) => (m[l.kind] = (m[l.kind] ?? 0) + l.points, m), {}), t42: st.log.find((l, k, a) => a.slice(0, k + 1).reduce((s, x) => s + x.points, 0) >= 41)?.time, dmg: +(c.damage * 100).toFixed(1), assoc: race.entries[i].bridges[0]?.driver?.combat?.stats?.associatedPasses ?? null }; });
  const out = mine.map((d) => d.arbiter?.outcomes?.books()).filter(Boolean);
  if (seats?.hosts.some((h) => h?.failed)) throw new Error('seat worker failed');
  console.log(JSON.stringify({ track: trackName, seed, weather, path: pathArg, finished: race.phase === 'finished', contacts: race.contacts, severe: race.collisionStats.severeContacts, rows, out }));
}

if (args[0] === '--run') { await work(args.slice(1)); process.exit(0); }

const tracks = flag('tracks', 'harbor-ring,solenne,alpine').split(','), laps = flag('laps', '5'), seeds = flag('seeds', '7,8').split(',');
const weather = flag('weather', 'clear'), cls = flag('cls', 'lmdh'), jobs = Number(flag('jobs', 3)), opts = flag('opts', '{}');
const ais = flag('ais', 'tempest,razor,next-racer,apex'), self = fileURLToPath(import.meta.url);
const path = flag('path', 'native'), frameSteps = flag('frameSteps', '2'), lagFrames = flag('lagFrames', '0');
const tasks = []; for (const t of tracks) for (const sd of seeds) tasks.push([t, laps, sd, weather, cls, opts, ais, path, frameSteps, lagFrames]);
console.log(`path ${path}${path === 'worker' ? ` (${frameSteps} steps/frame, +${lagFrames} frames)` : ''}, opts ${opts}`);
const run = (task) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', self, '--run', ...task], { stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW); } catch {}
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ task, error: err.trim().split('\n').slice(-3).join(' | ') }); } });
});
const queue = [...tasks], results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) { const t = queue.shift(); results.push(await run(t)); console.error(`done ${t.slice(0, 4).join(' ')}`); } }));
for (const f of results.filter((r) => r.error)) console.log('FAILED', f.task.join(' '), f.error);
const ok = results.filter((r) => !r.error), agg = {};
for (const r of ok) {
  console.log(`${r.track.padEnd(12)} ${r.seed} ${r.weather} ${r.finished ? '' : 'UNFINISHED '}contacts ${r.contacts} severe ${r.severe} | ` + r.rows.slice().sort((a, b) => a.place - b.place).map((w) => `P${w.place} ${w.ai.slice(0, 4)}(g${w.grid} +${w.made}/-${w.lost} i${w.inc} d${w.dmg})`).join(' '));
  for (const w of r.rows) { const a = (agg[w.ai] ??= { n: 0, place: 0, made: 0, lost: 0, inc: 0, dmg: 0, best: 0, bn: 0, wins: 0 }); a.n++; a.place += w.place; a.made += w.made; a.lost += w.lost; a.inc += w.inc; a.dmg += w.dmg; if (w.best) { a.best += w.best; a.bn++; } if (w.place === 1) a.wins++; }
}
console.log('\nAI          cars  place  wins  ranks+   ranks-  inc   dmg%  best   (ranks: sampled order changes)');
for (const [ai, a] of Object.entries(agg).sort((x, y) => x[1].place / x[1].n - y[1].place / y[1].n))
  console.log(`${ai.padEnd(11)} ${String(a.n).padStart(4)}  ${(a.place / a.n).toFixed(2)}  ${String(a.wins).padStart(4)}  ${(a.made / a.n).toFixed(2).padStart(7)}  ${(a.lost / a.n).toFixed(2).padStart(7)}  ${(a.inc / a.n).toFixed(1).padStart(4)}  ${(a.dmg / a.n).toFixed(1).padStart(4)}  ${a.bn ? (a.best / a.bn).toFixed(2) : '-'}`);
// TEMPEST clearance outcomes, per car per race
const ob = ok.flatMap((r) => r.out ?? []), per = (f) => (ob.reduce((x, b) => x + f(b), 0) / Math.max(1, ob.length)).toFixed(2);
if (ob.length) {
  const failed = {}; for (const b of ob) for (const [k, v] of Object.entries(b.failed)) failed[k] = (failed[k] ?? 0) + v;
  console.log('');
  console.log(`TEMPEST outcomes per car-race (${ob.length}): attacks declared ${per((b) => b.declared)} > started ${per((b) => b.started)} > overlap ${per((b) => b.overlap)} > completed ${per((b) => b.completed)} > retained ${per((b) => b.retained)}`);
  console.log(`  race passes ${per((b) => b.race.done)} (retained ${per((b) => b.race.kept)}), race places lost ${per((b) => b.lost)}, traffic passed ${per((b) => b.traffic.done)}, failed attacks ${JSON.stringify(failed)}`);
}
