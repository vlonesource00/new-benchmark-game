import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { timing } from '../src/runtime.mjs';
const args = process.argv.slice(2), at = args.indexOf('--model');
if (at < 0) throw Error('Use --model with an exported local motor');
const directory = resolve(HOME, args[at + 1]), output = resolve(directory, 'fast-motor-parity.json');
if (existsSync(output)) throw Error('Parity report exists; preserve it');
const policy = await createPolicy(directory), motor = loadFastMotor(directory, policy.metadata);
const samples = JSON.parse(readFileSync(resolve(directory, 'parity.json'), 'utf8'));
const maskAt = policy.schema.groups.rivals.offset;
const latency = []; let maxError = 0;
try {
  for (const sample of samples) {
    const observation = [...sample.observation]; observation.fill(0, maskAt);
    const reference = await policy.step(observation, new Array(policy.schema.hidden).fill(0));
    const action = motor.step(observation);
    maxError = Math.max(maxError, ...action.map((v, i) => Math.abs(v - reference.action[i])));
    const changed = [...observation]; changed.fill(.95, maskAt);
    if (motor.step(changed).some((v, i) => v !== action[i])) throw Error('Rival slots leaked into the local motor');
  }
  if (maxError > 4e-6) throw Error('Local motor differs from the learned empty-rival actor: ' + maxError);
  for (let i = 0; i < 1000; i++) {
    const start = performance.now(); motor.step(samples[i % samples.length].observation);
    if (i >= 100) latency.push(performance.now() - start);
  }
  const report = { samples: samples.length, maxActionError: maxError, latencyMs: timing(latency),
    modelSha256: policy.metadata.modelSha256, scope: 'Synchronous learned-motor parity/microbench, not a driving or browser-worker gate' };
  writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await policy.dispose(); }
