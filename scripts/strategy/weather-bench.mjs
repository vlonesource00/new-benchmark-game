// Weather strategy bench: an AI field (two cars per AI) races `--laps` laps in changeable weather, strategists on,
// and every pit stop is booked with its reason. Per weather seed: stops per car (weather ones apart), mean race
// time per lap, and how close the road outlook's forecast came to the racing-line wetness that then happened
// (+1, +3 and +6 minutes). --old turns the outlook off (the strategists fall back to the road as it is now).
//   node --import ./scripts/json-loader.mjs scripts/strategy/weather-bench.mjs [--seeds 1,2,3] [--laps 20]
//        [--track harbor-ring] [--weather changeable] [--cls lmdh] [--ais razor,tempest,next-racer,apex] [--old]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
import { RoadOutlook } from '../../game/core/road-outlook.js';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const seeds = flag('seeds', '1,2,3').split(',').map(Number), laps = Number(flag('laps', 20)), trackName = flag('track', 'harbor-ring');
const weather = flag('weather', 'changeable'), cls = flag('cls', 'lmdh'), ais = flag('ais', 'razor,tempest,next-racer,apex').split(','), old = args.includes('--old');
const f = (x, n = 1) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(n));
const tot = { stops: 0, wx: 0, cars: 0, pace: 0, err: [0, 0, 0], nErr: 0 };
for (const seed of seeds) {
  const track = new Track(trackName), ids = ais.flatMap((id) => [id, id]);
  const teams = ids.map((id, i) => ({ id: 'e' + i, name: id + i, short: id.slice(0, 3) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3) }], grid: i }));
  const lap0 = track.length / (cls === 'lmdh' ? 50 : 42);
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps, startType: 'rolling', seed, weatherSeed: seed, weather, weatherSpan: 35 + laps * lap0 * 1.03 });
  if (old) race.outlook.forecast = () => null;
  race.start();
  const stops = new Map(), checks = [], probe = new RoadOutlook({ track, weather: race.weather, line: race.lineFor({ classId: cls }) });
  const o0 = race.log.bind(race);
  race.log = (kind, e, text) => { if (kind === 'strategy' && e && text.includes('BOX THIS LAP')) { const s = stops.get(e.car.id) ?? []; s.push(text.split('·').pop().trim()); stops.set(e.car.id, s); } return o0(kind, e, text); };
  let nextCheck = 60;
  while (race.phase !== 'finished' && race.time < laps * lap0 * 2.2) {
    race.step(FIXED_DT);
    if (!old && race.time >= nextCheck) { nextCheck += 60; const fc = race.outlook.forecast(race.time); if (fc) checks.push({ t: race.time, p: [12, 36, 72].map((q) => fc.wet[Math.min(q, fc.wet.length - 1)]) }); }
    for (const c of checks) if (!c.a) { c.a = []; } else if (c.a.length < 3) { const due = c.t + [60, 180, 360][c.a.length]; if (race.time >= due) c.a.push(probe.lineWet(probe.sample())); }
  }
  const cars = race.cars, done = cars.filter((c) => c.race.finishTime != null && c.race.finishLaps > 0);
  const pace = done.reduce((a, c) => a + c.race.finishTime / c.race.finishLaps, 0) / Math.max(1, done.length);
  const all = [...stops.values()], nStops = all.reduce((a, s) => a + s.length, 0), nWx = all.reduce((a, s) => a + s.filter((r) => /SLICK|INTERMEDIATE|WET/.test(r)).length, 0);
  const err = [0, 1, 2].map((q) => { const v = checks.filter((c) => c.a?.length > q); return v.length ? v.reduce((a, c) => a + Math.abs(c.p[q] - c.a[q]), 0) / v.length : NaN; });
  console.log(`seed ${seed} ${trackName} ${weather} ${laps}L ${old ? 'OLD' : 'outlook'} · stops/car ${f(nStops / cars.length, 2)} (weather ${f(nWx / cars.length, 2)}) · s/lap ${f(pace, 2)} · forecast |err| +1m ${f(err[0], 3)} +3m ${f(err[1], 3)} +6m ${f(err[2], 3)}`);
  for (const c of cars) console.log(`   ${c.team.short.padEnd(6)} laps ${c.race.finishLaps ?? '-'} t ${f(c.race.finishTime)} dmg ${f(c.damage * 100, 0)}% stops ${(stops.get(c.id) ?? []).join(' | ')}`);
  tot.stops += nStops; tot.wx += nWx; tot.cars += cars.length; tot.pace += pace;
  if (!old) { tot.err = tot.err.map((x, q) => x + (err[q] || 0)); tot.nErr++; }
}
console.log(`TOTAL ${old ? 'OLD' : 'outlook'} stops/car ${f(tot.stops / tot.cars, 2)} weather ${f(tot.wx / tot.cars, 2)} · mean s/lap ${f(tot.pace / seeds.length, 3)}${tot.nErr ? ` · forecast err ${tot.err.map((x) => f(x / tot.nErr, 3)).join('/')}` : ''}`);
