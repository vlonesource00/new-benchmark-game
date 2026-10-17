// Telemetry of any AI's solo laps, read only from the car (speed, lateral acceleration, road position), never from
// its code: per 20 m of the lap, and the peak lateral acceleration it uses at each speed against ORACLE's envelope.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/observe.mjs <ai> [cls] [track] [laps] [compound] [out.json] [oracle json-options]
import { writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { envelope, at } from '../src/envelope.js';
import { createOracleBridge } from '../../../game/bridges/oracle-bridge.js';

const [ai = 'razor', cls = 'gt', trackName = 'harbor-ring', lapsArg = '3', compound = 'hard', out = '', opts = ''] = process.argv.slice(2);
const laps = Number(lapsArg), track = new Track(trackName), BIN = 20, nb = Math.ceil(track.length / BIN);
const teams = [{ id: 'o', name: 'O', short: 'O', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 }];
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: laps + 2, startCompound: compound,
  ...(ai === 'oracle' && opts ? { makeBridge: (d, i, r) => createOracleBridge({ hostTrack: r.track, index: i, options: JSON.parse(opts) }) } : {}) });
race.start(); race.fitTyres(race.cars[0], compound, true);
for (const x of race.entries) x.strategist.decide = () => null;
const c = race.cars[0], times = [];
let lap = c.race.lap, bins = null, last = null;
const peak = new Float64Array(101), temps = [];
while (c.race.lap <= laps && race.time < 200 * laps) {
  race.step(FIXED_DT);
  if (c.race.lap !== lap) { if (Number.isFinite(c.race.lastLap)) times.push(`${c.race.lastLap.toFixed(2)}${c.race.lastState === 'red' ? '!' : ''}`); lap = c.race.lap; if (lap === laps) { last = bins; bins = Array.from({ length: nb }, () => ({ n: 0, v: 0, lat: 0, ay: 0, thr: 0, brk: 0 })); } }
  if (c.race.lap >= 2) { const b = Math.min(100, Math.round(c.speed)); peak[b] = Math.max(peak[b], Math.abs(c.ay)); }
  if (Math.round(race.time * 120) % (120 * 20) === 0) if (race.time > 1) temps.push(`${race.time.toFixed(0)}s ${c.wheels.map((w) => w.tyre.core.toFixed(0)).join("/")} w${c.wheels.map((w) => (w.tyre.wear * 100).toFixed(0)).join("/")}`);
  if (!bins) continue;
  const p = track.nearest(c.x, c.z), x = bins[Math.floor(((p.s % track.length) + track.length) % track.length / BIN) % nb];
  x.n++; x.v += c.speed; x.lat += p.lateral; x.ay = Math.max(x.ay, Math.abs(c.ay)); x.thr += c.controls.throttle; x.brk += c.controls.brake;
}
const env = envelope(cls);
console.log(`${ai} ${cls} ${trackName} ${compound} laps ${times.join(' ')}`);
console.log('peak |ay| by speed (m/s: used / ORACLE envelope):', [20, 25, 30, 35, 40, 45, 50, 55, 60].map((v) => `${v}: ${Math.max(...peak.slice(v - 2, v + 3)).toFixed(1)}/${at(env.lat, v).toFixed(1)}`).join('  '));
const prof = bins.map((x) => (x.n ? { v: +(x.v / x.n).toFixed(2), lat: +(x.lat / x.n).toFixed(2), ay: +x.ay.toFixed(1), thr: +(x.thr / x.n).toFixed(2), brk: +(x.brk / x.n).toFixed(2) } : null));
console.log('tyre core FL/FR/RL/RR:', temps.join('  '));
if (out) writeFileSync(out, JSON.stringify({ ai, cls, track: track.id, bin: BIN, prof }));
