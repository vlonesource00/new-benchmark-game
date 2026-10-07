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
const makeBridge = (d, i, race) => d.id === 'apex' && Object.keys(options).length ? createApexBridge({ hostTrack: race.track, index: i, options, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race);
const compound = flags.compound ?? 'medium';
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: compound, makeBridge, startType: flags.start ?? 'rolling', seed: Number(flags.seed ?? 7), weatherSeed: Number(flags.seed ?? 7) });
for (const e of race.entries) e.strategist.decide = () => null;
race.start(); for (const c of race.cars) race.fitTyres(c, compound, true);
const cars = race.cars; const lapT = cars.map(() => []), lapSeen = cars.map(() => 1); let lastOrder = null, passes = 0; const passLog = [], t0 = Date.now(); let minGap = Infinity;
const contactSteps = cars.map(() => 0);
while (cars.some((c) => c.race.lap <= n) && race.time < 90 * n * Math.max(1, track.length / 3000) + 120) {
  race.step(FIXED_DT);
  if (race.formation) continue;
  const order = race.order().map((c) => c.id).join();
  if (lastOrder && order !== lastOrder) { passes++; passLog.push(`${race.time.toFixed(0)}s:${order}`); }
  lastOrder = order;
  if (flags.launch && race.greenAt != null && race.time - race.greenAt < Number(flags.launch) && Math.round(race.time * 120) % 10 === 0) for (const e of race.entries) { const dr = e.bridges[0].driver; if (!dr?.line) continue; const c = e.car; console.log(`${(race.time - race.greenAt).toFixed(2)} ${e.team.short} v${c.speed.toFixed(1)} thr${c.controls.throttle.toFixed(2)} brk${c.controls.brake.toFixed(2)} str${c.controls.steer.toFixed(2)} tc${dr.tcCap?.toFixed(2)} prot${dr.protect?.toFixed(2)} stab${dr.stability?.toFixed(2)} share${dr.share?.toFixed(2)} tv${dr.targetSpeed?.toFixed(1)} e${dr.e?.toFixed(1)} gear${c.gear} rpm${c.rpm?.toFixed(0)} hyb${c.hybrid?.mode}`); }
  if (flags.events && race.collisionStats.peakClosing > (globalThis.__peak ?? 3.0)) { globalThis.__peak = race.collisionStats.peakClosing; console.log(`CONTACT t${race.time.toFixed(2)} closing ${globalThis.__peak.toFixed(1)}: ` + cars.map((c) => `${race.entryOf(c).team.short} s${c.s.toFixed(0)} lat${c.lateral.toFixed(1)} v${c.speed.toFixed(1)} yaw${((c.yaw - track.at(c.s).heading) * 57.3).toFixed(0)}° thr${c.controls.throttle.toFixed(1)} brk${c.controls.brake.toFixed(1)} L${c.race.lap}`).join(' | ')); }
  cars.forEach((c, i) => { if (c.race.lap !== lapSeen[i]) { lapT[i].push(+c.race.lastLap.toFixed(2)); lapSeen[i] = c.race.lap; } });
  if (flags.dump && race.time >= Number(flags.dump) && !globalThis.__dumped) { globalThis.__dumped = 1; const e = race.entries.find((x) => x.bridges[0].driver?.combat), dr = e.bridges[0].driver, pl = dr.combat.plan; if (pl) { const L = pl.lane, base = dr.line, i0 = dr.cursor; const o = []; for (let j = 0; j < 90; j += 6) { const i = base.idx(i0 + j); o.push(`${j}: lane v${L.v[i].toFixed(1)} base v${base.v[i].toFixed(1)} vmax ${L.vmax[i].toFixed(1)} ks ${L.ks[i].toFixed(4)} bks ${base.ks[i].toFixed(4)} lat ${L.lat[i].toFixed(1)}/${base.lat[i].toFixed(1)}`); } console.log('DUMP A', pl.A, 'speed', e.car.speed.toFixed(1), 'cursor', i0); console.log(o.join('\n')); } }
  if (flags.trace && Math.round(race.time * 120) % Number(flags.trace) === 0) for (const e of race.entries) { const dr = e.bridges[0].driver; if (!dr?.combat) continue; const dbg = dr.debug().combat, c = e.car; const lead = dr.field.list.filter((r) => r.ds > 0).sort((a, b) => a.ds - b.ds)[0]; console.log(`${race.time.toFixed(1)} L${c.race.lap} s${c.s.toFixed(0)} v${c.speed.toFixed(1)} lat${c.lateral.toFixed(1)} ${dbg.state}/${dbg.tag} A${dbg.A.toFixed(1)} cap${dbg.cap > 900 ? '-' : dbg.cap.toFixed(0)} lead ${lead ? `ds${lead.ds.toFixed(0)} v${lead.v.toFixed(0)} lat${lead.lat.toFixed(1)}` : '-'} cands ${flags.cands ? JSON.stringify(dbg.cands) : ''} best ${dbg.cands?.slice().sort((a, b) => b.score - a.score)[0] ? JSON.stringify(dbg.cands.slice().sort((a, b) => b.score - a.score)[0]) : ''}`); }
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) { const d = Math.hypot(cars[i].x - cars[j].x, cars[i].z - cars[j].z); if (d < minGap) minGap = d; }
}
const ord = race.order(), lead = ord[0];
const rows = ord.map((c, k) => { const e = race.entryOf(c), st = race.stewards.of(e); return `${k + 1}. ${e.team.short} ${c.classId} ${(c.race.progress - lead.race.progress).toFixed(0)}m best ${c.race.bestLap?.toFixed(2)} inc ${st.inc}x[${[...new Set(st.log.map((l) => l.kind))].join(',')}] dmg ${(c.damage * 100).toFixed(0)}% laps ${lapT[c.id].join(' ')}`; });
if (flags.json) { console.log(JSON.stringify({ ids, cls, track: trackName, laps: n, contacts: race.contacts, severe: race.collisionStats.severeContacts, peakClosing: +race.collisionStats.peakClosing.toFixed(1), minDist: +minGap.toFixed(1), changes: passes, rows: ord.map((c) => { const e = race.entryOf(c), st = race.stewards.of(e); return { name: e.team.short, ai: e.team.drivers[0].id, cls: c.classId, gap: +(c.race.progress - lead.race.progress).toFixed(0), best: c.race.bestLap, inc: st.inc, kinds: [...new Set(st.log.map((l) => l.kind))], dmg: +c.damage.toFixed(3), laps: lapT[c.id], pen: st.issued }; }), wall: +((Date.now() - t0) / 1000).toFixed(0) })); process.exit(0); }
console.log(`${ids.map(short).join(' v ')} ${cls} ${trackName} ${n}L | contacts ${race.contacts} severe ${race.collisionStats.severeContacts} peakClosing ${race.collisionStats.peakClosing.toFixed(1)} minDist ${minGap.toFixed(1)} | order changes ${passes} | ${((Date.now() - t0) / 1000).toFixed(0)}s\n  ` + rows.join('\n  '));
