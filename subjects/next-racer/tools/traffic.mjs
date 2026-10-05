// Multi-class traffic bench: Spearhead seats in a mixed field, run through the
// game's seat workers. Reports lap times, time spent stuck behind a car, passes,
// planner latency and why the car was slowing.
//   node --import ./scripts/json-loader.mjs subjects/next-racer/tools/traffic.mjs \
//     --field next-racer:lmdh,next-racer:gt,astra:gt,gemini-supreme-v4:gt --track harbor-ring --laps 4 [--realtime]
// The grid is the field order (first car on pole). --focus <i> picks the car to
// report in detail (default: the first Spearhead GTP behind someone).
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import '../../claude-revolution/tools/worker-shim.mjs';

const args = process.argv.slice(2), get = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const trackName = get('track', 'harbor-ring'), laps = Number(get('laps', 4)), realtime = args.includes('--realtime');
const field = get('field', 'gemini-supreme-v4:gt,astra:gt,next-racer:gt,next-racer:lmdh').split(',').map((x) => { const [id, cls] = x.split(':'); return { id, cls: cls ?? 'lmdh' }; });
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = field.map((f, i) => ({ id: `t${i}`, name: `${short(f.id)}${i}`, short: `${short(f.id)}${i}`, color: '#fff', index: i, starter: 0,
  classId: f.cls, raceClass: f.cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: f.id, name: f.id, short: short(f.id) }], grid: i }));
const track = new Track(trackName), L = track.length;
const seats = new AsyncSeats(trackName);
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12,
  startCompound: 'medium', makeBridge: seats.factory(), startType: args.includes('--standing') ? 'standing' : 'rolling' });
