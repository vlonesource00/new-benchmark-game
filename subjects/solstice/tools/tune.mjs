// Reproducible controller ablations on the unmodified endurance host.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runBenchmark } from './bench.mjs';
import { runCadenceBenchmark } from './cadence-bench.mjs';

const mode = process.argv[2] ?? 'feedback';
const destination = process.argv[3] ?? `subjects/solstice/results/tune-${mode}.json`;
const groups = {
  feedback: [
    ['current', {}],
    ...[.5, .9, 1.2, 1.7].flatMap(betaGain => [.1, .15, .22].map(yawGain =>
      [`beta${betaGain}-yaw${yawGain}`, { policy: { betaGain, yawGain } }]))
  ],
  slip: [
    ...[.12, .16, .20, .24, .28].flatMap(slipLimit => [.90, .93, .97].map(gripUse =>
      [`slip${slipLimit}-grip${gripUse}`, { policy: { slipLimit, gripUse } }]))
  ],
  preview: [.45, .55, .7, .85, 1].flatMap(lookahead => [0, .02, .05].map(poseLead =>
    [`look${lookahead}-pose${poseLead}`, { policy: { lookahead, poseLead } }])),
  line: [.8, 1, 1.2, 1.5].flatMap(margin => [.8, .9, 1].map(brakeReserve =>
    [`margin${margin}-brake${brakeReserve}`, { path: { margin, brakeReserve } }]))
};
if (!groups[mode]) throw new Error(`Unknown ablation ${mode}`);
const baseOptions = JSON.parse(process.env.SOLSTICE_OPTIONS ?? '{}');
const reports = [];
for (const [name, override] of groups[mode]) {
  const options = { ...baseOptions, ...override,
    path: { ...baseOptions.path, ...override.path }, policy: { ...baseOptions.policy, ...override.policy } };
  process.env.SOLSTICE_OPTIONS = JSON.stringify(options);
  const hotlap = runBenchmark({ driver: 'solstice', teams: 1, track: 'harbor-ring',
    laps: 20, compound: 'soft', seconds: 235, seed: 7 });
  const cadence = runCadenceBenchmark({ hz: 20, teams: 1, track: 'alpine',
    laps: 6, seconds: 190, seed: 7, probe: true });
  const result = { name, options, hotlap, cadence };
  reports.push(result);
  const compact = r => { const c = r.results[0]; return { best: c.bestCleanFlyingLap,
    median: c.medianCleanFlyingLap, offtrack: c.offtrackSeconds, rescues: c.rescues,
    errors: c.bridgeErrors, wear: c.finalMaxWear, core: c.meanTyreCoreC,
    governor: c.governorActiveFraction }; };
  console.log(JSON.stringify({ name, hotlap: compact(hotlap), cadence: compact(cadence) }));
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  writeFileSync(resolve(destination), JSON.stringify({ mode, baseOptions, reports }, null, 2) + '\n');
}
