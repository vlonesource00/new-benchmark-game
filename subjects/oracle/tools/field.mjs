// Combat audit: one field race (the standard benchmark field: two-car teams, APEX last, hard tyres, rolling start,
// no stops) with every ORACLE contact and every place it loses written down with what ORACLE was doing at the time,
// plus the real CPU cost of ORACLE's update per physics step.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/field.mjs [track] [seed] [laps] [ais] [cls] [json-options]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { OracleDriver } from '../src/driver.js';

const [trackName = 'harbor-ring', seedArg = '7', lapsArg = '5', aisArg = 'oracle,intercept,razor,apex', cls = 'gt', optsArg = '{}', traceArg = ''] = process.argv.slice(2);
const [tCar, tFrom, tTo] = traceArg ? traceArg.split(':').map(Number) : [-1, 0, 0];
const laps = Number(lapsArg), seed = Number(seedArg), track = new Track(trackName), opts = JSON.parse(optsArg);
const ais = aisArg.split(','), last = ais.includes('apex') ? 'apex' : null, front = ais.filter((a) => a !== last);
const rot = seed % front.length, order = [...front.slice(rot), ...front.slice(0, rot), ...(last ? [last] : [])];
const ids = order.flatMap((id) => [id, id]), short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = order.map((id, t) => ({ id: 't' + t, name: short(id), short: short(id), color: '#fff', index: t, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: [{ kind: 'ai', id, name: id, short: short(id) }, { kind: 'ai', id, name: id, short: short(id) }], grid: t }));
const entries = ids.map((id, i) => ({ ...teams[Math.floor(i / 2)], id: 'e' + i, index: i, grid: i, name: short(id) + i, short: short(id) + i }));
const race = new EnduranceRace({ track, teams: entries, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed });
race.start();
for (const c of race.cars) race.fitTyres(c, 'hard', true);
for (const e of race.entries) e.strategist.decide = () => null;
for (const c of race.cars) c.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (laps + 1);

// ORACLE drivers: options applied, update timed.
const mine = new Map(), times = [];
const u0 = OracleDriver.prototype.update;
OracleDriver.prototype.update = function (car, ...x) {
  if (this.isShadow) return u0.call(this, car, ...x); // the driver's own rollouts: timed inside the real update
  const i = race.cars.indexOf(car);
  if (!mine.has(i)) { Object.assign(this.options, opts); mine.set(i, this); }
  const t = performance.now(), r = u0.call(this, car, ...x); times.push(performance.now() - t); return r;
};
const name = (i) => `${ids[i]}${i}`;
const lines = [];
const snap = (i, j) => {
  const d = mine.get(i), c = race.cars[i], o = race.cars[j], r = d?.combat?.rivals.get(o.id);
  return `${name(i)} ${d?.mode ?? '-'} lane ${(d?.lateral ?? 0).toFixed(1)} e ${(d?.loc?.e ?? 0).toFixed(1)} v ${c.speed.toFixed(1)} | ${name(j)} gap ${r?.gap?.toFixed(1) ?? '?'} e ${r?.e?.toFixed(1) ?? '?'} edot ${r?.edot?.toFixed(1) ?? '?'} v ${o.speed.toFixed(1)} thr/brk ${(c.controls.throttle).toFixed(2)}/${c.controls.brake.toFixed(2)}`;
};
// Contacts: read the pairs the physics reported before the stewards clear them.
const step0 = race.stewards.step.bind(race.stewards);
race.stewards.step = (dt) => {
  for (const [a, b, closing] of race.stewards.pairs) {
    if (!mine.has(a) && !mine.has(b)) continue;
    if (closing < 1.5) continue;
    const [i, j] = mine.has(a) ? [a, b] : [b, a];
    lines.push(`t ${race.time.toFixed(1)} L${race.cars[i].race.lap} s ${(mine.get(i).loc?.s ?? 0).toFixed(0)} CONTACT ${closing.toFixed(1)} m/s ${closing > 3.5 ? 'HEAVY ' : ''}| ${snap(i, j)}`);
  }
  return step0(dt);
};

let prev = null, tick = 0;
const cap = 140 * laps * Math.max(1, track.length / 3000) + 200;
while (race.phase !== 'finished' && race.time < cap) {
  race.step(FIXED_DT);
  if (mine.has(tCar) && race.time >= tFrom && race.time <= tTo && tick % 6 === 0) {
    const d = mine.get(tCar), t = d.trace ?? {}, c = race.cars[tCar], f = d.combat?.target;
    console.log(`${race.time.toFixed(2)} s ${d.loc?.s.toFixed(0)} ${d.mode} lane ${d.lateral.toFixed(1)} e ${t.e?.toFixed(1)} v ${t.v?.toFixed(1)} vNow ${t.vNow?.toFixed(1)} vAhead ${t.vAhead?.toFixed(1)} cap ${Number.isFinite(t.cap) ? t.cap.toFixed(1) : '-'} beta ${t.beta?.toFixed(2)} slide ${t.slide?.toFixed(2)} st ${c.controls.steer.toFixed(2)} thr ${c.controls.throttle.toFixed(2)} brk ${c.controls.brake.toFixed(2)} grip ${t.grip?.toFixed(3)}${f ? ` focus ${f.id} ${f.gap.toFixed(1)}` : ''}`);
  }
  if (race.formation || ++tick % 12) continue;
  const ord = race.order().map((c) => race.cars.indexOf(c)), pos = new Array(ord.length); ord.forEach((ci, p) => { pos[ci] = p; });
  if (prev) for (const i of mine.keys()) if (pos[i] > prev[i]) {
    const by = ord[pos[i] - 1];
    lines.push(`t ${race.time.toFixed(1)} L${race.cars[i].race.lap} s ${(mine.get(i).loc?.s ?? 0).toFixed(0)} LOST P${prev[i] + 1}->P${pos[i] + 1} | ${snap(i, by)}`);
  }
  prev = pos;
}
for (const l of lines) console.log(l);
const ord = race.order();
console.log('\nresult', race.cars.map((c, i) => ({ c, i })).sort((a, b) => ord.indexOf(a.c) - ord.indexOf(b.c)).map(({ c, i }) => {
  const st = race.stewards.of(race.entries[i]); return `${name(i)}(g${i + 1} i${st.inc} d${(c.damage * 100).toFixed(0)} b${c.race.bestLap?.toFixed(2)})`;
}).join(' '));
for (const i of mine.keys()) { const st = race.stewards.of(race.entries[i]); console.log(name(i), 'incidents', JSON.stringify(st.log.map((l) => `${l.time.toFixed(0)}:${l.kind}:${l.points}`))); }
times.sort((a, b) => a - b);
console.log(`ORACLE update ms: median ${times[times.length >> 1]?.toFixed(3)} p99 ${times[Math.floor(times.length * 0.99)]?.toFixed(3)} max ${times[times.length - 1]?.toFixed(3)} (n ${times.length})`);
