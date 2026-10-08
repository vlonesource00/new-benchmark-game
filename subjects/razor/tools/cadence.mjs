// Deliberately imposed worker cadence, not a measurement of browser FPS.
// Runs the actual game AsyncSeats/seat-worker path with identical initial
// state and physics, changing only RAZOR's held-control predictor option.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const trackId = process.argv.find(a => a.startsWith('--track='))?.slice(8) ?? 'harbor-ring';
const long = process.argv.includes('--long');
const strict = process.argv.includes('--assert');
const selected = process.argv.find(a => a.startsWith('--cases='))?.slice(8).split(',');
const cases = [
  { name: '20', hz: 20 }, { name: '30', hz: 30 }, { name: '60', hz: 60 },
  { name: 'variable', hz: 60, cadence: '60,20,60,30' }
].filter(c => !selected || selected.includes(c.name));
assert.ok(cases.length, 'No cadence cases selected');

for (const setup of cases) for (const enabled of process.argv.includes('--enabled-only') ? [true] : [false, true]) {
  const seconds = long ? 75 : 6;
  const args = ['--import', './scripts/json-loader.mjs', 'subjects/razor/tools/worker-encounters.mjs',
    'apex', 'gt', '--hz=' + setup.hz, '--seconds=' + seconds, '--start=250', '--gap=800',
    '--track=' + trackId, '--driver-options=' + JSON.stringify({ physicalPrediction: enabled }),
    '--solo', '--trace', '--quiet-trace', '--trace-every-frame', '--allow-incidents'];
  if (setup.cadence) args.push('--cadence=' + setup.cadence);
  const job = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 12e6 });
  assert.equal(job.status, 0, job.error?.message ?? job.stderr.slice(-1200));
  const result = JSON.parse(job.stdout.trim().split('\n').at(-1)).enabled;
  const trace = long ? result.trace : result.trace.filter(r => r.s > 270 && r.s < 520);
  assert.ok(trace.length, 'No measured samples');
  let total = 0, throttle = 0, lift = 0, modeFlips = 0, steerStep = 0, error = 0, minSpeed = Infinity;
  for (let i = 0; i < trace.length; i++) {
    const row = trace[i], dt = i ? row.t - trace[i - 1].t : 1 / setup.hz;
    total += dt; throttle += row.throttle * dt;
    if (row.throttle < .9 && row.brake === 0) lift += dt;
    if (i) {
      modeFlips += Number(row.mode !== trace[i - 1].mode);
      steerStep = Math.max(steerStep, Math.abs(row.steer - trace[i - 1].steer));
    }
    error = Math.max(error, Math.abs(row.e)); minSpeed = Math.min(minSpeed, row.v);
  }
  const round = n => +n.toFixed(4);
  const report = { trackId, cadence: setup.name, enabled, seconds, meanThrottle: round(throttle / total),
    liftSeconds: round(lift), modeFlips, maxSteerStep: round(steerStep), maxLineError: round(error),
    minSpeed: round(minSpeed), contacts: result.contacts, severe: result.severe, offSeconds: result.off,
    errors: result.errors, replyAgeP95: result.replyAgeP95, lapTimes: result.lapTimes };
  console.log(JSON.stringify(report));
  if (strict && enabled) {
    assert.equal(result.severe, 0); assert.equal(result.off, 0); assert.equal(result.contacts, 0);
    if (!long) {
      assert.ok(report.meanThrottle > .95, 'A clear straight must retain acceleration');
      assert.ok(report.maxSteerStep < .2, 'Fresh commands must not reverse the steering sharply');
      assert.ok(report.maxLineError < .5, 'Damping must retain line tracking');
    }
  }
}
