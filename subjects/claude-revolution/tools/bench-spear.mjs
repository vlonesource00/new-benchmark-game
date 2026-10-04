// CRV against SPEARHEAD: solo sector splits, or a rolling-start duel with the
// combat diagnostics (spins, braking beside a rival, passes, moves).
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bench-spear.mjs solo <ai> [lmdh|gt] [track] [laps]
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bench-spear.mjs duel <front-ai> <back-ai> [lmdh|gt] [track] [laps]
// Debug env: EV=1 prints every CRV event with the racecraft state. WORKER=1 runs every AI in
// a seat worker as the game does: 60 frames a second, controls one frame late.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import './worker-shim.mjs';

const [mode = 'duel', ...rest] = process.argv.slice(2);
const ids = mode === 'solo' ? [rest.shift() ?? 'claude-revolution'] : [rest.shift() ?? 'next-racer', rest.shift() ?? 'claude-revolution'];
const [cls = 'lmdh', trackName = 'harbor-ring', laps = '3'] = rest;
const track = new Track(trackName), L = track.length;
const name = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const team = (id, i) => ({ id: `t${i}`, name: `${name(id)}${i}`, short: `${name(id)}${i}`, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: name(id) }], grid: i });
const teams = ids.map(team);
const seats = process.env.WORKER ? new AsyncSeats(trackName) : null;
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12, startCompound: 'medium', makeBridge: seats ? seats.factory() : createSeatBridge, startType: 'rolling' });
race.laps = Number(laps);
race.start();
if (seats) await seats.start(race);
const answers = async () => { while (seats.hosts.some((h) => h.seats.some((x) => x.inFlight))) await new Promise((r) => setImmediate(r)); };
let sub = 0;
const cars = race.cars, crvI = ids.indexOf('claude-revolution'), crv = cars[crvI], other = cars[1 - crvI];
if (seats) seats.wantDebug = true;
const dbg = () => { const b = race.entries[crvI]?.bridges[0]; return (seats ? b?.lastDebug : b?.debug?.()) ?? {}; };
const splits = cars.map(() => []);
const ev = { follow: 0, capped: 0, gapSum: 0, close: 0, spin: 0, fear: 0, fearT: 0, alongside: 0, passes: [], states: {} };
let slide = null, order = cars.length > 1 ? Math.sign(cars[0].race.progress - cars[1].race.progress) : 0, spinning = false, fearOn = false;
const wall = Date.now(), dump = { b: -1, rows: [], t0: undefined };
while (race.phase !== 'finished' && race.time < 110 * Number(laps) + 60) {
  race.step(FIXED_DT);
  if (seats && ++sub % 2 === 0) await answers();
  if (race.formation) continue;
  cars.forEach((c, k) => { const r = c.race; if (r.sectors.length > splits[k].length * 0 && r.secCur) splits[k].last = r.secCur.slice(); if (r.sectors.length % 3 === 0 && r.sectors.length && splits[k].n !== r.sectors.length) { splits[k].n = r.sectors.length; splits[k].push([...r.secCur, r.valid]); } });
  if (process.env.DUMP && splits[0].length === 1) { const c = cars[0], b = Math.floor(c.s / 50); if (b !== dump.b) { dump.b = b; dump.rows.push(`${b * 50}:${(race.time - dump.t0 || 0).toFixed(2)}(${c.speed.toFixed(0)})`); dump.t0 ??= race.time; } }
  // STRACE=a-b: lap-2 trace of car 0 between track metres a and b.
  if (process.env.STRACE && splits[0].length === Number(process.env.SLAP ?? 1) && Math.round(race.time * 120) % 12 === 0) {
    const [a, b] = process.env.STRACE.split('-').map(Number), c = cars[0];
    if (c.s > a && c.s < b) { const g = crvI === 0 ? dbg() : {}; console.log(`s${c.s.toFixed(0)} v${c.speed.toFixed(1)} tv${g.targetSpeed?.toFixed(1)} line${g.lineSpeed?.toFixed?.(1)} T${c.controls.throttle.toFixed(2)} B${c.controls.brake.toFixed(2)} S${c.controls.steer.toFixed(2)} stab${g.stability?.toFixed?.(2)} b${Math.atan2(c.v, Math.max(2, c.u)).toFixed(3)} lat${c.lateral.toFixed(1)} tc${c.wheels.map((w) => w.tyre.core.toFixed(0)).join("/")} ${g.lane ?? ""} ${g.intent ?? ''} ${race.entries[0].pit?.phase ?? ''} pt${race.entries[0].pit?.track ? race.entries[0].pit.targetSpeed(c.s, c).toFixed(1) : ''}`); }
  }
  // SLIDE=1: every slide of car 0 past 0.22 rad, with its peak and what the driver was doing.
  if (process.env.SLIDE) { const c = cars[0], b = Math.atan2(c.v, Math.max(2, c.u)); slide ??= null;
    if (Math.abs(b) > 0.22 && c.speed > 8) { const g = crvI === 0 ? dbg() : {}; if (!slide) slide = { lap: c.race.lap, s: c.s, peak: 0 }; if (Math.abs(b) > slide.peak) Object.assign(slide, { peak: Math.abs(b), at: c.s, v: c.speed, T: c.controls.throttle, B: c.controls.brake, S: c.controls.steer, mode: g.intent ?? '', lane: g.lane ?? '' }); }
    else if (slide && Math.abs(b) < 0.1) { console.log(`SLIDE L${slide.lap} s${slide.s.toFixed(0)}-${c.s.toFixed(0)} peak${slide.peak.toFixed(2)}@${slide.at.toFixed(0)} v${slide.v.toFixed(0)} T${slide.T.toFixed(2)} B${slide.B.toFixed(2)} S${slide.S.toFixed(2)} ${slide.mode} ${slide.lane}`); slide = null; } }
  if (!other || crvI < 0) continue;
  const g = dbg();
  const beta = Math.atan2(crv.v, Math.max(2, crv.u));
  if (Math.abs(beta) > 0.3 && crv.speed > 8) { if (!spinning) { ev.spin++; spinning = true; if (process.env.EV) console.log(`SPIN t${race.time.toFixed(1)} s${crv.s.toFixed(0)} β${beta.toFixed(2)} ${g.combat}/${g.lane} ds${(other.race.progress - crv.race.progress).toFixed(1)}`); } } else if (Math.abs(beta) < 0.12) spinning = false;
  const fwd = other.race.progress - crv.race.progress, beside = Math.abs(fwd) < 6 && Math.abs(other.lateral - crv.lateral) < 4.5;
  if (beside) ev.alongside += FIXED_DT;
  // Pursuit: a car ahead within 80 m. Capped = the guard holds us under what our lane would run.
  if (fwd > 6 && fwd < 80) { ev.follow += FIXED_DT; ev.gapSum += fwd * FIXED_DT; if (fwd < 20) ev.close += FIXED_DT; if ((g.cap ?? Infinity) < (g.targetSpeed ?? 0) - 0.5 || (g.cap ?? Infinity) < crv.speed + 0.5) ev.capped += FIXED_DT; }
  if (process.env.TRACE && race.time - (race.greenAt ?? 0) < Number(process.env.TRACE) && Math.round(race.time * 120) % 30 === 0) console.log(`T${(race.time - race.greenAt).toFixed(1)} s${crv.s.toFixed(0)} fwd${fwd.toFixed(1)} v${crv.speed.toFixed(1)}/${other.speed.toFixed(1)} lat${crv.lateral.toFixed(1)}/${other.lateral.toFixed(1)} ${g.combat}/${g.lane} tv${g.targetSpeed?.toFixed(1)} line${g.lineSpeed?.toFixed?.(1)} cap${g.cap?.toFixed?.(1)} rfx${g.reflexCap?.toFixed?.(1)} T${crv.controls.throttle.toFixed(2)} B${crv.controls.brake.toFixed(2)} stab${g.stability?.toFixed?.(2)} wake${(crv.aero?.wake ?? 0).toFixed(2)}${process.env.CANDS ? ` [${g.cands}]` : ""}`);
  // Braking beside a rival where our own line would not brake: fear.
  const lineV = g.lineSpeed ?? 0, fear = beside && crv.controls.brake > 0.15 && lineV > crv.speed + 2;
  if (fear) { ev.fearT += FIXED_DT; if (!fearOn) { ev.fear++; if (process.env.EV) console.log(`FEAR t${race.time.toFixed(1)} s${crv.s.toFixed(0)} fwd${fwd.toFixed(1)} lat${crv.lateral.toFixed(1)}/${other.lateral.toFixed(1)} v${crv.speed.toFixed(1)} line${lineV.toFixed(1)} cap${g.cap?.toFixed?.(1)} rfx${g.reflexCap?.toFixed?.(1)} stab${g.stability?.toFixed?.(2)} ${g.combat}/${g.lane} nudge${g.nudge?.toFixed?.(2)} blk${g.blocker}`); } }
  fearOn = fear;
  if (g.combat) ev.states[g.combat] = (ev.states[g.combat] ?? 0) + FIXED_DT;
  const o = Math.sign(cars[0].race.progress - cars[1].race.progress);
  if (o !== order && Math.abs(cars[0].race.progress - cars[1].race.progress) > 6) { ev.passes.push(`${o > 0 ? name(ids[0]) : name(ids[1])}@L${crv.race.lap}s${crv.s.toFixed(0)}`); order = o; }
}
const fmt = (x) => (x == null ? '  -  ' : x.toFixed(2));
const inc = (e) => race.stewards.of(e).log.map((l) => `${l.kind}@${l.time.toFixed(0)}`).join(',') || '-';
if (mode === 'solo') {
  const s = splits[0].filter((x, k) => k > 0);
  const best = [0, 1, 2].map((k) => Math.min(...s.map((x) => x[k] ?? Infinity)));
  console.log(`${name(ids[0])} ${cls} ${trackName} laps ${s.map((x) => `${(x[0] + x[1] + x[2]).toFixed(2)}${x[3] ? '' : '!'}`).join(' ')} · best sectors ${best.map(fmt).join(' / ')} = ${best.reduce((a, b) => a + b, 0).toFixed(2)} · inc ${inc(race.entries[0])} · ${((Date.now() - wall) / 1000).toFixed(0)} s`);
} else {
  const res = race.classification();
  const sec = (k) => splits[k].map((x) => x.slice(0, 3).map(fmt).join('/')).join(' ');
  console.log(`${name(ids[0])} (pole) vs ${name(ids[1])} · ${cls} ${trackName} ${laps}L · winner ${teams.find((t) => t.id === res[0].team).short} by ${res[1].gap?.toFixed(2)} s · passes ${ev.passes.join(' ') || '-'}`);
  console.log(`  CRV spins ${ev.spin} · fear-brakes ${ev.fear} (${ev.fearT.toFixed(1)} s) · alongside ${ev.alongside.toFixed(1)} s · follow ${ev.follow.toFixed(0)} s (gap ${(ev.gapSum / Math.max(1e-9, ev.follow)).toFixed(0)} m, <20 m ${ev.close.toFixed(0)} s, capped ${ev.capped.toFixed(0)} s) · moves ${dbg().moves ?? 0} aborts ${dbg().aborts ?? 0} · states ${Object.entries(ev.states).map(([k, v]) => `${k}${v.toFixed(0)}`).join(' ')}`);
  console.log(`  inc ${name(ids[0])} ${inc(race.entries[0])} · ${name(ids[1])} ${inc(race.entries[1])} · ${((Date.now() - wall) / 1000).toFixed(0)} s`);
  console.log(`  sectors ${name(ids[0])} ${sec(0)} | ${name(ids[1])} ${sec(1)}`);
}
if (process.env.DUMP) console.log(dump.rows.join(' '));
seats?.dispose(); process.exit(0);
