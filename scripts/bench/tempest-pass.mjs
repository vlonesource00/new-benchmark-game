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
const path = flag('path', 'native'), frameSteps = Number(flag('frameSteps', 2)), lagFrames = Number(flag('lagFrames', 0)), lagJitter = Number(flag('lagJitter', 0)), frameJitter = Number(flag('frameJitter', 0));
const shim = path === 'worker' ? installWorkerShim({ frameSteps, lagFrames, lagJitter, frameJitter, seed }) : null;
const { AsyncSeats } = shim ? await import('../../game/core/async-seats.js') : {};
// every driver instance, wherever it runs (on the worker path they live inside the worker module)
const made = [];
// planner latency: wall time of each TEMPEST update (reported only; nothing decides on it)
const upd = [], u0 = TempestDriver.prototype.update;
// the game bridge swallows a driver exception (counts it, drives on): report every one, and the first in full
const thrown = { n: 0, first: null };
TempestDriver.prototype.update = function (...x) { const t0 = performance.now(); try { return u0.apply(this, x); } catch (e) { thrown.n++; thrown.first ??= String(e?.stack ?? e); throw e; } finally { upd.push(performance.now() - t0); } };
for (const C of [TempestDriver, ApexDriver]) { const r0 = C.prototype.reset; C.prototype.reset = function (...x) { if (!made.includes(this)) made.push(this); return r0.apply(this, x); }; }
// --rival none: TEMPEST alone (exits and pace without traffic); the rival's numbers then read NaN
const solo = rival === 'none';
const track = new Track(trackName), ids = solo ? ['tempest'] : ahead === 'rival' ? [rival, 'tempest'] : ['tempest', rival];
const teams = ids.map((id, i) => ({ id: 'p' + i, name: id + i, short: id.slice(0, 3) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3) }], grid: i }));
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 20, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed, weather: 'clear', ...(shim ? { makeBridge: (seats = new AsyncSeats(trackName)).factory() } : {}) });
var seats;
if (shim) { const ready = seats.start(race); await shim.settle(); await ready; if (seats.hosts.some((h) => h?.failed)) throw new Error('seat worker failed'); }
race.start();
for (const c of race.cars) race.fitTyres(c, 'hard', true);
for (const e of race.entries) e.strategist.decide = () => null;
const ti = ids.indexOf('tempest'), ri = 1 - ti;
let ghostArmed = false;
const step = () => { race.step(FIXED_DT); ghostArmed = false; shim?.step(); };
// options go in after the drivers' prepare(): per-class config would overwrite anything set before it
step();
const td = shim ? made.find((x) => x instanceof TempestDriver) : race.entries[ti].bridges[0].driver;
const rd = solo ? null : shim ? made.find((x) => !(x instanceof TempestDriver)) ?? null : race.entries[ri].bridges[0].driver;
if (!td) throw new Error('no TEMPEST driver found');
if (shim && seats.hosts.some((h) => h?.failed)) throw new Error('seat worker failed');
Object.assign(td.options, opts); td.forceRefresh = true;
if (rd?.options) { Object.assign(rd.options, rivalOpts); rd.forceRefresh = true; }
for (const [who, d, o] of [['tempest', td, opts], ...(solo ? [] : [[rival, rd, rivalOpts]])]) for (const [key, val] of Object.entries(o))
  if (JSON.stringify(d?.options?.[key]) !== JSON.stringify(val)) throw new Error(`${who} option ${key} did not take: ${JSON.stringify(d?.options?.[key])}`); if (rival === 'next-racer' && rd?.o) rd.o.planBudgetMs = Infinity;
