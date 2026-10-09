// Pass fixture: TEMPEST starts behind one rival (rolling start, same class) and the run books every attack by body
// clearance (subjects/tempest/src/outcomes.js): declared, started (moved toward a corridor), overlap reached,
// completed (our rear clear of its nose), retained (clear through the whole retain interval), or failed with its reason. For each attack it prints the replay trace: plan age, the rival's
// gap and offset, the target speed and what set it (profile source, speed cap, the layer that cut the throttle), the
// pedals TEMPEST asked for against what the car executed, the 1.5 s arrival predictions as they settle, the rival
// forecast error at 1.5 and 3 s, and when each pass the chosen plan claims would resolve against the forecast span.
// Options are applied after the drivers prepare (per-class config would overwrite them) and echoed back.
// --path native steps the drivers inside race.step; --path worker runs every AI seat through the game's own seat path
// (async-seats posting to seat-worker, as the browser does), with replies held to frame boundaries
// (scripts/bench/lockstep-workers.mjs): the car drives on the last controls it received.
// usage: node --import ./scripts/json-loader.mjs scripts/bench/tempest-pass.mjs [--track harbor-ring] [--cls lmdh]
//        [--rival apex] [--rivalOpts '{"margin":0.94}'] [--opts '{}'] [--time 120] [--seed 7] [--ahead tempest]
//        [--trace failed|all|none] [--from 25] [--timeline] [--path native|worker] [--frameSteps 2] [--lagFrames 0]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
import { at, FSPAN as SPAN } from '../../subjects/tempest/src/forecast.js';
import { TempestDriver } from '../../subjects/tempest/src/driver.js';
import { ApexDriver } from '../../subjects/apex/src/driver.js';
import { installWorkerShim } from './lockstep-workers.mjs';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const trackName = flag('track', 'harbor-ring'), cls = flag('cls', 'lmdh'), rival = flag('rival', 'apex'), seed = Number(flag('seed', 7));
const rivalOpts = JSON.parse(flag('rivalOpts', '{"margin":0.94}')), opts = JSON.parse(flag('opts', '{}')), T = Number(flag('time', 120));
const ahead = flag('ahead', 'rival'), traceMode = flag('trace', 'failed'), from = Number(flag('from', 25));
const path = flag('path', 'native'), frameSteps = Number(flag('frameSteps', 2)), lagFrames = Number(flag('lagFrames', 0));
const shim = path === 'worker' ? installWorkerShim({ frameSteps, lagFrames }) : null;
const { AsyncSeats } = shim ? await import('../../game/core/async-seats.js') : {};
// every driver instance, wherever it runs (on the worker path they live inside the worker module)
const made = [];
// planner latency: wall time of each TEMPEST update (reported only; nothing decides on it)
const upd = [], u0 = TempestDriver.prototype.update;
TempestDriver.prototype.update = function (...x) { const t0 = performance.now(); const r = u0.apply(this, x); upd.push(performance.now() - t0); return r; };
for (const C of [TempestDriver, ApexDriver]) { const r0 = C.prototype.reset; C.prototype.reset = function (...x) { if (!made.includes(this)) made.push(this); return r0.apply(this, x); }; }
const track = new Track(trackName), ids = ahead === 'rival' ? [rival, 'tempest'] : ['tempest', rival];
const teams = ids.map((id, i) => ({ id: 'p' + i, name: id + i, short: id.slice(0, 3) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3) }], grid: i }));
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 20, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed, weather: 'clear', ...(shim ? { makeBridge: (seats = new AsyncSeats(trackName)).factory() } : {}) });
var seats;
if (shim) { const ready = seats.start(race); await shim.settle(); await ready; if (seats.hosts.some((h) => h?.failed)) throw new Error('seat worker failed'); }
race.start();
for (const c of race.cars) race.fitTyres(c, 'hard', true);
for (const e of race.entries) e.strategist.decide = () => null;
const ti = ids.indexOf('tempest'), ri = 1 - ti;
const step = () => { race.step(FIXED_DT); shim?.step(); };
// options go in after the drivers' prepare(): per-class config would overwrite anything set before it
step();
const td = shim ? made.find((x) => x instanceof TempestDriver) : race.entries[ti].bridges[0].driver;
const rd = shim ? made.find((x) => !(x instanceof TempestDriver)) ?? null : race.entries[ri].bridges[0].driver;
if (!td) throw new Error('no TEMPEST driver found');
if (shim && seats.hosts.some((h) => h?.failed)) throw new Error('seat worker failed');
Object.assign(td.options, opts); td.forceRefresh = true;
if (rd?.options) { Object.assign(rd.options, rivalOpts); rd.forceRefresh = true; }
for (const [who, d, o] of [['tempest', td, opts], [rival, rd, rivalOpts]]) for (const [key, val] of Object.entries(o))
  if (JSON.stringify(d?.options?.[key]) !== JSON.stringify(val)) throw new Error(`${who} option ${key} did not take: ${JSON.stringify(d?.options?.[key])}`); if (rival === 'next-racer' && rd?.o) rd.o.planBudgetMs = Infinity;
