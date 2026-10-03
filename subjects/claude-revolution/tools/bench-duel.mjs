// Duel bench: two same-class cars from a rolling start, one directly behind
// the other. Reports passes, laps to the first pass, contacts and incidents.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bench-duel.mjs <front-ai> <back-ai> [lmdh|gt] [track] [laps] [compound]
// Debug env: TRACE=1 (history before the first incidents, HIST=n lines kept), START=s (launch trace for s seconds after green), DUMPAT=t (lane dump at time t).
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';

const [front = 'solstice', back = 'claude-revolution', cls = 'lmdh', trackName = 'harbor-ring', laps = '4', compound = 'medium'] = process.argv.slice(2);
const track = new Track(trackName);
const name = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const team = (id, i) => ({ id: `t${i}`, name: `${name(id)}${i}`, short: `${name(id)}${i}`, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: name(id) }], grid: i });
const teams = [team(front, 0), team(back, 1)];
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12, startCompound: compound, makeBridge: createSeatBridge, startType: 'rolling' });
race.start();
for (const c of race.cars) race.fitTyres(c, compound, true);
const [a, b] = race.cars;
let order = Math.sign(a.race.progress - b.race.progress), passes = [], minGap = Infinity, alongside = 0;
const wall = Date.now();
while (race.phase !== 'finished' && Math.min(a.race.lap, b.race.lap) <= Number(laps) && race.time < 90 * Number(laps) + 60) {
  race.step(FIXED_DT);
  if (race.formation) continue;
  const d = a.race.progress - b.race.progress, o = Math.sign(d);
  if (o !== order && Math.abs(d) > 6) { passes.push(`${o > 0 ? name(front) : name(back)}@L${Math.max(a.race.lap, b.race.lap)}:${b.s.toFixed(0)}`); order = o; }
  if (Math.abs(d) < 5 && Math.abs(a.lateral - b.lateral) < 3) alongside += FIXED_DT;
  minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.z - b.z));
  const rcx = race.entries.map((e) => e.bridges[0].driver).find((x) => x?.racecraft);
  (globalThis.__h ??= []).push(`${race.time.toFixed(2)} ds${(a.race.progress - b.race.progress).toFixed(1)} Alat${a.lateral.toFixed(2)} Blat${b.lateral.toFixed(2)} Av${a.speed.toFixed(1)} Bv${b.speed.toFixed(1)} ${rcx?.racecraft.kind}/${rcx?.racecraft.state} tgt${(rcx?.racecraft.lane ?? rcx?.line)?.lat[rcx?.cursor]?.toFixed(2)} st${rcx?.steer?.toFixed(2)} tv${rcx?.targetSpeed?.toFixed(1)} lv${rcx?.line?.v?.[rcx?.cursor]?.toFixed(1)} wk${b.aero?.wake?.toFixed(2)} stab${rcx?.stability?.toFixed(2)} β${Math.atan2(b.v, Math.max(2, b.u)).toFixed(2)} r${b.yawRate.toFixed(2)}/${rcx?.rDes?.toFixed(2)} T${b.controls.throttle.toFixed(2)} B${b.controls.brake.toFixed(2)} e${rcx?.e?.toFixed(1)} cap${rcx?.racecraft.cap?.toFixed?.(1)} [${rcx?.racecraft.cands}] ax${a.x.toFixed(1)},${a.z.toFixed(1)} bx${b.x.toFixed(1)},${b.z.toFixed(1)}`); if (globalThis.__h.length > Number(process.env.HIST ?? 180)) globalThis.__h.shift(); if (process.env.DUMPAT && !globalThis.__dumped && race.time > Number(process.env.DUMPAT)) { globalThis.__dumped = 1; const ln = rcx.racecraft.lane, l0 = rcx.line, i0 = rcx.cursor; console.log('DUMP cursor', i0, 'ds', l0.ds); for (let k = -24; k < 80; k += 3) { const j = l0.idx(i0 + k); console.log(k, 'shift', ln?.shift?.[j]?.toFixed(2), 'ks', ln?.ks?.[j]?.toFixed(4), 'k', ln?.k?.[j]?.toFixed(4), 'vmax', ln?.vmax?.[j]?.toFixed(1), 'v', ln?.v?.[j]?.toFixed(1), 'lineV', l0.v[j].toFixed(1), 'lineKs', l0.ks[j].toFixed(4)); } } if (process.env.START && race.time - (globalThis.__g ??= race.time) < Number(process.env.START) && Math.round(race.time * 60) % 15 === 0) console.log(`${race.time.toFixed(2)} A g${a.gear} T${a.controls.throttle.toFixed(2)} v${a.speed.toFixed(1)} ax${(a.ax ?? 0).toFixed(1)} auto${a.automatic} rpm${(a.rpm ?? 0).toFixed(0)} | B g${b.gear} T${b.controls.throttle.toFixed(2)} v${b.speed.toFixed(1)} ax${(b.ax ?? 0).toFixed(1)} auto${b.automatic} rpm${(b.rpm ?? 0).toFixed(0)} ds${(a.race.progress - b.race.progress).toFixed(1)} | ${rcx?.racecraft.kind}/${rcx?.racecraft.state} cap${rcx?.racecraft.cap?.toFixed?.(1)} rfx${rcx?.racecraft.reflexCap?.toFixed?.(1)} tv${rcx?.targetSpeed?.toFixed(1)} lv${rcx?.line?.v?.[rcx?.cursor]?.toFixed(1)} lnv${(rcx?.racecraft.lane)?.v?.[rcx?.cursor]?.toFixed(1)} line${rcx?.line?.lat?.[rcx?.cursor]?.toFixed(1)}  stab${rcx?.stability?.toFixed(2)} β${Math.atan2(a.v, Math.max(2, a.u)).toFixed(3)} r${a.yawRate.toFixed(3)}/${rcx?.rDes?.toFixed(3)} st${rcx?.steer?.toFixed(2)} lat${a.lateral.toFixed(1)}/${b.lateral.toFixed(1)} tgt${(rcx?.racecraft.lane ?? rcx?.line)?.lat[rcx?.cursor]?.toFixed(2)} [${rcx?.racecraft.cands}]`);
  const nlog = race.entries.reduce((n, e) => n + race.stewards.of(e).log.length, 0);
  if (nlog > (globalThis.__nlog ?? 0)) {
    globalThis.__nlog = nlog;
    const rc = race.entries.map((e) => e.bridges[0].driver?.racecraft).find(Boolean);
    if ((globalThis.__shown = (globalThis.__shown ?? 0) + 1) <= 3 && process.env.TRACE) console.log(globalThis.__h.filter((_, k) => k % 8 === 0).join(String.fromCharCode(10)));
    console.log(`  event t${race.time.toFixed(1)} L${b.race.lap} ${race.entries.map((e) => race.stewards.of(e).log.at(-1)?.kind ?? '-').join('/')} · A s${a.s.toFixed(0)} lat${a.lateral.toFixed(1)} v${a.speed.toFixed(1)} · B s${b.s.toFixed(0)} lat${b.lateral.toFixed(1)} v${b.speed.toFixed(1)} · rc ${rc?.state} ${rc?.kind} cap${rc?.cap?.toFixed?.(1)} [${rc?.cands ?? ''}]`);
  }
}
const inc = (e) => { const st = race.stewards.of(e); return `${st.inc}x[${st.log.map((l) => l.kind).join(',')}]`; };
console.log(`${name(front)} ahead of ${name(back)} · ${cls} ${trackName} ${compound} · passes ${passes.length} ${passes.join(' ')} · final ${order > 0 ? name(front) : name(back)} leads by ${Math.abs(a.race.progress - b.race.progress).toFixed(0)} m · alongside ${alongside.toFixed(1)} s · min dist ${minGap.toFixed(1)} m · inc ${name(front)} ${inc(race.entries[0])} ${name(back)} ${inc(race.entries[1])} · best ${a.race.bestLap?.toFixed(2)} / ${b.race.bestLap?.toFixed(2)} · err ${race.entries.map((e) => e.bridges[0].errors).join('/')} · ${((Date.now() - wall) / 1000).toFixed(0)} s`);
