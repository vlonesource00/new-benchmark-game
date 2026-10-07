// A rival's own racing line, measured: one architecture driving alone through the real EnduranceRace loop. Per 3 m station it
// records the mean lateral offset and speed over the flying laps (laps 2..N), which is what the combat planner predicts a rival
// of that architecture to do (turn-in points, braking points, line). Prints one JSON line.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/rivalprofile.mjs <ai> <lmdh|gt> <track> [laps=4] [compound=medium]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';

const [ai = 'next-racer', cls = 'lmdh', trackName = 'harbor-ring', laps = '4', compound = 'medium'] = process.argv.slice(2);
const n = Number(laps), track = new Track(trackName), N = Math.round(track.length / 3), ds = track.length / N;
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: compound, makeBridge: (d, i, r) => createSeatBridge(d, i, r) });
race.start(); race.fitTyres(race.cars[0], compound);
const e = race.entries[0], c = race.cars[0]; e.strategist.decide = () => null;
const sl = new Float64Array(N), sv = new Float64Array(N), cnt = new Float64Array(N), tMax = Math.max(400, track.length / 6) * n;
while (c.race.lap <= n && race.time < tMax) {
  race.step(FIXED_DT);
  if (c.race.lap >= 2 && c.race.lap <= n) { const i = Math.floor(((c.s % track.length) + track.length) % track.length / ds) % N; sl[i] += c.lateral; sv[i] += c.speed; cnt[i]++; }
}
const lat = [], v = []; let last = { l: 0, v: 30 };
for (let i = 0; i < N; i++) { if (cnt[i] > 0) last = { l: sl[i] / cnt[i], v: sv[i] / cnt[i] }; lat.push(+last.l.toFixed(2)); v.push(+last.v.toFixed(1)); }
console.log(JSON.stringify({ ai, cls, track: trackName, N, ds, laps: n, lat, v, best: c.race.bestLap ?? null }));