const me = race.cars[ti], him = race.cars[ri];

const rows = [], limits = {}, attackLimits = {}; let k = 0, gov = 0, govN = 0, lastPlan = -1;
// forecast check: at each decision, where the planner's forecast puts the rival 1.5 s and 3 s later (road metres from
// our position at the decision), against where it then is; positive error = the rival got further than forecast
const FSPAN = SPAN, claims = { n: 0, beyond: 0, tH: [] };
const fc = [], fcErr = { 1.5: [], 3: [] }, wrapL = (x) => ((x + track.length * 1.5) % track.length) - track.length / 2;
while (race.time < T && race.phase !== 'finished') {
  step();
  if (race.formation || !td.field?.me) continue;
  const ctl = td.control, a = td.arbiter, why = ctl.why ?? {}, req = ctl.raw ?? {}, sent = ctl.sent ?? {}, ex = me.controls;
  const key = `${why.cap}/${why.cut}`; limits[key] = (limits[key] ?? 0) + FIXED_DT;
  if (a.state === 'ATTACK') attackLimits[key] = (attackLimits[key] ?? 0) + FIXED_DT;
  if (a.planT > lastPlan) {
    lastPlan = a.planT; const f = td.forecast.cache.get(him.id), b = a.chosen;
    // a pass claimed by the chosen plan, and when (tH: our arrival at the horizon) against the forecast's span
    if (b?.passes > 0) { claims.n++; if (b.tH > FSPAN) claims.beyond++; claims.tH.push(b.tH); }
    if (f) for (const h of [1.5, 3]) fc.push({ h, due: a.planT + h, s0: td.field.me.s, pred: at(f.ds, h), st: a.state });
  }
  for (let q = fc.length - 1; q >= 0; q--) if (race.time >= fc[q].due) {
    const e = fc.splice(q, 1)[0], r = td.field.byId.get(him.id);
    if (r) fcErr[e.h].push({ err: wrapL(r.s - e.s0) - e.pred, st: e.st });
  }
  if (++k % 6) continue;   // 0.1 s rows
  const r = td.field.byId.get(him.id), p = a.lastPred && a.lastPred.t > race.time - 0.1 ? a.lastPred : null;
  rows.push({ t: race.time, st: a.state, age: race.time - a.planT, ds: r?.ds, dd: r ? r.d - td.field.me.d : NaN, v: me.speed, vr: him.speed, vt: ctl.targetSpeed,
    src: why.src, cap: why.cap, cut: why.cut, rt: req.throttle, rb: req.brake, st2: sent.throttle, sb: sent.brake, xt: ex.throttle, xb: ex.brake, steer: ex.steer, yr: me.yawRate, stab: ctl.stability, beta: Math.atan2(me.v, Math.max(2, me.u)), pred: p ? p.err : null, wake: me.aero?.wake ?? 0,
    hy: `${me.hybrid?.mode?.[0] ?? '-'}${him.hybrid?.mode?.[0] ?? '-'}`, lim: `${why.cap}/${why.cut}`,
    all: [...Object.entries(why.caps ?? {}).map(([n, x]) => `${n}-${x.toFixed(1)}`), ...Object.entries(why.cuts ?? {}).map(([n, x]) => `${n}-${x.toFixed(2)}`)].join(' '),
    slip: why.slip ? `${why.slip.spin.toFixed(2)}/${why.slip.lat.toFixed(2)}/${why.slip.limit.toFixed(2)}` : '' });
  // executed against sent: anything the game changed after the driver wrote its controls
  govN++; if (Math.abs((sent.throttle ?? 0) - ex.throttle) > 0.02 || Math.abs((sent.brake ?? 0) - ex.brake) > 0.02) gov++;
}
const O = td.arbiter.outcomes, B = O.books(), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '  -');
console.log(`[${path}${shim ? ` ${frameSteps} steps/frame, +${lagFrames} frames` : ''}] ${trackName} ${cls} TEMPEST ${JSON.stringify(opts)} behind ${rival} ${JSON.stringify(rivalOpts)} (effective, checked after prepare) seed ${seed}, ${race.time.toFixed(0)} s`);
console.log('outcomes', JSON.stringify(B));
console.log('legacy books: attacks', td.arbiter.stats.attacks, 'order-change passes', td.arbiter.stats.passes, 'pred by state', JSON.stringify(td.arbiter.books().predByState));
const top = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([kk, v]) => `${kk} ${v.toFixed(1)}s`).join(', ');
console.log('limits (cap/cut), whole run:', top(limits));
console.log('limits (cap/cut), in ATTACK:', top(attackLimits));
console.log('events', JSON.stringify(O.events));
const stat = (xs) => { const v = xs.map((x) => x.err).sort((p1, p2) => p1 - p2); return v.length ? `n ${v.length} mean ${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(2)} m  p10 ${v[Math.floor(v.length * 0.1)].toFixed(2)}  p50 ${v[Math.floor(v.length / 2)].toFixed(2)}  p90 ${v[Math.floor(v.length * 0.9)].toFixed(2)}` : 'n 0'; };
const tq = claims.tH.sort((x, y) => x - y), q = (f) => (tq.length ? tq[Math.floor(tq.length * f)].toFixed(2) : '-');
console.log(`pass claims by the chosen plan: ${claims.n} decisions, ${claims.beyond} resolved after the ${FSPAN.toFixed(1)} s forecast span (tH p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} s)`);
for (const h of [1.5, 3]) console.log(`rival forecast error at ${h} s (+ = rival further than forecast): all ${stat(fcErr[h])} | in ATTACK ${stat(fcErr[h].filter((x) => x.st === 'ATTACK'))}`);
// one line per declared attack (state windows), then the replay rows of the chosen ones
const atts = []; let open = null;
for (const r of rows) { if (r.st === 'ATTACK' && !open) open = { t0: r.t, rs: [] }; if (open) { if (r.st !== 'ATTACK' && r.t - open.last > 1.5) { atts.push(open); open = null; } else { open.rs.push(r); if (r.st === 'ATTACK') open.last = r.t; } } }
if (open) atts.push(open);
console.log('\nattack windows (ATTACK labels less than 1.5 s apart are one window):  t0-t1  gap start>min>end  side  closing m/s  limits');
for (const w of atts) {
  const g = w.rs.map((r) => r.ds).filter(Number.isFinite), cl = w.rs.map((r) => r.v - r.vr), L = {};
  for (const r of w.rs) L[r.lim] = (L[r.lim] ?? 0) + 1;
  const lim = Object.entries(L).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([kk, n]) => `${kk} ${Math.round(100 * n / w.rs.length)}%`).join(', ');
  console.log(`  ${w.t0.toFixed(1).padStart(6)}-${w.last.toFixed(1).padEnd(6)} ${f1(g[0])}>${f1(Math.min(...g))}>${f1(g.at(-1))}  ${f1(w.rs[0].dd)}  ${(cl.reduce((x, y) => x + y, 0) / cl.length).toFixed(1).padStart(5)}  ${lim}`);
}
const pick = traceMode === 'all' ? atts : traceMode === 'failed' ? atts.filter((w) => w.t0 >= from).slice(0, 1) : [];
for (const w of pick) {
  console.log(`\nATTACK window ${w.t0.toFixed(1)} s     t  state  age  gap  side   v   vR   vt  source/cap/cut                 ask(t/b)  sent(t/b)  car(t/b)  steer wake hy  pred   spin/lat/limit  every constraint (m/s, pedal)`);
  rows.filter((r) => r.t >= w.t0 - 1.5 && r.t <= w.last + 1.5).forEach((r, j) => { if (j % 2) return;
    console.log(`  ${r.t.toFixed(1).padStart(6)} ${r.st.padEnd(6)} ${r.age.toFixed(2)} ${f1(r.ds).padStart(5)} ${f1(r.dd).padStart(5)} ${r.v.toFixed(1).padStart(5)} ${r.vr.toFixed(1).padStart(5)} ${r.vt.toFixed(1).padStart(5)}  ${`${r.src}/${r.lim}`.padEnd(30)} ${(r.rt ?? 0).toFixed(2)}/${(r.rb ?? 0).toFixed(2)}  ${(r.st2 ?? 0).toFixed(2)}/${(r.sb ?? 0).toFixed(2)}   ${r.xt.toFixed(2)}/${r.xb.toFixed(2)}  ${r.steer.toFixed(2).padStart(5)}  ${r.wake.toFixed(2)} ${r.hy}  ${(r.pred == null ? '' : (r.pred >= 0 ? '+' : '') + r.pred.toFixed(2)).padEnd(5)}  ${r.slip.padEnd(14)}  ${r.all}`); });
}
{ const u = upd.slice(200).sort((x, y) => x - y), pq = (f) => u[Math.min(u.length - 1, Math.floor(u.length * f))].toFixed(2);
  console.log(`TEMPEST update wall time (ms, this machine): n ${u.length} mean ${(u.reduce((x, y) => x + y, 0) / u.length).toFixed(2)} p50 ${pq(0.5)} p90 ${pq(0.9)} p99 ${pq(0.99)} max ${u.at(-1).toFixed(1)}; over 16.7 ms ${u.filter((x) => x > 16.7).length}`); }
