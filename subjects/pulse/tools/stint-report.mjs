// A no-stop motor readout is not evidence of learned pit timing or tyre choice.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
const args = process.argv.slice(2), at = args.indexOf('--episode'), name = args[at + 1];
if (at < 0 || !/^[a-z0-9-]+$/i.test(name)) throw Error('Use --episode with an existing saved replay');
const directory = resolve(HOME, 'artifacts/diagnostics'), output = resolve(directory, name + '-stint.json');
if (existsSync(output)) throw Error('Stint report exists; preserve it');
mkdirSync(directory, { recursive: true });
const replay = JSON.parse(readFileSync(resolve(HOME, 'results', name + '.json'), 'utf8'));
const rows = replay.rows, summary = replay.summary;
const closest = time => rows.reduce((a, b) => Math.abs(b.time - time) < Math.abs(a.time - time) ? b : a, rows[0]);
const laps = summary.fullLaps.map(lap => {
  const end = closest(lap.time).post, startTime = lap.time - lap.seconds;
  const start = closest(startTime).before, samples = rows.filter(r => r.time >= startTime && r.time <= lap.time);
  let switches = 0, previous = 0;
  for (const row of samples) {
    const pedal = row.executed.throttle - row.executed.brake, sign = pedal > .05 ? 1 : pedal < -.05 ? -1 : 0;
    if (sign && previous && sign !== previous) switches++;
    if (sign) previous = sign;
  }
  return { lap: lap.lap, seconds: lap.seconds, valid: lap.valid, fuelUsedLitres: start.fuel - end.fuel,
    endBatteryJoules: end.battery, endWear: end.tyres.map(t => t.wear), endCoreCelsius: end.tyres.map(t => t.core),
    peakCoreCelsius: Math.max(...samples.flatMap(r => r.before.tyres.map(t => t.core))),
    throttleBrakeSwitchesPerMinute: switches * 60 / lap.seconds };
});
const valid = laps.filter(lap => lap.valid), last = valid.at(-1);
const report = { episode: name, modelSha256: replay.manifest.policy?.modelSha256, track: summary.track,
  classId: summary.classId, weather: replay.manifest.settings.weather, seconds: summary.seconds,
  cleanInterval: !summary.trackLimitSeconds && summary.cumulativeDamage < .001 && !summary.incidents && !summary.dq && !summary.endedEarly,
  expertActuatorRows: summary.expertRows + summary.expertActuatorRows,
  initialPartialLapExcluded: true, completeValidLaps: valid.length, bestFullLap: summary.bestFullLap,
  finalFullLapFadeSeconds: last ? last.seconds - Math.min(...valid.map(lap => lap.seconds)) : null,
  endWear: rows.at(-1).post.tyres.map(t => t.wear), laps,
  scope: 'Native no-stop motor rollout with bootstrapped game systems and sufficient fuel. It does not prove learned strategy, pit timing, tyre choice, energy policy or weather adaptation.' };
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ file: 'subjects/pulse/artifacts/diagnostics/' + name + '-stint.json', clean: report.cleanInterval,
  laps: valid.length, best: report.bestFullLap, fade: report.finalFullLapFadeSeconds }));
