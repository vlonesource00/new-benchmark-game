// Head-to-head and small-field racing through the real EnduranceRace loop (lockstep seats), rolling start.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/duel.mjs <ai1,ai2,...> <lmdh|gt> <track> [laps=4] [json-apex-options]
//   car 0 is pole (front row, right), car 1 front row left, then two-by-two; --classes=lmdh,gt,... per car; --seed; --compound
// Reports per car: finishing order, gap to the leader, best lap, incident points and log, severe contacts, passes.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--')), flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [idsArg = 'apex,next-racer', cls = 'lmdh', trackName = 'harbor-ring', laps = '4', opts = '{}'] = pos;
const ids = idsArg.split(','), perCar = (flags.classes ?? '').split(',').filter(Boolean), options = JSON.parse(opts), n = Number(laps), track = new Track(trackName);
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = ids.map((id, i) => { const c = perCar[i] ?? cls; return { id: 't' + i, name: short(id) + i, short: short(id) + i, color: '#fff', index: i, starter: 0, classId: c, raceClass: c === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: short(id) }], grid: i }; });
const per = JSON.parse(flags.per ?? '{}');                       // --per='{"0":{...},"2":{...}}': options for one car only
const makeBridge = (d, i, race) => d.id === 'apex' && (Object.keys(options).length || per[i]) ? createApexBridge({ hostTrack: race.track, index: i, options: { ...options, ...per[i] }, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race);
const compound = flags.compound ?? 'medium';
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: compound, makeBridge, startType: flags.start ?? 'rolling', seed: Number(flags.seed ?? 7), weatherSeed: Number(flags.seed ?? 7) });
for (const e of race.entries) e.strategist.decide = () => null;
race.start(); for (const c of race.cars) race.fitTyres(c, compound, true);
// --contacts=<min closing>: log every contact with the state of both cars (APEX cars also with their planner state)
if (flags.contacts) {
  const pairs = race.collisionStats.pairs, push = pairs.push.bind(pairs), min = Number(flags.contacts), last = new Map();
  pairs.push = (...a) => {
    for (const [ia, ib, closing] of a) {
      const key = ia + ':' + ib; if (closing < min || race.time - (last.get(key) ?? -9) < 0.5) continue; last.set(key, race.time);
      const desc = (id) => { const c = race.cars.find((x) => x.id === id), e = race.entryOf(c), dr = e.bridges[0].driver, cb = dr?.combat; return `${e.team.short} s${c.s.toFixed(0)} lat${c.lateral.toFixed(1)} v${c.speed.toFixed(1)} thr${c.controls.throttle.toFixed(1)} brk${c.controls.brake.toFixed(1)} str${c.controls.steer.toFixed(2)}${cb ? ` [${dr.intent} ${cb.plan?.tag ?? '-'} side${cb.plan?.side ?? 0} cap${Number.isFinite(cb.cap) ? cb.cap.toFixed(0) : '-'}]` : ''}`; };
      // geometry in the frame of the car in front: who is behind whom and how fast it closes along the road and across it
      const A = race.cars.find((x) => x.id === ia), B = race.cars.find((x) => x.id === ib), dsAB = ((A.s - B.s + track.length * 1.5) % track.length) - track.length / 2;
      const [front, back] = dsAB >= 0 ? [A, B] : [B, A], fx = Math.sin(front.yaw), fz = Math.cos(front.yaw), rx = fz, rz = -fx;
      const dx = back.x - front.x, dz = back.z - front.z, dvx = back.vx - front.vx, dvz = back.vz - front.vz;
      const lon = dx * fx + dz * fz, lat = dx * rx + dz * rz, vlon = dvx * fx + dvz * fz, vlat = dvx * rx + dvz * rz;
      const kind = Math.abs(lat) < 2.2 && lon < -2.6 ? 'REAR-END' : Math.abs(lon) < 3.6 ? 'SIDE' : 'CORNER';
      console.log(`CONTACT t${race.time.toFixed(2)} L${race.cars[0].race.lap} closing ${closing.toFixed(1)} ${kind} (${race.entryOf(back).team.short} behind ${race.entryOf(front).team.short}: lon ${lon.toFixed(1)} lat ${lat.toFixed(1)} vlon ${vlon.toFixed(1)} vlat ${vlat.toFixed(1)}): ${desc(ia)} | ${desc(ib)}`);
    }
    return push(...a);
  };
}
const cars = race.cars; const drivers = race.entries.map((e) => e.bridges[0].driver); const lapT = cars.map(() => []), lapSeen = cars.map(() => 1); let lastOrder = null, passes = 0; const passLog = [], t0 = Date.now(); let minGap = Infinity; const takeovers = []; let aheadOf = null; const hist = [];
const contactSteps = cars.map(() => 0);
while ((flags.until == null || race.time < Number(flags.until)) && cars.some((c) => c.race.lap <= n) && race.time < 90 * n * Math.max(1, track.length / 3000) + 120) {
  race.step(FIXED_DT);
  if (race.formation) continue;
  const order = race.order().map((c) => c.id).join();
  if (lastOrder && order !== lastOrder) { passes++; passLog.push(`${race.time.toFixed(0)}s:${order}`); }
  lastOrder = order;
  if (!race.formation) {
    const me = flags.me != null ? Number(flags.me) : ids.indexOf('apex');
    if (me >= 0) for (let j = 0; j < cars.length; j++) {
      if (j === me) continue;
      const d = cars[me].race.progress - cars[j].race.progress, st = (globalThis.__pw ??= {})[j] ??= { ahead: null, since: 0, hist: [] };
      st.hist.push({ t: race.time, d, vm: cars[me].speed, vj: cars[j].speed, lm: cars[me].lateral, lj: cars[j].lateral }); if (st.hist.length > 900) st.hist.shift();
      const who = Math.abs(d) > 6 ? (d > 0 ? 1 : 0) : st.ahead;      // 1: apex ahead of j
      if (who !== st.ahead) {
        if (st.ahead !== null) {
          const w = st.hist.filter((h) => h.t > race.time - 6), n = Math.max(1, w.length), dv = w.reduce((s, h) => s + (h.vm - h.vj), 0) / n, dl = w.reduce((s, h) => s + Math.abs(h.lm - h.lj), 0) / n;
          const dr = drivers[me]?.combat;
          takeovers.push({ t: +race.time.toFixed(1), rival: j, ai: ids[j], dir: who === 1 ? 'apex-ahead' : 'rival-ahead', lap: cars[me].race.lap, s: Math.round(cars[me].s), speedEdge6s: +dv.toFixed(2), lateralGap6s: +dl.toFixed(1), state: dr?.state ?? null, tag: dr?.plan?.tag ?? null, since: +(race.time - st.since).toFixed(1) });
        }
        st.ahead = who; st.since = race.time;
      }
    }
  }
  if (flags.launch && race.greenAt != null && race.time - race.greenAt < Number(flags.launch) && Math.round(race.time * 120) % 10 === 0) for (const e of race.entries) { const dr = e.bridges[0].driver; if (!dr?.line) continue; const c = e.car; console.log(`${(race.time - race.greenAt).toFixed(2)} ${e.team.short} v${c.speed.toFixed(1)} thr${c.controls.throttle.toFixed(2)} brk${c.controls.brake.toFixed(2)} str${c.controls.steer.toFixed(2)} tc${dr.tcCap?.toFixed(2)} prot${dr.protect?.toFixed(2)} stab${dr.stability?.toFixed(2)} share${dr.share?.toFixed(2)} tv${dr.targetSpeed?.toFixed(1)} e${dr.e?.toFixed(1)} gear${c.gear} rpm${c.rpm?.toFixed(0)} hyb${c.hybrid?.mode}`); }
  if (flags.events && race.collisionStats.peakClosing > (globalThis.__peak ?? 3.0)) { globalThis.__peak = race.collisionStats.peakClosing; console.log(`CONTACT t${race.time.toFixed(2)} closing ${globalThis.__peak.toFixed(1)}: ` + cars.map((c) => `${race.entryOf(c).team.short} s${c.s.toFixed(0)} lat${c.lateral.toFixed(1)} v${c.speed.toFixed(1)} yaw${((c.yaw - track.at(c.s).heading) * 57.3).toFixed(0)}° thr${c.controls.throttle.toFixed(1)} brk${c.controls.brake.toFixed(1)} L${c.race.lap}`).join(' | ')); }
  cars.forEach((c, i) => { if (c.race.lap !== lapSeen[i]) { lapT[i].push(+c.race.lastLap.toFixed(2)); lapSeen[i] = c.race.lap; } });
  if (flags.dump && race.time >= Number(flags.dump) && !globalThis.__dumped) { globalThis.__dumped = 1; const e = race.entries.find((x) => x.bridges[0].driver?.combat), dr = e.bridges[0].driver, pl = dr.combat.plan; if (pl) { const L = pl.lane, base = dr.line, i0 = dr.cursor; const o = []; for (let j = 0; j < 90; j += 6) { const i = base.idx(i0 + j); o.push(`${j}: lane v${L.v[i].toFixed(1)} base v${base.v[i].toFixed(1)} vmax ${L.vmax[i].toFixed(1)} ks ${L.ks[i].toFixed(4)} bks ${base.ks[i].toFixed(4)} lat ${L.lat[i].toFixed(1)}/${base.lat[i].toFixed(1)}`); } console.log('DUMP A', pl.A, 'speed', e.car.speed.toFixed(1), 'cursor', i0); console.log(o.join('\n')); } }
  if (flags.pose && race.time >= Number(flags.pose.split(':')[0]) && race.time <= Number(flags.pose.split(':')[1])) console.log(`POSE ${race.time.toFixed(3)} ` + cars.map((c) => `${race.entryOf(c).team.short} s${c.s.toFixed(1)} lat${c.lateral.toFixed(2)} vl${c.v.toFixed(2)} v${c.speed.toFixed(1)} yawE${((c.yaw - track.at(c.s).heading) * 57.3).toFixed(1)} r${c.yawRate.toFixed(2)} st${c.controls.steer.toFixed(2)} z${c.zone ?? ''}`).join(' | '));
  if (flags.poseS) { const [a, b] = flags.poseS.split(':').map(Number); for (const c of cars) if (c.s >= a && c.s <= b && Math.round(race.time * 120) % Number(flags.every ?? 6) === 0) console.log(`POSES ${race.time.toFixed(2)} ${race.entryOf(c).team.short} L${c.race.lap} s${c.s.toFixed(0)} lat${c.lateral.toFixed(2)} v${c.speed.toFixed(1)} slipDeg${(Math.atan2(c.v, Math.max(2, c.u)) * 57.3).toFixed(1)} yawE${((c.yaw - track.at(c.s).heading) * 57.3).toFixed(1)} st${c.controls.steer.toFixed(2)} thr${c.controls.throttle.toFixed(2)} brk${c.controls.brake.toFixed(2)} core${c.wheels.map((w) => w.tyre.core.toFixed(0)).join('/')} wear${c.wheels.map((w) => (w.tyre.wear * 100).toFixed(0)).join('/')}`); }
  if (flags.dumplane && !globalThis.__dumped && race.time >= Number(flags.dumplane)) { for (const e of race.entries) { const dr = e.bridges[0].driver, pl = dr?.combat?.plan; if (!pl?.lane || pl.lane === dr.line) continue; globalThis.__dumped = true; const L = pl.lane, ln = dr.line, w = L.window; console.log('DUMP t', race.time.toFixed(2), 'tag', pl.tag, 'window', JSON.stringify(w), 'ds', ln.ds); for (let j = -4; j <= 24; j++) { const i = ln.idx(w.i0 + j); console.log('DUMP j', j, 'sh', (L.lat[i] - ln.lat[i]).toFixed(2), 'v', L.v[i].toFixed(1), 'line.v', ln.v[i].toFixed(1), 'vmax', L.vmax[i].toFixed(1), 'line.vmax', ln.vmax[i].toFixed(1), 'ks', L.ks[i].toFixed(4), 'line.ks', ln.ks[i].toFixed(4), 'dk', L.dk[i].toExponential(2), 'line.dk', ln.dk[i].toExponential(2)); } } }
  if (flags.trace && Math.round(race.time * 120) % Number(flags.trace) === 0) for (const e of race.entries) { const dr = e.bridges[0].driver; if (!dr?.combat) continue; const dbg = dr.debug().combat, c = e.car; const lead = dr.field.list.filter((r) => r.ds > 0).sort((a, b) => a.ds - b.ds)[0]; const dd = dr.debug(); const stI = dr.cur?.i, onLine = dr.path === dr.line; console.log(`${race.time.toFixed(1)} L${c.race.lap} s${c.s.toFixed(0)} v${c.speed.toFixed(1)} (i${stI}${onLine ? "L" : "p"} d0${dr.combat.d0?.toFixed(2)} m0${dr.combat.m0?.toFixed(3)} W${JSON.stringify(dr.combat.dbgLane)} tv${dd.targetSpeed?.toFixed?.(0)} lv${dd.lineSpeed?.toFixed?.(0)} ${dd.sub ?? ""} stab${dd.stability?.toFixed?.(2)} grip${dd.grip?.toFixed?.(2)} lu${dd.latUse?.toFixed?.(2)}) lat${c.lateral.toFixed(1)} ${dbg.state}/${dbg.tag} A${dbg.A.toFixed(1)} cap${dbg.cap == null ? '-' : dbg.cap.toFixed(0)} lead ${lead ? `ds${lead.ds.toFixed(0)} v${lead.v.toFixed(0)} lat${lead.lat.toFixed(1)}` : '-'} cands ${flags.cands ? JSON.stringify(dbg.cands) : ''} best ${dbg.cands?.slice().sort((a, b) => b.score - a.score)[0] ? JSON.stringify(dbg.cands.slice().sort((a, b) => b.score - a.score)[0]) : ''}`); }
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) { const d = Math.hypot(cars[i].x - cars[j].x, cars[i].z - cars[j].z); if (d < minGap) minGap = d; }
}
const ord = race.order(), lead = ord[0];
const rows = ord.map((c, k) => { const e = race.entryOf(c), st = race.stewards.of(e); return `${k + 1}. ${e.team.short} ${c.classId} ${(c.race.progress - lead.race.progress).toFixed(0)}m best ${c.race.bestLap?.toFixed(2)} inc ${st.inc}x[${[...new Set(st.log.map((l) => l.kind))].join(',')}] dmg ${(c.damage * 100).toFixed(0)}% laps ${lapT[c.id].join(' ')}`; });
if (flags.json) { const finalAhead = Object.fromEntries(Object.entries(globalThis.__pw ?? {}).map(([j, s]) => [ids[j] + j, s.ahead])); console.log(JSON.stringify({ takeovers, finalAhead, combat: drivers.map((d) => (d?.combat ? { stats: d.combat.stats, events: d.combat.events, cost: d.combat.cost } : null)), ids, cls, track: trackName, laps: n, contacts: race.contacts, severe: race.collisionStats.severeContacts, peakClosing: +race.collisionStats.peakClosing.toFixed(1), minDist: +minGap.toFixed(1), changes: passes, rows: ord.map((c) => { const e = race.entryOf(c), st = race.stewards.of(e); return { name: e.team.short, ai: e.team.drivers[0].id, cls: c.classId, gap: +(c.race.progress - lead.race.progress).toFixed(0), best: c.race.bestLap, inc: st.inc, kinds: [...new Set(st.log.map((l) => l.kind))], dmg: +c.damage.toFixed(3), laps: lapT[c.id], pen: st.issued }; }), wall: +((Date.now() - t0) / 1000).toFixed(0) })); process.exit(0); }
console.log(`${ids.map(short).join(' v ')} ${cls} ${trackName} ${n}L | contacts ${race.contacts} severe ${race.collisionStats.severeContacts} peakClosing ${race.collisionStats.peakClosing.toFixed(1)} minDist ${minGap.toFixed(1)} | order changes ${passes} | ${((Date.now() - t0) / 1000).toFixed(0)}s\n  ` + rows.join('\n  '));
for (const e of race.entries) { const cb = e.bridges[0].driver?.combat; if (cb?.cost) console.error(`PLANCOST ${e.team.short} plans ${cb.cost.n} avg ${(cb.cost.total / cb.cost.n).toFixed(2)} ms max ${cb.cost.max.toFixed(1)} ms`); }
