import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Render measurements without overwriting the hand-written acceptance record.
const data = JSON.parse(readFileSync(new URL('../results/compact-summary.json', import.meta.url)));
const number = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const trackArg = process.argv.indexOf('--track');
const track = trackArg < 0 ? null : process.argv[trackArg + 1];
const rows = [];
for (const run of data.measurements) {
  if (run.type !== 'race' || track && run.config.track !== track) continue;
  for (const car of run.results) rows.push(
    `| ${run.source} | ${run.config.track} / ${run.config.seed} | ${car.driver} | ${car.position} | ${number(car.finishTime)} | ${number(car.bestCleanFlyingLap)} / ${number(car.medianCleanFlyingLap)} | ${car.stops} / ${car.swaps} | ${number(car.offtrackSeconds)} | ${car.rescues} | ${car.bridgeErrors} | ${car.finite} | ${number(car.fuelUsedLitresPerLapEquivalent)} | ${number(car.cumulativeMaxWearPerLapEquivalent)} |`);
}
const table = [
  'Conditions, options and source hashes are retained in results/compact-summary.json.',
  'Contact-step counts in that file are field-wide and cannot be assigned to one car.',
  '',
  '| Run | Track / seed | Driver | Position | Finish s | Best / median clean s | Stops / swaps | Off-track s | Rescues | Errors | Finite | Fuel L/lap equivalent | Wear/lap equivalent |',
  '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|',
  ...rows, ''
].join('\n');
const outputArg = process.argv.indexOf('--output');
if (outputArg >= 0) {
  writeFileSync(resolve(process.argv[outputArg + 1]), table);
  console.log(JSON.stringify({ rows: rows.length, written: true }));
} else console.log(table);
