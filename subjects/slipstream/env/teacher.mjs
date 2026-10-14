// Teacher data: INTERCEPT driving alone, seen through SLIPSTREAM's own observation (contract v2) at its decision cadence.
// Each row is what SLIPSTREAM would observe in INTERCEPT's seat, and the controls INTERCEPT applied over the following
// decision interval (4 physics substeps), mapped to SLIPSTREAM's action [steer, pedal = throttle - brake].
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/teacher.mjs <track> <seconds> <out-name> [seed] [driver]
// driver: any game AI id (default intercept); 'slipstream' records the deployed bridge (policy/slipstream.json), so a
// specialist export swapped in there becomes a teacher the generalist can match exactly (distillation).
// Writes runs/teacher/<out-name>.bin: Float32 rows [obs (OBS) | steer, pedal | s | clean] and <out-name>.json (meta).
// clean = 0 on decisions during which INTERCEPT broke track limits, took damage, went off, or was planning or making a
// pit stop (its race strategy pits; a pit-lane approach is not a racing line). Not imitated.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRaceEnv } from './race-env.mjs';
import { observe, roadTable, OBS } from './observe.mjs';

const [track = 'harbor-ring', seconds = 400, name = track, seed = 7, driver = 'intercept'] = process.argv.slice(2);
const env = createRaceEnv({ track, seats: [{ ai: driver }], seed: Number(seed), startType: 'standing' });
if (driver === 'slipstream') await new Promise((r) => setTimeout(r, 1500)); // bridge weights load asynchronously
const race = env.race, car = env.cars[0], trk = env.track, road = roadTable(trk);
const limit = trk.halfWidth + (trk.curbWidth ?? 0), W = OBS + 4, SUB = 4, SKIP = 8 * 30;
const iface = { applied: [0, 0], appliedAge: 0, sent: [0, 0], pending: 0 };
const rows = [], o = new Float32Array(OBS), lapTimes = [], entry = race.entries[0];
let lap = car.race.lap;
const pedal = () => (car.controls?.throttle ?? 0) - (car.controls?.brake ?? 0);
for (let k = 0; k < Number(seconds) * 30; k++) {
  observe(o, { car, road, track: trk, limit, cars: race.cars, learnerIds: [], iface });
  const off0 = car.race.offtrack ?? 0, dmg0 = car.damage;
  let st = 0, pd = 0;
  for (let i = 0; i < SUB; i++) { env.step(1); st += car.controls?.steer ?? 0; pd += pedal(); }
  st /= SUB; pd /= SUB;
  const pit = Boolean(entry.pit || entry.pitPlan);
  const clean = !pit && (car.race.offtrack ?? 0) === off0 && car.damage === dmg0 && car.zone !== 'gravel' && car.zone !== 'grass';
  if (car.race.lap !== lap) { lapTimes.push(+(car.race.lastLap ?? 0).toFixed(3)); lap = car.race.lap; }
  if (k >= SKIP && race.phase === 'racing') { const r = new Float32Array(W); r.set(o); r[OBS] = st; r[OBS + 1] = pd; r[OBS + 2] = car.s; r[OBS + 3] = clean ? 1 : 0; rows.push(r); }
  // What the student's interface features would show next decision had it sent these controls.
  iface.applied = [st, pd]; iface.sent = [st, pd]; iface.appliedAge = SUB / 120;
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', 'teacher');
mkdirSync(dir, { recursive: true });
const buf = new Float32Array(rows.length * W); rows.forEach((r, i) => buf.set(r, i * W));
writeFileSync(join(dir, `${name}.bin`), Buffer.from(buf.buffer));
const laps = car.race.lap, clean = rows.filter((r) => r[OBS + 3] === 1).length;
writeFileSync(join(dir, `${name}.json`), JSON.stringify({ track, seed: Number(seed), driver, obs: OBS, width: W, rows: rows.length, clean, laps, lapTimes }));
console.log(JSON.stringify({ track, seed: Number(seed), rows: rows.length, clean, lapTimes }));