const me = race.cars[ti], him = solo ? { id: -1, speed: NaN, damage: NaN, hybrid: null, race: { progress: NaN } } : race.cars[ri];
// --ghost t0,t1: a matched counterfactual. TEMPEST and the rival do not collide inside that window (the race sets ghost every
// step; this holds it on), everything else identical
const ghostW = flag('ghost', '').split(',').filter(Boolean).map(Number);
// only from where the race sets ghost (just before it resolves collisions) to the end of the step: the drivers drop
// cars that are both ghosts from their perception, so they must not see it
if (ghostW.length === 2) for (const c of [me, him]) { let g = c.ghost; Object.defineProperty(c, 'ghost', { get: () => g || (ghostArmed && race.time >= ghostW[0] && race.time < ghostW[1]), set: (v) => { g = v; ghostArmed = true; }, configurable: true }); }
// handoff check: what the controller receives against the plan that was scored. geometry: the path is the chosen lane
// (or the line when the plan stays on it); lane: the chosen lane's speeds in its window are still the ones it was built
// with; demand: the profile the controller drives (braking envelope or speed profile) is the one the rollout scored;
// cap: the committed plan's cap reaches the controller. Mismatches after the label changed are counted apart
const hand = { n: 0, relabel: 0, geometry: 0, lane: 0, demand: 0, demandRelabel: 0, cap: 0 };
let handPlan = -1, handState = '', handSum = 0;
const laneSum = (l, i0, n) => { let x = 0; for (let j = 0; j <= n; j++) x += l.v[td.line.idx(i0 + j)] * (j + 1); return x; };
{
  const ctl = td.control, step0 = ctl.step;
  ctl.step = function (real, car, path, c, dt, ctx) {
    const a = td.arbiter, b = a.chosen, plan = a.plan;
    if (b && plan && td.options.combat !== false) {
      if (a.planT !== handPlan) { handPlan = a.planT; handState = a.state; handSum = a.path ? laneSum(a.path, b.i0, b.n) : 0; }
      hand.n++; const relabel = a.state !== handState; if (relabel) hand.relabel++;
      if (path !== (a.path ?? td.line)) hand.geometry++;
      if (a.path && laneSum(a.path, b.i0, b.n) !== handSum) hand.lane++;
      const used = ctx.freeThrust || (car.aero?.wake ?? 0) > 0.05 ? 'vbrk' : 'v';
      if (b.prof && used !== b.prof) { hand.demand++; if (relabel) hand.demandRelabel++; }
      if (ctx.cap !== plan.capAt(td.field.me.s + car.speed * 0.1)) hand.cap++;
    }
    return step0.call(this, real, car, path, c, dt, ctx);
  };
}

