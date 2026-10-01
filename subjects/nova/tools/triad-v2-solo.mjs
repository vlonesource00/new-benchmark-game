// Canonical one-car NOVA reference for station-matched traffic-time estimates.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve('../benchmark');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { Track } = await load('host/astra/src/sim/track.js');
const { Session } = await load('host/astra/src/sim/session.js');
const { createField, TRIAD_CANDIDATES } = await load('sandbox/bridges/index.js');
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt', mixed: false });
session.laps = 4;
session.field = 1;
session.cars = session.cars.slice(0, 1);
session.drivers = session.drivers.slice(0, 1);
const field = createField({ session, hostTrack: track, order: ['nova'], candidatesList: TRIAD_CANDIDATES });
session.start({ freshTrack: true });
field.attach(true);
session.phase = 'racing';
session.countdown = 0;
const car = session.cars[0];
const laps = new Map();
const dt = 1 / 120;
for (let tick = 0; tick < 600 / dt && car.race.finishTime === null; tick++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  if (tick % 12 !== 0) continue;
  const lap = car.race.lap;
  if (!laps.has(lap)) laps.set(lap, []);
  laps.get(lap).push({ s: car.s, speed: car.speed, t: session.time });
}
const candidates = [...laps].filter(([lap, samples]) => lap > 1 && samples.length > 200);
const chosen = candidates.sort((a, b) => (a[1].at(-1).t - a[1][0].t) -
  (b[1].at(-1).t - b[1][0].t))[0];
const binWidth = 5;
const count = Math.ceil(track.length / binWidth);
const speedBins = Array.from({ length: count }, () => []);
for (const sample of chosen?.[1] ?? []) speedBins[Math.floor(sample.s / binWidth) % count].push(sample.speed);
const means = speedBins.map(values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
for (let i = 0; i < count; i++) if (means[i] === null) {
  let left = 1, right = 1;
  while (means[(i - left + count) % count] === null && left < count) left++;
  while (means[(i + right) % count] === null && right < count) right++;
  const a = means[(i - left + count) % count], b = means[(i + right) % count];
  means[i] = (a * right + b * left) / (left + right);
}
const output = resolve('artifacts/triad-v2-solo.json');
mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(output, JSON.stringify({ trackLength: track.length, binWidth, speedBins: means,
  chosenLap: chosen?.[0], approximateLapTime: chosen && chosen[1].at(-1).t - chosen[1][0].t,
  bestLap: car.race.bestLap, offtrack: car.race.offtrack, contacts: session.contacts }));
console.log(JSON.stringify({ output, bestLap: car.race.bestLap,
  offtrack: car.race.offtrack, contacts: session.contacts }));
