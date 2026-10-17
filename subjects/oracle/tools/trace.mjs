// Solo trace of any AI through the real race loop: speed, lateral acceleration and position per 10 m.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/trace.mjs <ai> <gt|lmdh> [track] [laps]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';

const [ai = 'intercept', cls = 'gt', trackName = 'harbor-ring', laps = '3', compound = 'soft', opts = '{}'] = process.argv.slice(2);
import { createOracleBridge } from '../../../game/bridges/oracle-bridge.js';
const track = new Track(trackName);
const teams = [{ id: 't', name: 'T', short: 'T', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 }];
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: Math.max(12, Number(laps) + 2), startCompound: compound,
  makeBridge: (d, i, r) => d.id === 'oracle' ? createOracleBridge({ hostTrack: r.track, index: i, options: JSON.parse(opts) }) : createSeatBridge(d, i, r) });
race.start(); race.fitTyres(race.cars[0], compound);
const c = race.cars[0], BIN = Number(process.env.BIN ?? 10), n = Math.ceil(track.length / BIN), rows = [];
let lap = c.race.lap, bins = null;
while (c.race.lap <= Number(laps) && race.time < 3000) {
  race.step(FIXED_DT);
  if (c.race.lap !== lap) { if (bins && lap >= 2) rows.push({ lap, time: c.race.lastLap, bins }); lap = c.race.lap; bins = Array.from({ length: n }, () => [0, 0, 0, 0]); }
  if (bins) { const p = track.nearest(c.x, c.z), b = bins[Math.floor(p.s / BIN) % n]; b[0] += c.speed; b[1] = Math.max(b[1], Math.abs(c.ay)); b[2] += p.lateral; b[3]++; b[4] = (b[4] ?? 0) + c.x; b[5] = (b[5] ?? 0) + c.z; }
}
console.log(`${ai} ${cls} ${trackName} laps ${rows.map((r) => r.time.toFixed(2)).join(' ')}`);
const best = rows.reduce((a, r) => (!a || r.time < a.time ? r : a), null);
if (best && process.env.PATH_OUT) (await import('node:fs')).writeFileSync(process.env.PATH_OUT, JSON.stringify(best.bins.filter((b) => b[3]).map((b) => [b[4] / b[3], b[5] / b[3], b[0] / b[3]])));
if (best) console.log(best.bins.map((b, i) => `${i * BIN}:${(b[0] / Math.max(1, b[3])).toFixed(0)}/${b[1].toFixed(0)}/${(b[2] / Math.max(1, b[3])).toFixed(1)}`).join(' '));