const rows = [], limits = {}, attackLimits = {}; let k = 0, gov = 0, govN = 0, lastPlan = -1;
// forecast check: at each decision, where the planner's forecast puts the rival 1.5 s and 3 s later (road metres from
// our position at the decision), against where it then is; positive error = the rival got further than forecast
const FSPAN = SPAN, claims = { n: 0, beyond: 0, tH: [] };
const fc = [], fcErr = { 1.5: [], 3: [] }, wrapL = (x) => ((x + track.length * 1.5) % track.length) - track.length / 2;
const laps = [], hisLaps = []; let lapAt = null, lapN = me.race.lap, hisAt = null, hisN = him.race?.lap;
const NSEC = 24, secLen = track.length / NSEC, secs = []; let sec = null;
const refPath = flag('ref', ''), savePath = flag('saveRef', ''), ref = refPath ? JSON.parse((await import('node:fs')).readFileSync(refPath, 'utf8')) : null;
const trk = { n: 0, e2: 0, eMax: 0, beta: 0, off: 0, rev: 0, dir: 1, ext: 0, bMax: 0 };
// the same, only while braking (pedal > 0.2) in wake (> 0.15): where one frame of reply lag made the steering oscillate
const bw = { n: 0, e2: 0, eMax: 0, rev: 0, dir: 1, ext: 0, beta: 0 };
const cut = { cause: 'spin', all: {}, exit: {}, overlap: 0, overlapExit: 0, exitT: 0, exitWake: 0 };
while (race.time < T && race.phase !== 'finished') {
  step();
  if (me.race.lap !== lapN) { if (lapAt !== null) laps.push(race.time - lapAt); else laps.first = race.time; lapAt = race.time; lapN = me.race.lap; }
  if (!solo && him.race.lap !== hisN) { if (hisAt !== null) hisLaps.push(race.time - hisAt); else hisLaps.first = race.time; hisAt = race.time; hisN = him.race.lap; }
  if (!race.formation) {
    const k = Math.floor((((me.s % track.length) + track.length) % track.length) / secLen);
    if (!sec || sec.k !== k) { if (sec && k === (sec.k + 1) % NSEC && sec.full) secs.push({ k: sec.k, t: race.time - sec.t0, wake: sec.wake / sec.n, off: sec.off / sec.n, lap: sec.lap }); sec = { k, t0: race.time, n: 0, wake: 0, off: 0, full: sec !== null, lap: me.race.lap }; }
    sec.n++; sec.wake += me.aero?.wake ?? 0; sec.off += Math.abs(Math.sqrt(td.line.closest(me.x, me.z, td.cursor ?? -1).d2 ?? 0));
  }
  if (race.formation || !td.field?.me) continue;
  // throttle taken per layer (pedal-seconds), whole run and on corner exits (the controller asks for throttle >= 0.5
  // while still cornering, |ay| > 4). A traction cut is put down to what last tripped the governor (combined slip over
  // its limit): wheelspin, lateral slip, or both. Overlap: time two or more of traction/slip/stability cut together
  {
    const w = td.control.why ?? {}, sl = w.slip, cuts = w.cuts ?? {}, exit = (td.control.raw?.throttle ?? 0) >= 0.5 && Math.abs(me.ay ?? 0) > 4;
    if (sl && sl.comb > sl.limit) cut.cause = sl.spin > 0.8 * sl.comb ? 'spin' : sl.lat > 0.8 * sl.comb ? 'lat' : 'both';
    for (const [k, x] of Object.entries(cuts)) {
      const key = k === 'traction' ? 'traction:' + cut.cause : k;
      cut.all[key] = (cut.all[key] ?? 0) + x * FIXED_DT; if (exit) cut.exit[key] = (cut.exit[key] ?? 0) + x * FIXED_DT;
    }
    const many = ['traction', 'slip', 'stability'].filter((k) => (cuts[k] ?? 0) > 0.02).length;
    if (many >= 2) { cut.overlap += FIXED_DT; if (exit) cut.overlapExit += FIXED_DT; }
    if (exit) { cut.exitT += FIXED_DT; if ((me.aero?.wake ?? 0) > 0.05) cut.exitWake += FIXED_DT; }
  }
  // tracking quality, every physics step: distance to the path being driven, steering reversals (a swing of more
  // than 0.2 back the other way), time off the asphalt, sideslip
  let pathErr = NaN;
  {
    const pth = td.path ?? td.line, cl = pth.closest(me.x, me.z, td.c?.i ?? -1), sg = me.controls.steer ?? 0, tn = track.nearest(me.x, me.z);
    pathErr = Math.sqrt(cl.d2); trk.n++; trk.e2 += cl.d2; trk.eMax = Math.max(trk.eMax, Math.sqrt(cl.d2));
    trk.beta += Math.abs(Math.atan2(me.v ?? 0, Math.max(2, me.u ?? me.speed)));
    if (track.zoneAt(tn.lateral) !== 'asphalt') trk.off += FIXED_DT;
    const bt = Math.abs(Math.atan2(me.v ?? 0, Math.max(2, me.u ?? me.speed))); trk.bMax = Math.max(trk.bMax, bt);
    if ((me.controls.brake ?? 0) > 0.2 && (me.aero?.wake ?? 0) > 0.15) {
      bw.n++; bw.e2 += cl.d2; bw.eMax = Math.max(bw.eMax, Math.sqrt(cl.d2)); bw.beta = Math.max(bw.beta, bt);
      if (bw.dir * (sg - bw.ext) < -0.2) { bw.rev++; bw.dir = -bw.dir; bw.ext = sg; } else if (bw.dir * (sg - bw.ext) > 0) bw.ext = sg;
    }
    if (trk.dir * (sg - trk.ext) < -0.2) { trk.rev++; trk.dir = -trk.dir; trk.ext = sg; } else if (trk.dir * (sg - trk.ext) > 0) trk.ext = sg;
  }
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
  rows.push({ e: pathErr, guard: ctl.guard, t: race.time, st: a.state, age: race.time - a.planT, ds: r?.ds, dd: r ? r.d - td.field.me.d : NaN, v: me.speed, vr: him.speed, vt: ctl.targetSpeed,
    src: why.src, cap: why.cap, cut: why.cut, rt: req.throttle, rb: req.brake, st2: sent.throttle, sb: sent.brake, xt: ex.throttle, xb: ex.brake, steer: ex.steer, yr: me.yawRate, stab: ctl.stability, beta: Math.atan2(me.v, Math.max(2, me.u)), pred: p ? p.err : null, wake: me.aero?.wake ?? 0,
    hy: `${me.hybrid?.mode?.[0] ?? '-'}${him.hybrid?.mode?.[0] ?? '-'}`, lim: `${why.cap}/${why.cut}`,
    all: [...Object.entries(why.caps ?? {}).map(([n, x]) => `${n}-${x.toFixed(1)}`), ...Object.entries(why.cuts ?? {}).map(([n, x]) => `${n}-${x.toFixed(2)}`)].join(' '),
    slip: why.slip ? `${why.slip.spin.toFixed(2)}/${why.slip.lat.toFixed(2)}/${why.slip.limit.toFixed(2)}` : '' });
  // executed against sent: anything the game changed after the driver wrote its controls
  govN++; if (Math.abs((sent.throttle ?? 0) - ex.throttle) > 0.02 || Math.abs((sent.brake ?? 0) - ex.brake) > 0.02) gov++;
}
const O = td.arbiter.outcomes, B = O.books(), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '  -');
console.log(`[${path}${shim ? ` ${frameSteps} steps/frame, +${lagFrames} frames${lagJitter || frameJitter ? ` (+0..${lagJitter} per reply, long frames ${frameJitter})` : ''}` : ''}] ${trackName} ${cls} TEMPEST ${JSON.stringify(opts)} behind ${rival} ${JSON.stringify(rivalOpts)} (effective, checked after prepare) seed ${seed}, ${race.time.toFixed(0)} s`);
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
if (thrown.n) console.log(`TEMPEST threw ${thrown.n} times; first: ${thrown.first}`);
if (upd.length > 200) { const u = upd.slice(200).sort((x, y) => x - y), pq = (f) => u[Math.min(u.length - 1, Math.floor(u.length * f))].toFixed(2);
  console.log(`TEMPEST update wall time (ms, this machine): n ${u.length} mean ${(u.reduce((x, y) => x + y, 0) / u.length).toFixed(2)} p50 ${pq(0.5)} p90 ${pq(0.9)} p99 ${pq(0.99)} max ${u.at(-1).toFixed(1)}; over 16.7 ms ${u.filter((x) => x > 16.7).length}`); }
