// Game-faithful traffic gate: the deployed bridge (game/bridges/slipstream-bridge.js, weights from policy/slipstream.json)
// in the real race start (countdown, race fuel, start compound fitted cold) with rivals, from a chosen grid slot.
// The headless World tests start warm and never this way; this is the start a player sees.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/game-gate.mjs <track[,track]> <slot[,slot]> [rivals=intercept,apex | none] [laps=3]
// One JSON line per (track, slot): lap times with validity, off-track seconds per lap, damage, rivals' best laps.
import { createRaceEnv } from './race-env.mjs';
const [tracks, slots = '0', rivals = 'intercept,apex', lapsArg = 3] = process.argv.slice(2);
const want = +lapsArg;
for (const track of tracks.split(',')) for (const slot of slots.split(',').map(Number)) {
  const others = rivals === 'none' ? [] : rivals.split(',').filter(Boolean).map((ai) => ({ ai }));
  const seats = [...others.slice(0, slot), { ai: 'slipstream' }, ...others.slice(slot)];
  const env = createRaceEnv({ track, seats, startType: 'standing' });
  await new Promise((r) => setTimeout(r, 1500)); // weights load asynchronously
  const me = env.cars[slot], laps = [];
  let lap = me.race.lap, off0 = 0;
  const lapCap = Math.max(140, env.track.length / 40); // s per lap: 140 on the ~5 km tracks, ~630 on Nurburgring
  for (let k = 0; k < (want * lapCap + 30) * 30 && laps.length < want; k++) {
    env.step(4);
    if (me.race.lap !== lap) {
      const off = me.race.offtrack ?? 0;
      laps.push({ time: +(me.race.lastLap ?? 0).toFixed(3), valid: me.race.lastState !== 'red', off: +(off - off0).toFixed(2) });
      lap = me.race.lap; off0 = off;
    }
  }
  const b = env.race.entries[slot].bridges[env.race.entries[slot].active];
  console.log(JSON.stringify({ track, slot, laps, valid: laps.filter((l) => l.valid).length, damage: +me.damage.toFixed(3),
    rivalsBest: env.cars.filter((c) => c !== me).map((c) => c.race.bestLap && +c.race.bestLap.toFixed(3)), errors: b.errors }));
}
