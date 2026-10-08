// RAZOR A/B bench for the straight-line stability gate in the shared APEX driver (RAZOR inherits it).
//   old: wobbleFloor 1 (every yaw wobble on a straight lifts the pedals, as before)   new: the shipped gate
// Same seed, field and track for both variants; reports RAZOR pace, result, incidents and straight-line pedal lifts.
// usage: node --import ./scripts/json-loader.mjs scripts/bench/razor-stab-ab.mjs [--tracks harbor-ring,solenne,alpine]
//        [--laps 5] [--seeds 7] [--cls lmdh] [--jobs 3] [--solo-laps 4]
//   worker: ... razor-stab-ab.mjs --run <field|solo> <old|new> <track> <laps> <seed> <cls>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const FIELD = ['razor', 'razor', 'apex', 'apex', 'next-racer', 'next-racer', 'solstice', 'solstice', 'claude-revolution', 'claude-revolution'];

async function work([mode, variant, trackName, lapsArg, seedArg, cls]) {
  const { Track } = await import('../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../game/core/race.js');
  const { FORMATS } = await import('../../game/core/rules.js');
  const { AI_DRIVERS } = await import('../../game/core/teams.js');
  const { ApexDriver } = await import('../../subjects/apex/src/driver.js');
  const ids = mode === 'solo' ? ['razor'] : FIELD, laps = Number(lapsArg), seed = Number(seedArg), track = new Track(trackName);
  const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
  const teams = ids.map((id, i) => ({ id: 't' + i, name: short(id) + i, short: short(id) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ kind: 'ai', id, name: id, short: short(id) }], grid: i }));
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed });
  for (const e of race.entries) e.strategist.decide = () => null;
  race.start(); for (const c of race.cars) race.fitTyres(c, 'hard', true);
  const drivers = race.entries.map((e) => e.bridges[0].driver);
  if (variant === 'old') for (const d of drivers) if (d instanceof ApexDriver) d.options.wobbleFloor = 1;
  const rz = race.entries.map((e, i) => i).filter((i) => ids[i] === 'razor');
  const m = Object.fromEntries(rz.map((i) => [i, { frames: 0, straight: 0, stabLow: 0, lifts: 0, wasFull: false, labelFlips: 0, lastLabel: null, laps: [] }]));
  const lapSeen = race.cars.map(() => 1), cap = 120 * laps * Math.max(1, track.length / 3000) + 120;
  while (race.cars.some((c, i) => rz.includes(i) && c.race.lap <= laps) && race.time < cap) {
    race.step(FIXED_DT);
    race.cars.forEach((c, i) => { if (c.race.lap !== lapSeen[i]) { lapSeen[i] = c.race.lap; m[i]?.laps.push(+c.race.lastLap.toFixed(3)); } });
    if (race.formation) continue;
    for (const i of rz) {
      const d = drivers[i], c = race.cars[i], s = m[i]; if (!d?.line) continue;
      s.frames++; if (d.stability < 0.5) s.stabLow++;
      // a straight: fast and the path asks for little lateral force; a lift is full throttle dropping below 60 % without braking
      const str = c.speed > 50 && Math.abs(d.ayReq ?? 99) < 4, thr = c.controls.throttle;
      if (str) { s.straight++; if (s.wasFull && thr < 0.6 && !(c.controls.brake > 0)) s.lifts++; }
      s.wasFull = str && thr > 0.95;
      if (s.lastLabel && d.mode !== s.lastLabel && str) s.labelFlips++; s.lastLabel = d.mode;
    }
  }
  const ord = race.order(), lead = ord[0], perMin = (n, s) => +(n / Math.max(1 / 60, s / 120 / 60)).toFixed(2);
  const rows = rz.map((i) => {
    const c = race.cars[i], e = race.entries[i], st = race.stewards.of(e), s = m[i], clean = s.laps.slice(1);
    return { car: i, place: ord.indexOf(c) + 1, gap: +(c.race.progress - lead.race.progress).toFixed(0), best: c.race.bestLap, mean: clean.length ? +(clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(3) : null,
      inc: st.inc, dmg: +(c.damage * 100).toFixed(1), stabLowPct: +(100 * s.stabLow / Math.max(1, s.frames)).toFixed(2), liftsPerMin: perMin(s.lifts, s.straight),
      labelFlipsPerMin: perMin(s.labelFlips, s.straight), passes: drivers[i]?.combat?.stats?.passes ?? null };
  });
  console.log(JSON.stringify({ mode, variant, track: trackName, seed, contacts: race.contacts, severe: race.collisionStats.severeContacts, rows }));
}

