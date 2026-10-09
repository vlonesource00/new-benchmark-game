// TEMPEST in a field: where does it lose speed? Same field as tempest-field.mjs. For each TEMPEST car, integrates the
// speed shortfall against its own racing-line profile by planner state and by what limited the target, and prints
// a short timeline around the biggest losses.
// usage: node --import ./scripts/json-loader.mjs scripts/bench/tempest-trace.mjs track laps seed weather cls ais [optsJSON]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
import { AI_DRIVERS } from '../../game/core/teams.js';
const [trackName = 'harbor-ring', lapsArg = '3', seedArg = '7', weather = 'clear', cls = 'lmdh', aisArg = 'tempest,razor,next-racer,apex', optsArg = '{}'] = process.argv.slice(2);
const laps = Number(lapsArg), seed = Number(seedArg), track = new Track(trackName), opts = JSON.parse(optsArg);
const ais = aisArg.split(','), last = ais.includes('apex') ? 'apex' : null, front = ais.filter((a) => a !== last);
const rot = seed % front.length, order = [...front.slice(rot), ...front.slice(0, rot), ...(last ? [last] : [])], ids = order.flatMap((id) => [id, id]);
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = order.map((id, t) => ({ id: 't' + t, name: short(id), short: short(id), color: '#fff', index: t, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: [{ kind: 'ai', id, name: id, short: short(id) }, { kind: 'ai', id, name: id, short: short(id) }], grid: t }));
const entries = ids.map((id, i) => ({ ...teams[Math.floor(i / 2)], id: 'e' + i, index: i, grid: i, name: short(id) + i, short: short(id) + i }));
const race = new EnduranceRace({ track, teams: entries, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps, startCompound: 'hard', startType: 'rolling', seed, weatherSeed: seed, weather });
race.start();
for (const c of race.cars) race.fitTyres(c, weather === 'rain' ? 'wet' : 'hard', true);
for (const e of race.entries) e.strategist.decide = () => null;
// Spearhead stops its search on a wall-clock budget; parallel bench jobs would make it (and the race) nondeterministic
  race.entries.forEach((e, i) => { const d = e.bridges[0]?.driver; if (!d) return; if (ids[i] === 'tempest') Object.assign(d.options, opts); if (ids[i] === 'next-racer' && d.o) d.o.planBudgetMs = Infinity; });
const mine = ids.map((id, i) => id === 'tempest' ? i : -1).filter((i) => i >= 0);
const acc = new Map(mine.map((i) => [i, { byState: {}, byLimit: {}, log: [] }]));
while (race.phase !== 'finished' && race.time < 140 * laps + 200) {
  race.step(FIXED_DT);
  if (race.formation) continue;
  for (const i of mine) {
    const br = race.entries[i].bridges[0], d = br.driver, c = race.cars[i]; if (!d?.line || !d.cur || !d.path) continue;
    const L = d.line, lv = L.v[d.cursor], loss = Math.max(0, lv - c.speed) / Math.max(10, lv) * FIXED_DT, a = acc.get(i);
    const st = d.intent, ctl = d.control, tgt = ctl.targetSpeed, pv = d.path.sample(d.path.v, d.c.i, d.c.f, c.speed * 0.1);
    const lim = ctl.guard ? 'guard' : tgt < pv - 1 ? (d.lastNose < pv - 1 ? 'nose' : 'plancap') : d.path !== L && pv < L.sample(L.v, d.cursor, 0, c.speed * 0.1) - 1 ? 'laneprofile' : ctl.stability < 0.9 ? 'stability' : 'none';
    a.byState[st] = (a.byState[st] ?? 0) + loss; a.byLimit[lim] = (a.byLimit[lim] ?? 0) + loss;
    if (Math.round(race.time / FIXED_DT) % 30 === 0) {
      const near = d.field.list.slice(0, 2).map((r) => `${ids[race.cars.findIndex((x) => x.id === r.id)]?.slice(0, 3)}${r.ds.toFixed(0)}/${(r.d - d.field.me.d).toFixed(1)}`).join(' ');
      a.log.push(`${race.time.toFixed(1)} L${c.race.lap} ${st.padEnd(7)} v${c.speed.toFixed(0)} line${lv.toFixed(0)} tgt${tgt.toFixed(0)} lane${pv.toFixed(0)} ${lim} stab${ctl.stability.toFixed(2)} | ${near}`);
    }
  }
}
const ord = race.order();
for (const i of mine) {
  const a = acc.get(i), c = race.cars[i];
  const f = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(', ');
  console.log(`TEMPEST car ${i} place ${ord.indexOf(c) + 1} best ${c.race.bestLap?.toFixed(2)} | loss by state: ${f(a.byState)} | by limit: ${f(a.byLimit)}`);
  const dr = race.entries[i].bridges[0].driver;
  console.log('  books', JSON.stringify(dr.arbiter.books()), 'recovers', dr.control.recovers);
  if (process.argv.includes('--log')) console.log(a.log.join('\n'));
}
console.log('places', race.cars.map((c, i) => `${ids[i].slice(0, 3)}${ord.indexOf(c) + 1}`).join(' '), 'contacts', race.contacts);
