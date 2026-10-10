// Traffic fixture: TEMPEST starts at the back of a single-file rolling start behind `--n` cars it should get past —
// a GT3 train in front of a GTP (--scene gt3), or same-class rivals slowed by a margin (--scene slow). Each traffic
// car is booked from when TEMPEST first closes within 40 m of it to when our rear clears its nose: the time it took,
// how far TEMPEST went off the racing line meanwhile, time spent near the road edge, the decisions' compute cost, and
// how long it sat within 25 m behind (stuck). Progress at the end is compared with TEMPEST alone (--solo run).
// usage: node --import ./scripts/json-loader.mjs scripts/bench/tempest-traffic.mjs [--scene gt3|slow] [--n 3]
//        [--rival razor] [--rivalOpts '{"margin":0.85}'] [--track harbor-ring] [--time 90] [--seed 7] [--opts '{}']
//        [--path native|worker] [--lagFrames 0] [--solo] [--trace]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
import { TempestDriver } from '../../subjects/tempest/src/driver.js';
import { installWorkerShim } from './lockstep-workers.mjs';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const scene = flag('scene', 'gt3'), nT = Number(flag('n', 3)), rival = flag('rival', 'razor'), trackName = flag('track', 'harbor-ring');
const T = Number(flag('time', 90)), seed = Number(flag('seed', 7)), opts = JSON.parse(flag('opts', '{}')), solo = args.includes('--solo');
const rivalOpts = JSON.parse(flag('rivalOpts', scene === 'slow' ? '{"margin":0.85}' : '{}'));
const path = flag('path', 'native'), lagFrames = Number(flag('lagFrames', 0));
const shim = path === 'worker' ? installWorkerShim({ frameSteps: 2, lagFrames, seed }) : null;
const { AsyncSeats } = shim ? await import('../../game/core/async-seats.js') : {};
const made = [], ms = [];
{ const r0 = TempestDriver.prototype.reset; TempestDriver.prototype.reset = function (...x) { if (!made.includes(this)) made.push(this); return r0.apply(this, x); }; }
{ const u0 = TempestDriver.prototype.update; TempestDriver.prototype.update = function (...x) { const t0 = performance.now(); try { return u0.apply(this, x); } finally { ms.push(performance.now() - t0); } }; }

