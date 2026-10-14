// Reference pace: best clean solo lap of each real AI per track, in the real race loop (GT class, clear).
//   node ref-laps.mjs [laps=4] [tracks...]
import { createRaceEnv } from './race-env.mjs';
const args = process.argv.slice(2), laps = +(args[0] ?? 4);
const tracks = args.length > 1 ? args.slice(1) : ['harbor-ring', 'solenne', 'alpine', 'desert', 'nurburgring'];
for (const track of tracks) {
  const row = { track };
  for (const ai of ['apex', 'intercept', 'razor']) {
    const env = createRaceEnv({ track, seats: [{ ai }], seed: 7 });
    const c = env.cars[0];
    while (c.race.lap <= laps && env.race.time < laps * 700) env.step(4);
    row[ai] = c.race.bestLap == null ? null : +c.race.bestLap.toFixed(3);
  }
  console.log(JSON.stringify(row));
}