const ord = race.order();
if (savePath) { const best = Array(NSEC).fill(Infinity); for (const x of secs) best[x.k] = Math.min(best[x.k], x.t); (await import('node:fs')).writeFileSync(savePath, JSON.stringify(best)); console.log(`reference written: ${savePath}`); }
if (ref) {
  const by = Array.from({ length: NSEC }, () => ({ n: 0, loss: 0, wake: 0, off: 0 }));
  for (const x of secs) if (Number.isFinite(ref[x.k])) { const b = by[x.k]; b.n++; b.loss += x.t - ref[x.k]; b.wake += x.wake; b.off += x.off; }
  const tot = by.reduce((a, b) => a + b.loss, 0), inWake = secs.reduce((a, x) => a + (x.wake > 0.1 && Number.isFinite(ref[x.k]) ? x.t - ref[x.k] : 0), 0);
  console.log(`time lost against the solo reference: ${tot.toFixed(2)} s over ${secs.length} sectors, ${inWake.toFixed(2)} s of it in sectors run in wake (> 0.1)`);
  console.log('  worst sectors (k: loss s over n crossings, mean wake, mean metres off the line): ' + by.map((b, k) => ({ k, ...b })).filter((b) => b.n).sort((a, b) => b.loss - a.loss).slice(0, 6).map((b) => `${b.k}: ${b.loss.toFixed(2)}/${b.n} wake ${(b.wake / b.n).toFixed(2)} off ${(b.off / b.n).toFixed(1)}`).join(' | '));
}
console.log(`laps (s): ${laps.map((x) => x.toFixed(2)).join(' ') || 'none complete'} (first line ${laps.first?.toFixed(2) ?? 'not reached'})${solo ? '' : ` | rival (first line ${hisLaps.first?.toFixed(2) ?? 'not reached'}) ${hisLaps.map((x) => x.toFixed(2)).join(' ')}`}`);
// every departure from the path (error past 3 m after under 1.5 m), one line each: the conditions over the second
// before it (peak sideslip, wake, brake, speed), the plan's age at onset, and the peak error over the next 3 s
{
  let armed = false;   // armed once the car is on its path: the rolling start leaves it on its grid slot
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (r.e < 1.5) armed = true;
    if (!(armed && r.e > 3)) continue;
    armed = false;
    let beta = 0, wake = 0, brake = 0, peak = 0, rev = 0, dir = 0, ext = 0;
    for (let j = k; j >= 0 && rows[j].t > r.t - 1; j--) { const x = rows[j]; beta = Math.max(beta, Math.abs(x.beta)); wake = Math.max(wake, x.wake); brake = Math.max(brake, x.xb ?? 0); }
    for (let j = k; j < rows.length && rows[j].t < r.t + 3; j++) peak = Math.max(peak, rows[j].e);
    for (let j = k; j >= 0 && rows[j].t > r.t - 1.5; j--) { const sg = rows[j].steer ?? 0; if (dir * (sg - ext) < -0.2) { rev++; dir = -dir; ext = sg; } else if (!dir) { dir = 1; ext = sg; } else if (dir * (sg - ext) > 0) ext = sg; }
    console.log(`onset ${r.t.toFixed(2)} st ${r.st} v ${r.v.toFixed(1)} beta ${beta.toFixed(3)} wake ${wake.toFixed(2)} brake ${brake.toFixed(2)} planAge ${(r.age ?? NaN).toFixed(2)} rev1.5 ${rev} peak ${peak.toFixed(1)} ds ${(r.ds ?? NaN).toFixed(1)}`);
  }
}
// --excursions: every departure from the path (error past 3 m after under 1.5 m), the 2 s before it and 1 s after
if (args.includes('--excursions')) {
  let armed = false, last = -Infinity;
  for (const r of rows) {
    if (r.e < 1.5) armed = true;
    if (!(armed && r.e > 3)) continue;
    armed = false; console.log(`excursion at ${r.t.toFixed(2)} s:`);
    console.log('      t st         e m     v brake  thr  wake  steer  yaw r   beta stab g     ds    dd');
    for (const x of rows) {
      if (x.t <= r.t - 2 || x.t >= r.t + 1 || x.t - last < 0.099) continue;
      last = x.t;
      console.log(`  ${x.t.toFixed(1).padStart(5)} ${String(x.st).padEnd(9)} ${x.e.toFixed(1).padStart(4)} ${x.v.toFixed(1).padStart(5)} ${(x.xb ?? 0).toFixed(2)} ${(x.xt ?? 0).toFixed(2)} ${x.wake.toFixed(2)} ${(x.steer ?? 0).toFixed(3).padStart(6)} ${x.yr.toFixed(3).padStart(6)} ${x.beta.toFixed(3).padStart(6)} ${(x.stab ?? 1).toFixed(2)} ${x.guard ? 'G' : '.'} ${(x.ds ?? NaN).toFixed(1).padStart(6)} ${(x.dd ?? NaN).toFixed(1).padStart(5)}`);
    }
  }
}
console.log(`braking in wake: ${(bw.n * FIXED_DT).toFixed(1)} s, path error rms ${Math.sqrt(bw.e2 / Math.max(1, bw.n)).toFixed(2)} m, max ${bw.eMax.toFixed(1)} m, steering reversals ${(bw.rev / Math.max(1e-9, bw.n * FIXED_DT)).toFixed(2)}/s, max |sideslip| ${bw.beta.toFixed(3)} rad`);
console.log(`max |sideslip| ${trk.bMax.toFixed(3)} rad`);
console.log(`tracking: path error rms ${Math.sqrt(trk.e2 / Math.max(1, trk.n)).toFixed(2)} m, max ${trk.eMax.toFixed(1)} m, off the asphalt ${trk.off.toFixed(1)} s, steering reversals ${(trk.rev / Math.max(1e-9, trk.n * FIXED_DT)).toFixed(2)}/s, mean |sideslip| ${(trk.beta / Math.max(1, trk.n)).toFixed(3)} rad`);
{ const f = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
  console.log(`throttle cuts (pedal-s), whole run: ${f(cut.all)}`);
  console.log(`  on exits (${cut.exitT.toFixed(1)} s, ${cut.exitWake.toFixed(1)} s of it in wake): ${f(cut.exit)}`);
  console.log(`  two or more of traction/slip/stability at once: ${cut.overlap.toFixed(1)} s (${cut.overlapExit.toFixed(1)} s on exits)`); }
