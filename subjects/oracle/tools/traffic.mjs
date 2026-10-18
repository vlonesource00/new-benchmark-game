// Traffic audit: how well an AI gets through slower cars. Two cars of the AI under test start at the back of a
// rolling field of six slower cars (mixed AIs held under a pace governor at 92-97%, of the same class or of a slower
// one), and every metric is read off the cars themselves, so ORACLE and INTERCEPT are judged on identical terms:
//   time  - race time for the distance (lower is better: the whole cost of the traffic)
//   stuck - seconds spent within 25 m behind a slower car in its lane (the "stuck under it" the eye sees)
//   pass  - places made on track; inc / dmg / hits - stewards' points, damage, contacts closing > 1.5 m/s
//   lift  - seconds off the throttle (< 0.7, no brake) beside a car (within a car's length, a car's width apart) where
//           its line runs faster than it is going; liftCap - the part of it the follow cap asked for
// Defence ({"defend": k}): the two cars under test start at the front held to k of their pace, the six others behind
// at full pace; places lost on track (lost) is then the measure.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/traffic.mjs <ai> [cls] [trafficCls] [track] [laps] [seed] [json-options]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { OracleDriver } from '../src/driver.js';
import { jsonArg } from './bench.mjs';

const [ai = 'oracle', cls = 'gt', tcls = cls, trackName = 'harbor-ring', lapsArg = '4', seedArg = '1', optsArg = '{}'] = process.argv.slice(2);
const laps = Number(lapsArg), seed = Number(seedArg), track = new Track(trackName), opts = jsonArg(optsArg);
const pool = ['intercept', 'solstice', 'next-racer', 'claude-revolution', 'razor', 'apex'], ks = [0.97, 0.95, 0.93, 0.96, 0.92, 0.94];
const rot = (a, n) => a.map((_, i) => a[(i + n) % a.length]);
const others = rot(pool, seed).map((id, i) => ({ id, k: opts.defend ? 1 : rot(ks, seed * 2)[i], cls: tcls })), mine = [{ id: ai, k: opts.defend ?? 1, cls }, { id: ai, k: opts.defend ?? 1, cls }];
const field = opts.defend ? mine.concat(others) : others.concat(mine);
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = field.map((f, t) => ({ id: 't' + t, name: short(f.id) + t, short: short(f.id) + t, color: '#fff', index: t, grid: t, starter: 0, classId: f.cls, raceClass: f.cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: [{ kind: 'ai', id: f.id, name: f.id, short: short(f.id) }] }));
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed, caution: 'off' });
race.start();
for (const c of race.cars) race.fitTyres(c, 'hard', true);
for (const e of race.entries) e.strategist.decide = () => null;
for (const c of race.cars) c.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (laps + 1);
field.forEach((f, i) => { race.entries[i].governor.base = f.k; });
const subj = opts.defend ? [0, 1] : [6, 7];
if (ai === 'oracle') {
  const u0 = OracleDriver.prototype.update, seen = new Set();
  OracleDriver.prototype.update = function (car, ...x) { if (!this.isShadow && !seen.has(this)) { seen.add(this); Object.assign(this.options, opts); } return u0.call(this, car, ...x); };
}
const M = subj.map(() => ({ stuck: 0, hits: 0, heavy: 0, pass: 0, lost: 0 }));
const step0 = race.stewards.step.bind(race.stewards);
race.stewards.step = (dt) => {
  for (const [a, b, closing] of race.stewards.pairs) for (const [k, i] of subj.entries()) if ((a === i || b === i) && closing > 1.5) {
    M[k].hits++; if (closing > 3.5) M[k].heavy++;
    if (opts.log) {
      const j = a === i ? b : a, d = race.entries[i].bridges[0]?.driver, cb = d?.combat, r = cb?.rivals.get(race.cars[j].id), c = race.cars[i], o = race.cars[j];
      console.log(`t ${race.time.toFixed(1)} ${ai}${k} x ${field[j]?.id}${j} ${closing.toFixed(1)} m/s | s ${d?.loc?.s.toFixed(0)} ${d?.mode} ${cb?.mv?.kind ?? ''}${cb?.mv?.kind === 'MOVE' ? (cb.mv.dive ? ' dive' : ' pull') : ''} lane ${(d?.lateral ?? 0).toFixed(1)} e ${(d?.loc?.e ?? 0).toFixed(1)} v ${c.speed.toFixed(1)} thr ${c.controls.throttle.toFixed(2)} brk ${c.controls.brake.toFixed(2)} | them gap ${r?.gap?.toFixed(1)} e ${r?.e?.toFixed(1)} v ${o.speed.toFixed(1)} brk ${o.controls.brake.toFixed(2)} capBy ${cb?.capBy ? race.cars.indexOf(cb.capBy.r.car) : '-'} free ${cb?.free}`);
    }
  }
  return step0(dt);
};
let tick = 0, prev = null;
const cap = 140 * laps * Math.max(1, track.length / 3000) + 200, L = track.length;
while (race.phase !== 'finished' && race.time < cap && !subj.every((i) => race.cars[i].race.finishTime !== null)) {
  race.step(FIXED_DT);
  if (race.formation || ++tick % 6) continue;
  // trace: [t0, t1] prints the first subject car every 0.1 s in that window (state, pedals, cap, its target).
  if (opts.trace && race.time >= opts.trace[0] && race.time <= opts.trace[1] && tick % 12 === 0) {
    const d = race.entries[subj[0]].bridges[0]?.driver, cb = d?.combat, c = race.cars[subj[0]], T = cb?.mv?.id != null ? [...cb.rivals.values()].find((r) => r.car.id === cb.mv.id) : cb?.capBy?.r;
    console.log(`tr ${race.time.toFixed(1)} s ${d?.loc?.s.toFixed(0)} ${d?.mode} ${cb?.mv?.kind} e ${(d?.loc?.e ?? 0).toFixed(1)} lane ${(d?.lateral ?? 0).toFixed(1)} v ${c.speed.toFixed(1)} thr ${c.controls.throttle.toFixed(2)} brk ${c.controls.brake.toFixed(2)} catch ${d?.catching ? 1 : 0} pd ${d?.pd ? [d.pd.vNow, d.pd.vAhead, d.pd.want, d.pd.need, d.pd.laneL, d.pd.lfL].map((x) => x.toFixed(2)).join('/') : '-'} lv ${d?.loc ? d.line.sample(d.line.v, d.loc.i, d.loc.f).toFixed(1) : '-'} k ${d?.loc ? (d.line.sample(d.line.k, d.loc.i, d.loc.f) * 1000).toFixed(1) : '-'} cap ${cb?.cap?.toFixed?.(1) ?? '-'} capBy ${cb?.capBy ? race.cars.indexOf(cb.capBy.r.car) : '-'} | T ${T ? race.cars.indexOf(T.car) : '-'} gap ${T?.gap?.toFixed(1)} e ${T?.e?.toFixed(1)} v ${T?.car.speed.toFixed(1)}`);
  }
  const at = race.cars.map((c) => { const n = track.nearest(c.x, c.z); return { s: n.s, l: n.lateral }; });
  subj.forEach((i, k) => {
    const me = race.cars[i]; if (me.race.finishTime !== null) return;
    const d = race.entries[i].bridges[0]?.driver;
    if (d?.catching) { const w = d.combat?.mv?.kind === 'MOVE' ? 'catchMv' : 'catchLn'; M[k][w] = (M[k][w] ?? 0) + 6 * FIXED_DT; }
    if (d?.loc && me.controls.throttle < 0.7 && me.controls.brake < 0.05 && me.speed < d.line.sample(d.line.v, d.loc.i, d.loc.f) - 2) {
      const beside = race.cars.some((c, j) => { if (j === i) return false; const ds = ((at[j].s - at[i].s) % L + L * 1.5) % L - L / 2; return Math.abs(ds) < 6 && Math.abs(at[j].l - at[i].l) > 2.1 && Math.abs(at[j].l - at[i].l) < 5; });
      if (beside) { M[k].lift = (M[k].lift ?? 0) + 6 * FIXED_DT; if (d.combat?.capBy) { const cb = d.combat, w = cb.capBy.r.gap < 5.06 + 1 ? 'liftAlong' : cb.mv?.kind === 'MOVE' && cb.mv.id === cb.capBy.r.car.id ? 'liftTgt' : 'liftAhead'; M[k].liftCap = (M[k].liftCap ?? 0) + 6 * FIXED_DT; M[k][w] = (M[k][w] ?? 0) + 6 * FIXED_DT; } }
    }
    for (let j = 0; j < race.cars.length; j++) {
      if (j === i) continue;
      const ds = ((at[j].s - at[i].s) % L + L * 1.5) % L - L / 2;
      if (ds > 5 && ds < 25 && Math.abs(at[j].l - at[i].l) < 2.6 && race.entries[j].governor.base < 0.999 && !subj.includes(j)) {
        M[k].stuck += 6 * FIXED_DT;
        const cb = race.entries[i].bridges[0]?.driver?.combat; if (cb) { const w = cb.free ? 'free' : 'corner'; M[k][w] = (M[k][w] ?? 0) + 6 * FIXED_DT; }
        break;
      }
    }
  });
  const ord = race.order().map((c) => race.cars.indexOf(c)), pos = []; ord.forEach((ci, p) => { pos[ci] = p; });
  if (prev) subj.forEach((i, k) => { if (pos[i] < prev[i]) M[k].pass += prev[i] - pos[i]; if (pos[i] > prev[i]) M[k].lost += pos[i] - prev[i]; });
  prev = pos;
}
const ord = race.order();
if (opts.fcAudit) subj.forEach((i, k) => { const fa = race.entries[i].bridges[0]?.driver?.combat?.fa; if (fa) for (const [key, b] of Object.entries(fa.k)) console.log(`fa ${ai}${k} ${key} n ${b.n} fc ${(b.fc / b.n).toFixed(2)} hold ${(b.hold / b.n).toFixed(2)} path ${(b.path / b.n).toFixed(2)}`); });
if (opts.mvLog) subj.forEach((i, k) => { for (const e of race.entries[i].bridges[0]?.driver?.combat?.mv?.ev ?? []) console.log(`ev ${ai}${k} ${e}`); });
subj.forEach((i, k) => {
  const c = race.cars[i], st = race.stewards.of(race.entries[i]), t = c.race.finishTime;
  console.log(`${ai}${k} P${ord.indexOf(c) + 1} time ${t != null ? t.toFixed(2) : 'DNF'} stuck ${M[k].stuck.toFixed(1)} pass ${M[k].pass} lost ${M[k].lost} inc ${st.inc} dmg ${(c.damage * 100).toFixed(1)} hits ${M[k].hits} heavy ${M[k].heavy} best ${c.race.bestLap?.toFixed(2)} lift ${(M[k].lift ?? 0).toFixed(1)} liftCap ${(M[k].liftCap ?? 0).toFixed(1)} liftAlong ${(M[k].liftAlong ?? 0).toFixed(1)} liftTgt ${(M[k].liftTgt ?? 0).toFixed(1)} liftAhead ${(M[k].liftAhead ?? 0).toFixed(1)} catchMv ${(M[k].catchMv ?? 0).toFixed(1)} catchLn ${(M[k].catchLn ?? 0).toFixed(1)}${M[k].free != null || M[k].corner != null ? ` stuckFree ${(M[k].free ?? 0).toFixed(1)} stuckCorner ${(M[k].corner ?? 0).toFixed(1)}` : ''}${race.entries[i].bridges[0]?.driver?.combat?.mv ? ' mv ' + JSON.stringify(race.entries[i].bridges[0].driver.combat.mv.n) : ''}`);
});