if (args[0] === '--run') { await work(args.slice(1)); process.exit(0); }

const tracks = flag('tracks', 'harbor-ring,solenne,alpine').split(','), laps = flag('laps', '5'), seeds = flag('seeds', '7').split(','), cls = flag('cls', 'lmdh');
const soloLaps = flag('solo-laps', '4'), jobs = Number(flag('jobs', 3)), self = fileURLToPath(import.meta.url);
const tasks = [];
for (const t of tracks) for (const sd of seeds) for (const v of ['old', 'new']) tasks.push(['field', v, t, laps, sd, cls]);
if (soloLaps !== '0') for (const t of tracks) for (const v of ['old', 'new']) tasks.push(['solo', v, t, soloLaps, seeds[0], cls]);
const run = (task) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', self, '--run', ...task], { stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW); } catch {}
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ task, error: err.trim().split('\n').slice(-3).join(' | ') }); } });
});
const queue = [...tasks], results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) { const t = queue.shift(); results.push(await run(t)); console.error(`done ${t.join(' ')}`); } }));
for (const f of results.filter((r) => r.error)) console.log('FAILED', f.task.join(' '), f.error);
const ok = results.filter((r) => !r.error), key = (r) => `${r.mode} ${r.track} ${r.seed}`;
const sum = { old: {}, new: {} }, add = (v, k, x) => { if (x == null) return; const a = (sum[v][k] ??= { s: 0, n: 0 }); a.s += x; a.n++; };
console.log('\nmode  track        seed var | car place gap best mean | inc dmg | stabLow% lifts/min labelFlips/min | passes | field contacts severe');
for (const k of [...new Set(ok.map(key))]) for (const v of ['old', 'new']) {
  const r = ok.find((x) => key(x) === k && x.variant === v); if (!r) continue;
  for (const w of r.rows) {
    console.log(`${r.mode.padEnd(5)} ${r.track.padEnd(12)} ${String(r.seed).padStart(4)} ${v} | #${w.car} P${w.place} ${String(w.gap).padStart(5)} ${w.best?.toFixed(2)} ${w.mean?.toFixed(2)} | ${w.inc} ${w.dmg}% | ${w.stabLowPct} ${w.liftsPerMin} ${w.labelFlipsPerMin} | ${w.passes ?? '-'} | ${r.contacts} ${r.severe}`);
    const p = r.mode; if (p === 'field') add(v, 'field place', w.place); add(v, `${p} best lap`, w.best); add(v, `${p} mean lap`, w.mean); add(v, `${p} incident pts`, w.inc); add(v, `${p} damage %`, w.dmg);
    add(v, `${p} stability<0.5 %`, w.stabLowPct); add(v, `${p} straight lifts/min`, w.liftsPerMin); add(v, `${p} straight label flips/min`, w.labelFlipsPerMin); if (p === 'field') add(v, 'field passes', w.passes);
  }
  if (r.mode === 'field') { add(v, 'field contacts (race)', r.contacts); add(v, 'field severe (race)', r.severe); }
}
console.log('\nSUMMARY (mean per RAZOR car, or per race)          old       new');
for (const k of Object.keys(sum.new)) { const f = (v) => (sum[v][k] ? (sum[v][k].s / sum[v][k].n).toFixed(3) : '-').padStart(9); console.log(`  ${k.padEnd(44)} ${f('old')} ${f('new')}`); }
