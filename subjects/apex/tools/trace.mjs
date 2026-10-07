// Per-station telemetry of a flying lap for any AI: speed, lateral position, pedals, ay.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/trace.mjs <ai> <lmdh|gt> <track> [lap=2] [out.json] [json-options]
import { writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const [ai = 'apex', cls = 'lmdh', trackName = 'harbor-ring', lapArg = '2', out = null, opts = '{}'] = process.argv.slice(2);
const want = Number(lapArg), options = JSON.parse(opts), track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const makeBridge = (d, i, race) => d.id === 'apex' && Object.keys(options).length ? createApexBridge({ hostTrack: race.track, index: i, options, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race);
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge });
race.start(); race.fitTyres(race.cars[0], 'medium');
const c = race.cars[0], e = race.entries[0]; e.strategist.decide = () => null;
const BIN = 10, n = Math.ceil(track.length / BIN), rows = Array.from({ length: n }, () => ({ pv: 0, v: 0, c: 0, lat: 0, thr: 0, brk: 0, ay: 0, ax: 0, steer: 0, t: null }));
let tLap = null;
while (c.race.lap <= want && race.time < 3000) {
  race.step(FIXED_DT);
  if (c.race.lap === want) {
    if (tLap === null) tLap = race.time;
    const b = Math.min(n - 1, Math.floor(c.s / BIN)), r = rows[b];
    r.v += c.speed; r.pv += e.bridges[0].driver?.targetSpeed ?? 0; r.lat += c.lateral; r.thr += c.controls.throttle; r.brk += c.controls.brake; r.ay += c.ay; r.ax += c.ax; r.steer += c.controls.steer; r.c++;
    if (r.t === null) r.t = race.time - tLap;
  }
}
const o = rows.map((r) => (r.c ? { pv: +(r.pv / r.c).toFixed(2), v: +(r.v / r.c).toFixed(2), lat: +(r.lat / r.c).toFixed(2), thr: +(r.thr / r.c).toFixed(2), brk: +(r.brk / r.c).toFixed(2), ay: +(r.ay / r.c).toFixed(1), ax: +(r.ax / r.c).toFixed(1), steer: +(r.steer / r.c).toFixed(3), t: +r.t.toFixed(3) } : null));
if (out) writeFileSync(out, JSON.stringify({ ai, cls, track: trackName, lap: c.race.lastLap, bin: BIN, rows: o }));
console.log(ai, cls, trackName, 'lap', c.race.lastLap?.toFixed(3), 'bins', o.filter(Boolean).length);
