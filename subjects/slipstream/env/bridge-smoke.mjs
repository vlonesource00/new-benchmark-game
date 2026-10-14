// The game-side SLIPSTREAM bridge (game/bridges/slipstream-bridge.js) driving the real race headless.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/bridge-smoke.mjs [track] [seconds] [rivals,comma,separated]
import { createRaceEnv } from './race-env.mjs';
const [track = 'alpine', seconds = 150, rivals = ''] = process.argv.slice(2);
const env = createRaceEnv({ track, seats: [{ ai: 'slipstream' }, ...rivals.split(',').filter(Boolean).map((ai) => ({ ai }))], startType: 'standing' });
await new Promise((r) => setTimeout(r, 1500)); // weights load asynchronously
const car = env.cars[0], laps = [];
let lap = car.race.lap;
for (let k = 0; k < seconds * 30; k++) {
  env.step(4);
  if (car.race.lap !== lap) { laps.push({ lap, time: +(car.race.lastLap ?? 0).toFixed(3) }); lap = car.race.lap; }
}
const b = env.race.entries[0].bridges[env.race.entries[0].active];
console.log(JSON.stringify({ track, simS: +env.race.time.toFixed(1), laps, offtrack: +(car.race.offtrack ?? 0).toFixed(2), damage: +car.damage.toFixed(3), errors: b.errors, lastError: b.lastError }));
