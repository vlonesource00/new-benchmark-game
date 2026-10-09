// Duel bench: two cars, two AIs, side by side from the rolling start, both orders on every track. The cars are the
// same, so the result is combat: who leads at the flag, by how much, how often the lead changed, contacts.
// usage: node --import ./scripts/json-loader.mjs scripts/bench/tempest-duel.mjs [--a tempest] [--b razor]
//        [--tracks harbor-ring,solenne,alpine,desert] [--laps 3] [--cls lmdh] [--jobs 6] [--opts '{"key":value}' (for a)]
//   worker: ... tempest-duel.mjs --run <track> <laps> <cls> <first> <second> <optsJSON> <aId>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

async function work([trackName, lapsArg, cls, first, second, optsArg, aId]) {
  const { Track } = await import('../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../game/core/race.js');
  const { FORMATS } = await import('../../game/core/rules.js');
  const track = new Track(trackName), laps = Number(lapsArg), ids = [first, second], opts = JSON.parse(optsArg || '{}');
  const teams = ids.map((id, i) => ({ id: 'd' + i, name: id + i, short: id.slice(0, 3) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3) }], grid: i }));
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps, startCompound: 'hard', startType: 'rolling', seed: 7, weatherSeed: 7, weather: 'clear' });
  race.start();
  for (const c of race.cars) race.fitTyres(c, 'hard', true);
  for (const e of race.entries) e.strategist.decide = () => null;
  race.entries.forEach((e, i) => { const d = e.bridges[0]?.driver; if (!d) return; if (ids[i] === aId && i === ids.indexOf(aId)) Object.assign(d.options, opts); if (ids[i] === 'next-racer' && d.o) d.o.planBudgetMs = Infinity; });
  let leader = null, changes = 0, tick = 0; const cap = 140 * laps * Math.max(1, track.length / 3000) + 200, t0 = performance.now();
  while (race.phase !== 'finished' && race.time < cap && performance.now() - t0 < 570000) {
    race.step(FIXED_DT);
    if (race.formation || ++tick % 30) continue;
    const l = race.cars.indexOf(race.order()[0]); if (leader != null && l !== leader) changes++; leader = l;
  }
  const ord = race.order(), win = race.cars.indexOf(ord[0]), [c0, c1] = ord;
  const gap = c0.race.finishTime != null && c1.race.finishTime != null ? c1.race.finishTime - c0.race.finishTime : null;
  console.log(JSON.stringify({ track: trackName, first, second, winner: ids[win], winnerSlot: win, gap, changes, contacts: race.contacts, inc: race.cars.map((c, i) => race.stewards.of(race.entries[i]).inc), dmg: race.cars.map((c) => +(c.damage * 100).toFixed(1)), best: race.cars.map((c) => c.race.bestLap) }));
}

if (args[0] === '--run') { await work(args.slice(1)); process.exit(0); }

const a = flag('a', 'tempest'), b = flag('b', 'razor'), tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), laps = flag('laps', '3');
const cls = flag('cls', 'lmdh'), jobs = Number(flag('jobs', 6)), opts = flag('opts', '{}'), self = fileURLToPath(import.meta.url);
const tasks = []; for (const t of tracks) { tasks.push([t, laps, cls, a, b, opts, a]); tasks.push([t, laps, cls, b, a, opts, a]); }
const run = (task) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', self, '--run', ...task], { stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW); } catch {}
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ task, error: err.trim().split('\n').slice(-3).join(' | ') }); } });
});
const queue = [...tasks], results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) { const t = queue.shift(); results.push(await run(t)); } }));
for (const f of results.filter((r) => r.error)) console.log('FAILED', f.task.join(' '), f.error);
let wins = 0, n = 0, margin = 0;
for (const r of results.filter((x) => !x.error).sort((x, y) => (x.track + x.first).localeCompare(y.track + y.first))) {
  n++; const aWon = r.winner === a; if (aWon) wins++;
  const m = r.gap == null ? 0 : (aWon ? r.gap : -r.gap); margin += m;
  console.log(`${r.track.padEnd(12)} pole ${r.first.padEnd(10)} winner ${r.winner.padEnd(10)} ${a} margin ${m >= 0 ? '+' : ''}${m.toFixed(2)} s  lead changes ${r.changes}  contacts ${r.contacts}  inc ${r.inc.join('/')}  dmg ${r.dmg.join('/')}`);
}
console.log(`\n${a} vs ${b}: ${wins}/${n} wins, mean margin ${(margin / Math.max(1, n)).toFixed(2)} s (positive = ${a} ahead)`);
