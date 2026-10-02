import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('subjects/solstice/results');
const read = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
const tracks = ['harbor-ring', 'solenne', 'alpine', 'desert'];
const rivals = ['phantom', 'phantom-v2', 'gemini-supreme-v4', 'solinator-6.1', 'astra'];
const n = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const rows = [];
for (const driver of rivals) for (const track of tracks) {
  const filename = `baseline-${driver}-${track}.json`;
  if (!existsSync(resolve(directory, filename))) continue;
  const r = read(filename), cars = r.results;
  const best = Math.min(...cars.map(c => c.bestCleanFlyingLap).filter(Number.isFinite));
  const medians = cars.map(c => c.medianCleanFlyingLap).filter(Number.isFinite);
  const laps = cars.reduce((sum, c) => sum + c.completedLaps, 0);
  rows.push(`| ${driver} | ${track} | ${n(best)} | ${n(mean(medians))} | ${n(cars.reduce((s, c) => s + c.offtrackSeconds, 0), 2)} | ${r.totalContacts} | ${n(mean(cars.map(c => c.meanTyreCoreC)), 1)} | ${n(cars.reduce((s, c) => s + c.cumulativeMaxWear, 0) / Math.max(1, laps), 3)} | ${n(cars.reduce((s, c) => s + c.fuelUsedLitres, 0) / Math.max(1, laps), 2)} | ${n(mean(cars.map(c => c.updateCpuMsPerSimulatedSecond)), 1)} |`);
}
const fullRows = [];
for (const prefix of ['homogeneous', 'fix-combat', 'mixed', 'fix-mixed']) for (const track of tracks) for (const seed of [7, 3, 19]) {
  const filename = `${prefix}-${track}-seed${seed}.json`;
  if (!existsSync(resolve(directory, filename))) continue;
  const r = read(filename);
  for (const c of r.results.filter(c => c.driver === 'solstice')) fullRows.push(`| [${prefix}, ${track}, seed ${seed}, car ${c.car}](results/${filename}) | ${c.position} / ${c.completedLaps} | ${n(c.gap, 2)} | ${n(c.bestCleanFlyingLap)} / ${n(c.medianCleanFlyingLap)} | ${n(c.offtrackSeconds, 2)} | ${c.impactEpisodes} / ${n(c.damage, 3)} | ${c.rescues} | ${c.stops} / ${c.swaps} | ${n(c.meanTyreCoreC, 1)} | ${n(c.fuelUsedLitres / Math.max(1, c.completedLaps), 2)} | ${n(c.cumulativeMaxWear / Math.max(1, c.completedLaps))} | ${n(c.governorActiveFraction * 100, 1)} |`);
}
const output = `# Measured results

**Acceptance remains incomplete.** No measured SOLSTICE lap meets Harbor's
64-second target. Current mixed races do not establish wins on all tracks over
three seeds. No claim is made that physics prevents the target.

## Conditions and metric definitions

Baselines use 150 racing seconds, four identical AI cars, six-lap sprint format,
GT class, medium starting compound, seed 7, clear weather, sun .6, ALIEN k=1,
and the game's fixed 1/120-second step. Every full race retains normal fuel,
wear, weather, governor, pit autopilot and mandatory driver swap.

Lap one begins timing at the first line crossing and is a full rolling timed
lap. Clean timed laps count; red and pit laps do not. A separate steady metric
excludes lap one. Baseline median below is the mean of available per-car clean
medians; it is not a pooled median. Fuel and maximum-wheel wear per completed
lap include the opening grid approach, pit travel, and race resource scaling.
Wear accumulates across tyre changes. These are operational race averages.

Contacts are global repeated contact-step events, not distinct incidents or
attributable per-car contacts. Impact episodes combine car-contact and barrier
signal crossings. They must not be reported as contacts per individual car-hour.
An optional field-normalized rate is totalContacts / (cars × seconds / 3600).
Finishing order follows the game's flag rules: a flagged lapped car can finish
with fewer completed laps, so a time gap alone does not establish equal distance.

Update cost is instrumented elapsed time around bridge calls, in ms per
simulated second per car. Concurrent measurements include scheduling noise;
they are not OS CPU counters. New reports also expose startup cost and source
provenance. Early development reports predate that instrumentation.

## Remeasured baselines

| Driver | Track | Best clean s | Mean car median s | Sum off-track s | Global contacts | Mean core °C | Max-wheel wear/lap | Fuel L/lap | Update ms/s/car |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

Raw JSON for all 20 cases is under results/baseline-*.json. The corrected
baseline-summary.json also retains steady lap metrics and measurement notes.

## Full development races

These are explicitly development candidates, loaded before the latest tuning.
Each newer result includes hashes and configuration to distinguish revisions.
The original mixed candidate failed; lane-specific braking and lane slew
removed departures in the subsequent Alpine/Desert homogeneous races and
Harbor/Solenne mixed races. Those improvements do not establish acceptance.

| Run | Position / laps | Gap s | Best / median clean s | Off-track s | Impact episodes / damage | Rescues | Stops / swaps | Mean core °C | Fuel L/lap | Wear/lap | Governor active % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${fullRows.join('\n')}

## Reproduce

Run the commands in README.md. For baselines replace --driver solstice with
the listed id, set --teams 4 --seconds 150 --seed 7. For mixed races specify
--field astra,phantom,phantom-v2,gemini-supreme-v4,solinator-6.1,solstice
--teams 6 --laps 6 --seconds 1800. Repeat --track for all four ids and seeds
7, 3, 19. Specify --weather rain --sun .1 for rain/night checks.

Regenerate these tables with node subjects/solstice/tools/report.mjs.
Full cadence and station diagnostic data are separately retained in results/.
Quasisteady envelope estimates are planning heuristics, not achieved lap times
or a proof of a physical limit.
`;
writeFileSync(resolve('subjects/solstice/RESULTS.md'), output);
console.log(JSON.stringify({ output: resolve('subjects/solstice/RESULTS.md'), baselines: rows.length, developmentCars: fullRows.length }));