race.laps = laps; race.start(); await seats.start(race);
seats.wantDebug = true;
const cars = race.cars;
const focus = Number(get('focus', Math.max(0, field.findIndex((f, i) => f.id === 'next-racer' && f.cls === 'lmdh' && i > 0))));
const fc = cars[focus];
const answers = async () => { while (seats.hosts.some((h) => h?.seats.some((x) => x.inFlight))) await new Promise((r) => setImmediate(r)); };
const st = { stuck: 0, stuckBy: {}, safety: {}, intent: {}, plan: {}, lat: [], maxLat: 0, slow: {}, slowMs: [], brakeStuck: 0, passes: [], lost: [] };
const tally = (o, k, dt) => { o[k] = (o[k] ?? 0) + dt; };
let sub = 0, frames = 0; const wall0 = Date.now();
let order = cars.map((c) => c.race.progress);
const lapSeen = cars.map((c) => c.race.lap), lapLog = cars.map(() => []);
while (race.phase !== 'finished' && race.time < 120 * laps + 90) {
  race.step(FIXED_DT);
  if (++sub % 2 === 0) {
    frames++;
    if (realtime) { const due = wall0 + frames * 1000 / 60; while (Date.now() < due) await new Promise((r) => setImmediate(r)); }
    else await answers();
  }
  cars.forEach((c, i) => { if (c.race.lap !== lapSeen[i]) { lapSeen[i] = c.race.lap; if (c.race.lastLap && !race.formation) lapLog[i].push(c.race.lastLap); } });
  if (race.formation || race.phase !== 'racing') continue;
  const fp = track.nearest(fc.x, fc.z);
  // Stuck: a car 0..35 m ahead within a car width, and we are not faster than it.
  let blocker = null;
  for (const o of cars) {
    if (o === fc) continue;
    const q = track.nearest(o.x, o.z); let d = q.s - fp.s; if (d < -L / 2) d += L; if (d > L / 2) d -= L;
    if (d > 0 && d < 35 && Math.abs(q.lateral - fp.lateral) < 2.6 && (!blocker || d < blocker.d)) blocker = { d, o };
  }
  const dbg = race.entries[focus].bridges[0]?.lastDebug ?? {};
  const near = blocker ?? (args.includes('--traceall') ? cars.filter((o) => o !== fc).map((o) => { const q = track.nearest(o.x, o.z); let d = q.s - fp.s; if (d < -L / 2) d += L; if (d > L / 2) d -= L; return { d, o }; }).filter((x) => Math.abs(x.d) < 40).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0] : null);
  if (near && (args.includes('--trace') || args.includes('--traceall')) && Math.round(race.time * 120) % 30 === 0) { const blocker = near; const bq = track.nearest(blocker.o.x, blocker.o.z); console.log(`t${race.time.toFixed(1)} s${fp.s.toFixed(0)} d${blocker.d.toFixed(1)} q${fp.lateral.toFixed(2)} bq${bq.lateral.toFixed(2)} v${(fc.speed*3.6).toFixed(0)}/${(blocker.o.speed*3.6).toFixed(0)} thr${fc.controls.throttle.toFixed(2)} brk${fc.controls.brake.toFixed(2)} st${fc.controls.steer.toFixed(2)} ${dbg.intent}/${dbg.stage}>${dbg.target ?? '-'} side${dbg.side} ${dbg.plan?.kind} ${dbg.reason ?? ''} saf ${dbg.safety} k${track.at(fp.s).curvature.toFixed(4)} chk ${(dbg.checks ?? []).map((c) => `${c.kind}${c.side}${c.brakeAction ? "b" : ""}${c.finalAdmission ? "F" : ""}:${c.reason ?? "ok"}${c.score!=null?"="+c.score.toFixed(0):""}${c.progress!=null?"p"+c.progress.toFixed(0)+"/"+(c.speed??0).toFixed(0):""}${c.conflict ? "@" + c.conflict.t.toFixed(2) + "/" + c.conflict.branch : ""}`).join(" ")}`); }
  if (blocker) { st.stuck += FIXED_DT; tally(st.stuckBy, `${short(field[blocker.o.id]?.id ?? '?')}:${blocker.o.classId}`, FIXED_DT); if (fc.controls.brake > .05) st.brakeStuck += FIXED_DT; }
  if (sub % 2 === 0) {
    tally(st.safety, dbg.safety ?? 'none', FIXED_DT * 2); tally(st.intent, `${dbg.intent}/${dbg.stage}`, FIXED_DT * 2); tally(st.plan, dbg.plan?.kind ?? '-', FIXED_DT * 2); if ((dbg.planFactor ?? 1) < 1) tally(st.safety, 'factor' + dbg.planFactor, FIXED_DT * 2);
    if (args.includes('--why') && ((dbg.planFactor ?? 1) < 1 || /emergency/.test(dbg.plan?.kind ?? '')) && Math.round(race.time * 60) % 15 === 0) { let near = 999; for (const o of cars) if (o !== fc) near = Math.min(near, Math.hypot(o.x - fc.x, o.z - fc.z)); console.log(`W t${race.time.toFixed(1)} lap${fc.race.lap} s${fp.s.toFixed(0)} q${fp.lateral.toFixed(2)} v${(fc.speed * 3.6).toFixed(0)} ${dbg.intent}/${dbg.stage} ${dbg.plan?.kind} f${dbg.planFactor} near${near.toFixed(0)} pit${fc.race.pitLap ?? '-'} chk ${(dbg.checks ?? []).slice(0, 4).map((c) => `${c.kind}:${c.reason ?? 'ok'}`).join(' ')}`); }
    if (dbg.latency != null) { if (dbg.latency > Number(get('slow', 100)) && dbg.stats && dbg.latency !== st.lastSlow) { const k = `${dbg.plan?.kind}/${dbg.intent}`; st.slow[k] = (st.slow[k] ?? 0) + 1; st.lastSlow = dbg.latency; st.slowMs.push(`${dbg.latency.toFixed(0)}:o${(dbg.stats.observerMs ?? 0).toFixed(0)}r${(dbg.stats.routesMs ?? 0).toFixed(0)}a${(dbg.stats.admissionMs ?? 0).toFixed(0)}e${(dbg.stats.envelopeMs ?? 0).toFixed(0)}n${dbg.evaluated?.length ?? 0}c${dbg.checks?.length ?? 0}`); } st.lat.push(dbg.latency); st.maxLat = Math.max(st.maxLat, dbg.latency); }
  }
  // Passes made and lost by the focus car (progress order flips).
  cars.forEach((o, i) => {
    if (o === fc) return;
    const before = order[focus] - order[i], now = fc.race.progress - o.race.progress;
    if (before < 0 && now > 0) st.passes.push(`${short(field[i].id)}${i}@${race.time.toFixed(0)}`);
    if (before > 0 && now < 0) st.lost.push(`${short(field[i].id)}${i}@${race.time.toFixed(0)}`);
  });
  order = cars.map((c) => c.race.progress);
}
const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
const lat = st.lat.sort((a, b) => a - b), pct = (p) => lat[Math.floor(p * (lat.length - 1))]?.toFixed(1);
for (let i = 0; i < cars.length; i++) {
  const r = cars[i].race;
  console.log(`${String(i).padStart(2)} ${short(field[i].id)} ${field[i].cls.padEnd(4)} laps ${lapLog[i].map((x) => x.toFixed(2)).join(' ')} best ${r.bestLap?.toFixed(2)} fin ${r.finishTime?.toFixed(2)} inc ${race.stewards.of(race.entries[i]).log.map((l) => l.kind).join(',') || '-'}`);
}
console.log(`focus ${focus} ${short(field[focus].id)} ${field[focus].cls}: stuck ${st.stuck.toFixed(1)} s (braking ${st.brakeStuck.toFixed(1)} s) by ${fmt(st.stuckBy)}`);
console.log(`  passes ${st.passes.join(' ') || '-'} · lost ${st.lost.join(' ') || '-'}`);
console.log(`  latency p50 ${pct(.5)} p90 ${pct(.9)} p99 ${pct(.99)} max ${st.maxLat.toFixed(1)} ms`);
console.log(`  slow ${Object.entries(st.slow).map(([k, v]) => k + ' ' + v).join(', ')} | ${st.slowMs.slice(0, Number(get('slown', 12))).join(' ')}`);
console.log(`  intent ${fmt(st.intent)}`);
console.log(`  plan ${fmt(st.plan)}`);
console.log(`  safety ${fmt(st.safety)}`);
console.log(`  ${((Date.now() - wall0) / 1000).toFixed(0)} s wall`);
seats.dispose(); process.exit(0);
