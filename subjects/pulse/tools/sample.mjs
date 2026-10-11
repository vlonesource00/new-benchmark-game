// Reproducible small demonstration set. Separate whole sessions, seeds and starts.
import { spawnSync } from 'node:child_process';
import { ROOT } from './versions.mjs';
const episodes = [
  ['--seconds', '75', '--seed', '7', '--name', 'solo-train-7'],
  ['--fixture', 'train', '--seconds', '25', '--seed', '8', '--name', 'train-traffic-8'],
  ['--fixture', 'pair', '--seconds', '30', '--seed', '9', '--name', 'train-pair-9'],
  ['--seconds', '35', '--seed', '31', '--lateral', '-2', '--yaw-offset', '-.05', '--name', 'recovery-left-31'],
  ['--seconds', '35', '--seed', '32', '--lateral', '2', '--yaw-offset', '.05', '--name', 'recovery-right-32'],
  ['--seconds', '35', '--seed', '33', '--start', '650', '--lateral', '-2', '--yaw-offset', '.04', '--speed', '35', '--name', 'recovery-exit-33'],
  ['--seconds', '35', '--seed', '34', '--start', '1550', '--lateral', '2', '--yaw-offset', '-.04', '--speed', '28', '--name', 'recovery-corner-34'],
  ['--seconds', '65', '--seed', '17', '--start', '1000', '--lateral', '-.4', '--split', 'validation', '--name', 'validation-solo-17'],
  ['--fixture', 'train', '--seconds', '22', '--seed', '18', '--start', '150', '--lateral', '.4', '--split', 'validation', '--name', 'validation-traffic-18']
];
for (const args of episodes) {
  const r = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
  if (r.status) throw Error(r.stderr || r.error || `Recorder exited ${r.status}`);
  const summary = JSON.parse(r.stdout.trim());
  console.log(JSON.stringify({ name: args.at(-1), seconds: summary.seconds, throughput: summary.simSecondsPerWallSecond,
    rows: summary.rows, missing: summary.missingRows, fuel: summary.minFuel, damage: summary.cumulativeDamage, passes: summary.retainedPasses }));
}
