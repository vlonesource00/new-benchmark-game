// SLIPSTREAM race benchmark: real races (game race loop, unmodified) in the user's standard field: two-car same-AI
// teams, APEX on the last two grid slots, the other pairs rotated by seed (so over 5 seeds SLIPSTREAM starts from
// every grid row: front rows defend, back rows attack), rolling start.
//   short: 5 laps, hard tyres, no stops (one tank sized for the distance), as scripts/bench/tempest-field.mjs.
//   full:  the game's CLASSIC format (12 laps, one mandatory stop with a driver swap), the team strategist and the
//          pit-lane autopilot as in the browser, start compound by the strategist.
// Both SLIPSTREAM cars drive the bridge (game/bridges/slipstream-bridge.js) with the candidate's export (or the deployed
// weights for '-'). Per SLIPSTREAM car: grid, place, gained, points, best lap vs the field's best, legality, combat
// scorecard (env/scorecard.mjs). Per car of the field: place, best lap, incidents, damage, stops.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/racebench.mjs --label <name> [--policy export.json | -]
//        [--mode short|full] [--tracks harbor-ring,solenne,alpine,desert] [--seeds 1,2,3,4,5] [--laps N] [--start rolling|standing]
//        [--field standard|pool|<ai,ai,...>] [--weather clear] [--jobs 3]
// Seeds: 1-5 = selection, 11-15 = confirmation, 101-105 = fresh (each set covers every grid row once per track).
// Results: subjects/slipstream/runs/racebench/<label>/<mode>-<track>-s<seed>.json and <mode>-summary.json.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIELDS = {
  // the user's standard benchmark teams (APEX last). CLAUDE REV, SOLSTICE and SPEARHEAD are too slow for training
  // worlds (17x, 3.9x, 1.4x realtime per pair), so most of this field is never seen in training
  standard: ['slipstream', 'intercept', 'claude-revolution', 'solstice', 'next-racer', 'apex'],
  // the training roster's AIs (world `field.pool`): in-distribution opponents, to set against the standard field
  pool: ['slipstream', 'razor', 'tempest', 'gemini-supreme-v4', 'intercept', 'apex'],
};
const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

async function work([track, mode, seedArg, start, policy, fieldArg, weather, lapsArg]) {
  const { Track } = await import('../../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../../game/core/race.js');
  const { FORMATS } = await import('../../../game/core/rules.js');
  const { AI_DRIVERS } = await import('../../../game/core/teams.js');
  const { useWeights } = await import('../../../game/bridges/slipstream-bridge.js');
  const { scorecards } = await import('./scorecard.mjs');
  if (policy && policy !== '-') useWeights(JSON.parse(readFileSync(policy, 'utf8')));
  const seed = +seedArg, trk = new Track(track), full = mode === 'full';
  const ais = FIELDS[fieldArg] ?? fieldArg.split(','), last = ais.includes('apex') ? 'apex' : null, front = ais.filter((a) => a !== last);
  const rot = seed % front.length, order = [...front.slice(rot), ...front.slice(0, rot), ...(last ? [last] : [])];
  const ids = order.flatMap((id) => [id, id]);
  const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
  const teams = order.map((id, t) => ({ id: 't' + t, name: short(id), short: short(id), color: '#fff', index: t, starter: 0, grid: t,
    drivers: [{ kind: 'ai', id, name: id, short: short(id) }, { kind: 'ai', id, name: id, short: short(id) }] }));
  const entries = ids.map((id, i) => ({ ...teams[Math.floor(i / 2)], id: 'e' + i, index: i, grid: i, name: short(id) + i, short: short(id) + i }));
  const laps = +lapsArg || (full ? FORMATS.classic.laps : 5);
  const format = full ? FORMATS.classic : { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false };
  const race = new EnduranceRace({ track: trk, teams: entries, format, laps, ...(full ? {} : { startCompound: 'hard' }), startType: start, seed, weatherSeed: seed, weather });
  race.start();
  if (!full) {
    const tyre = weather === 'rain' ? 'wet' : 'hard';
    for (const c of race.cars) race.fitTyres(c, tyre, true);
    for (const e of race.entries) e.strategist.decide = () => null;
    for (const c of race.cars) c.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (laps + 1); // one tank for the distance
  }
  // Spearhead stops its search on a wall-clock budget: unbounded, so parallel jobs stay deterministic
  race.entries.forEach((e, i) => { const d = e.bridges[0]?.driver; if (d && ids[i] === 'next-racer' && d.o) d.o.planBudgetMs = Infinity; });
  await new Promise((r) => setTimeout(r, 1500)); // bridge weights load asynchronously
  const mine = ids.map((id, i) => (id === 'slipstream' ? i : -1)).filter((i) => i >= 0);
  const sc = scorecards(race, mine, trk);
  const cap = (full ? 150 : 140) * laps * Math.max(1, trk.length / 3000) + 300, t0 = performance.now();
  while (race.phase !== 'finished' && race.time < cap) {
    for (let k = 0; k < 4; k++) race.step(FIXED_DT);
    sc.update();
  }
  const ord = race.order(), fieldBest = Math.min(...race.cars.map((c) => c.race.bestLap ?? Infinity));
  const rows = race.cars.map((c, i) => { const st = race.stewards.of(race.entries[i]); return { ai: ids[i], grid: i + 1, place: ord.indexOf(c) + 1,
    best: c.race.bestLap && +c.race.bestLap.toFixed(3), inc: st.inc, pen: (st.penalties ?? []).length, dq: Boolean(st.dq), dmg: +(c.damage * 100).toFixed(1),
    stops: race.entries[i].strategist.stops, finished: c.race.finishTime !== null, time: c.race.finishTime && +c.race.finishTime.toFixed(2), lapsDone: c.race.lap - 1 }; });
  const sls = mine.map((i) => ({ ...rows[i], gained: rows[i].grid - rows[i].place, points: POINTS[rows[i].place - 1] ?? 0,
    bestGapPct: rows[i].best && Number.isFinite(fieldBest) ? +((rows[i].best / fieldBest - 1) * 100).toFixed(3) : null, ...sc.result(i) }));
  console.log(JSON.stringify({ track, mode, seed, start, weather, field: fieldArg, laps, order, finished: race.phase === 'finished', wallS: +((performance.now() - t0) / 1000).toFixed(0),
    fieldBest: Number.isFinite(fieldBest) ? +fieldBest.toFixed(3) : null, contacts: race.contacts, rows, sls }));
}