console.log(`handoff (controller steps under a committed plan): ${JSON.stringify(hand)}`);
console.log(`\nat ${race.time.toFixed(0)} s: TEMPEST P${ord.indexOf(me) + 1}, gap ${(me.race.progress - him.race.progress).toFixed(1)} m, contacts ${race.contacts}, damage ${(me.damage * 100).toFixed(1)}/${(him.damage * 100).toFixed(1)} %, pedals changed by the game after the driver ${gov}/${govN} rows`);
if (args.includes('--timeline')) {
  // --timeline N: N rows a second (1 by default, 10 for every trace row), from --from when given
  const per = Math.min(10, Number(flag('timeline', 1)) || 1), t0 = args.includes('--from') ? from : 0;
  console.log(`\ntimeline (${per}/s):    t  state   gap  side    v    vR  source/cap/cut              wake  hy   steer  yaw/s   beta  stab`);
  let sec = -1; for (const r of rows) if (r.t >= t0 && Math.floor(r.t * per + 1e-6) > sec && (sec = Math.floor(r.t * per + 1e-6)) >= 0) console.log(`  ${r.t.toFixed(1).padStart(6)} ${r.st.padEnd(6)} ${f1(r.ds).padStart(5)} ${f1(r.dd).padStart(5)} ${r.v.toFixed(1).padStart(5)} ${r.vr.toFixed(1).padStart(5)}  ${`${r.src}/${r.lim}`.padEnd(28)} ${r.wake.toFixed(2)}  ${r.hy}  ${r.steer.toFixed(3).padStart(6)} ${r.yr.toFixed(3).padStart(6)} ${r.beta.toFixed(3).padStart(6)} ${(r.stab ?? 1).toFixed(2)}`);
}