const track = new Track(trackName), myCls = 'lmdh', theirCls = scene === 'gt3' ? 'gt' : 'lmdh';
const ids = solo ? ['tempest'] : [...Array(nT).fill(rival), 'tempest'];
const teams = ids.map((id, i) => {
  const cls = id === 'tempest' && i === ids.length - 1 ? myCls : theirCls;
  return { id: 'p' + i, name: id + i, short: id.slice(0, 3) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ kind: 'ai', id, name: id + i, short: id.slice(0, 3) }], grid: i };
});
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 20, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed, weather: 'clear', ...(shim ? { makeBridge: (seats = new AsyncSeats(trackName)).factory() } : {}) });
var seats;
if (shim) { const ready = seats.start(race); await shim.settle(); await ready; }
race.start();
if (race.formation) race.formation.slot = (i) => ({ row: i, lat: 0 });
for (const c of race.cars) race.fitTyres(c, 'hard', true);
for (const e of race.entries) e.strategist.decide = () => null;
const step = () => { race.step(FIXED_DT); shim?.step(); };
step();
const ti = ids.length - 1, me = race.cars[ti];
const td = shim ? made[0] : race.entries[ti].bridges[0].driver;
Object.assign(td.options, opts); td.forceRefresh = true;
for (let q = 0; q < ti; q++) { const d = race.entries[q].bridges[0].driver; if (d?.options) { Object.assign(d.options, rivalOpts); if (rivalOpts.margin != null && d.baseMargin !== undefined) d.baseMargin = rivalOpts.margin; d.forceRefresh = true; } }
const L = track.length, wrap = (x) => ((x + L * 1.5) % L) - L / 2, prog = (c) => c.race.progress ?? (c.race.lap * L + c.s);
const book = race.cars.slice(0, ti).map((c) => ({ id: c.id, t0: null, t1: null, dev: 0, off: 0, edge: 0, stuck: 0, states: {} }));
let greenT = null, edgeAll = 0, offAll = 0, k = 0, msGreen = 0;
const hw = track.halfWidth, trace = args.includes('--trace');
while (race.time < T && race.phase !== 'finished') {
  globalThis.__arm?.(race.time);
  step();
  if (race.formation) continue;
  if (greenT === null) { greenT = race.time; msGreen = ms.length; }
  const lat = track.nearest(me.x, me.z).lateral, cl = td.line.closest(me.x, me.z, td.cursor ?? -1), dev = Math.sqrt(cl.d2);
  const edge = Math.abs(lat) > hw - 1.3;
  if (edge) edgeAll += FIXED_DT; if (dev > 2.5) offAll += FIXED_DT;
  for (let q = 0; q < ti; q++) {
    const b = book[q], c = race.cars[q], g = prog(c) - prog(me);
    if (b.t1 !== null) continue;
    if (b.t0 === null && g < 40 && g > 0) b.t0 = race.time;
    if (b.t0 === null) continue;
    b.dev = Math.max(b.dev, dev); if (dev > 2.5) b.off += FIXED_DT; if (edge) b.edge += FIXED_DT;
    if (g > 0 && g < 25) b.stuck += FIXED_DT;
    const st = td.arbiter.state; b.states[st] = (b.states[st] ?? 0) + FIXED_DT;
    if (g < -9.5) b.t1 = race.time;
  }
  if (trace && ++k % 12 === 0) {
    const near = race.cars.slice(0, ti).map((c) => prog(c) - prog(me)).filter((g) => g > -10 && g < 60).map((g) => g.toFixed(0)).join(',');
    console.log(`${race.time.toFixed(1)} v ${me.speed.toFixed(1)} lat ${lat.toFixed(1)} dev ${dev.toFixed(1)} ${td.arbiter.state} ${td.sub} | gaps ${near} | ${(td.arbiter.lastEvs ?? []).map((e, q) => { const c = td.arbiter.cands[q]; return `${c.kind}${c.chosen ? '*' : ''} ${e.score.toFixed(1)}=t${e.t.toFixed(1)}+c${e.contact.toFixed(1)}${e.heavy ? 'h' + e.heavy.toFixed(1) : ''}${e.passes ? ' p' + e.passes : ''} dev${e.maxDev.toFixed(1)}`; }).join(' / ')}`);
  }
}
const f = (x, n = 1) => (x == null ? '-' : x.toFixed(n)), msG = ms.slice(msGreen).sort((a, b) => a - b), B = td.arbiter.books();
console.log(`[${path}${shim ? ` +${lagFrames}` : ''}] ${trackName} ${scene} n${nT} ${rival} ${JSON.stringify(rivalOpts)} TEMPEST ${JSON.stringify(opts)} seed ${seed} ${T}s`);
console.log(`progress after green ${f(prog(me) - (greenT ? 0 : 0))} m (${f(prog(me), 0)}) · damage ${f(me.damage * 100)}% · contacts ${race.contacts} · edge ${f(edgeAll)}s · >2.5 m off line ${f(offAll)}s`);
console.log(`update ms p50 ${f(msG[Math.floor(msG.length / 2)], 2)} p99 ${f(msG[Math.floor(msG.length * 0.99)], 2)} max ${f(msG.at(-1), 1)} · plan meanMs ${B.meanMs} maxMs ${B.maxMs} plans ${B.plans} changes ${B.changes} kept ${B.kept}`);
for (const b of book) console.log(`  car ${b.id}: closed ${f(b.t0)} cleared ${f(b.t1)} took ${b.t1 != null && b.t0 != null ? f(b.t1 - b.t0) : 'NOT CLEARED'} s · stuck<25m ${f(b.stuck)} s · max off line ${f(b.dev)} m · >2.5 m ${f(b.off)} s · edge ${f(b.edge)} s · ${Object.entries(b.states).map(([s, x]) => `${s} ${x.toFixed(1)}`).join(' ')}`);
const done = book.filter((b) => b.t1 != null);
console.log(`SUMMARY cleared ${done.length}/${book.length} · mean take ${f(done.reduce((a, b) => a + b.t1 - b.t0, 0) / Math.max(1, done.length))} s · stuck ${f(book.reduce((a, b) => a + b.stuck, 0))} s · progress ${f(prog(me), 0)} m`);
if (shim) shim.close?.();
process.exit(0);