const ord = race.order();
console.log(`\nat ${race.time.toFixed(0)} s: TEMPEST P${ord.indexOf(me) + 1}, gap ${(me.race.progress - him.race.progress).toFixed(1)} m, contacts ${race.contacts}, damage ${(me.damage * 100).toFixed(1)}/${(him.damage * 100).toFixed(1)} %, pedals changed by the game after the driver ${gov}/${govN} rows`);
if (args.includes('--timeline')) {
  // --timeline N: N rows a second (1 by default, 10 for every trace row), from --from when given
  const per = Math.min(10, Number(flag('timeline', 1)) || 1), t0 = args.includes('--from') ? from : 0;
  console.log(`\ntimeline (${per}/s):    t  state   gap  side    v    vR  source/cap/cut              wake  hy   steer  yaw/s   beta  stab`);
  let sec = -1; for (const r of rows) if (r.t >= t0 && Math.floor(r.t * per + 1e-6) > sec && (sec = Math.floor(r.t * per + 1e-6)) >= 0) console.log(`  ${r.t.toFixed(1).padStart(6)} ${r.st.padEnd(6)} ${f1(r.ds).padStart(5)} ${f1(r.dd).padStart(5)} ${r.v.toFixed(1).padStart(5)} ${r.vr.toFixed(1).padStart(5)}  ${`${r.src}/${r.lim}`.padEnd(28)} ${r.wake.toFixed(2)}  ${r.hy}  ${r.steer.toFixed(3).padStart(6)} ${r.yr.toFixed(3).padStart(6)} ${r.beta.toFixed(3).padStart(6)} ${(r.stab ?? 1).toFixed(2)}`);
}