if (args[0] === '--run') { await work(args.slice(1)); process.exit(0); }

const label = flag('label'), policy = flag('policy', '-'), mode = flag('mode', 'short'), start = flag('start', 'rolling'), field = flag('field', 'standard');
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), seeds = flag('seeds', '1,2,3,4,5').split(','), weather = flag('weather', 'clear');
const laps = flag('laps', '0'), jobs = Math.min(6, +flag('jobs', 3));
if (!label) { console.error('--label required'); process.exit(1); }
const out = join(HERE, '..', 'runs', 'racebench', label); mkdirSync(out, { recursive: true });
const self = fileURLToPath(import.meta.url), root = join(HERE, '..', '..', '..');
const tasks = []; for (const t of tracks) for (const s of seeds) tasks.push([t, mode, s, start, policy, field, weather, laps]);
const run = (task) => new Promise((resolve) => {
  const f = join(out, `${mode}-${task[0]}-s${task[2]}${start === 'rolling' ? '' : '-' + start}${field === 'standard' ? '' : '-' + field}.json`);
  if (existsSync(f)) return resolve(JSON.parse(readFileSync(f, 'utf8'))); // never rerun a finished race
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', self, '--run', ...task], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
  p.on('close', () => { try { const r = JSON.parse(o.trim().split('\n').pop()); writeFileSync(f, JSON.stringify(r)); resolve(r); } catch { resolve({ task, error: e.trim().split('\n').slice(-3).join(' | ') }); } });
});
const queue = [...tasks], results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) { const t = queue.shift(); const r = await run(t); results.push(r); console.error(`done ${t[0]} s${t[2]} ${r.error ? 'FAILED ' + r.error : r.wallS + ' s'}`); } }));
for (const f of results.filter((r) => r.error)) console.log('FAILED', f.task.join(' '), f.error);
const ok = results.filter((r) => !r.error);
// Summary: SLIPSTREAM per car-race, overall and per track; every AI's mean place for reference.
const mean = (a, f) => (a.length ? +(a.reduce((x, r) => x + (f(r) ?? 0), 0) / a.length).toFixed(3) : null);
const sumUp = (cars) => ({ cars: cars.length, place: mean(cars, (c) => c.place), gained: mean(cars, (c) => c.gained), points: mean(cars, (c) => c.points),
  wins: cars.filter((c) => c.place === 1).length, bestGapPct: mean(cars.filter((c) => c.bestGapPct != null), (c) => c.bestGapPct),
  passes: mean(cars, (c) => c.passes), cleanPasses: mean(cars, (c) => c.cleanPasses), passedBy: mean(cars, (c) => c.passedBy),
  traffic: mean(cars, (c) => c.traffic), lappedByContact: mean(cars, (c) => c.lappedByContact), rubS: mean(cars, (c) => c.rubS), noseS: mean(cars, (c) => c.rubKinds.nose),
  offS: mean(cars, (c) => c.offS), invalidLaps: mean(cars, (c) => c.invalidLaps), inc: mean(cars, (c) => c.inc), pen: mean(cars, (c) => c.pen), dmg: mean(cars, (c) => c.dmg),
  dnf: cars.filter((c) => !c.finished || c.dq).length });
const all = ok.flatMap((r) => r.sls.map((c) => ({ ...c, track: r.track })));
const per = Object.fromEntries(tracks.map((t) => [t, sumUp(all.filter((c) => c.track === t))]));
const ai = {}; for (const r of ok) for (const w of r.rows) { const a = (ai[w.ai] ??= []); a.push(w.place); }
const summary = { label, policy, mode, start, field, weather, races: ok.length, failed: results.length - ok.length, sls: sumUp(all), perTrack: per,
  aiPlace: Object.fromEntries(Object.entries(ai).map(([k, v]) => [k, +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(2)]).sort((a, b) => a[1] - b[1])) };
writeFileSync(join(out, `${mode}-summary${start === 'rolling' ? '' : '-' + start}${field === 'standard' ? '' : '-' + field}.json`), JSON.stringify(summary, null, 1));
const s = summary.sls;
console.log(`racebench ${label} ${mode} ${field} ${start}: races ${ok.length} | place ${s.place} gained ${s.gained} pts ${s.points} wins ${s.wins} | best +${s.bestGapPct}% | passes ${s.passes} clean ${s.cleanPasses} lost ${s.passedBy} traffic ${s.traffic} | rub ${s.rubS} nose ${s.noseS} off ${s.offS} inv ${s.invalidLaps} inc ${s.inc} pen ${s.pen} dmg ${s.dmg} dnf ${s.dnf}`);
for (const [t, x] of Object.entries(per)) console.log(`  ${t.padEnd(12)} place ${x.place} gained ${x.gained} best +${x.bestGapPct}% passes ${x.passes}/${x.cleanPasses} lost ${x.passedBy} rub ${x.rubS} inv ${x.invalidLaps} inc ${x.inc}`);
console.log('  AI mean place: ' + Object.entries(summary.aiPlace).map(([k, v]) => `${k} ${v}`).join(' | '));
