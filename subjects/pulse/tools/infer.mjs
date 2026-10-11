import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { timing } from '../src/runtime.mjs';
import { SCHEMA } from '../src/schema.mjs';
const args = process.argv.slice(2), i = args.indexOf('--model');
const directory = resolve(HOME, i < 0 ? 'artifacts/model' : args[i + 1]), parity = JSON.parse(readFileSync(resolve(directory, 'parity.json'), 'utf8'));
const result = { model: directory.split(/[/\\]/).at(-1), backend: 'onnxruntime-node CPU', batches: {}, maximumActionError: 0, maximumHiddenError: 0 };
for (const batch of [1, 16]) {
  const policy = await createPolicy(directory, { batch }); let hidden = new Array(batch * SCHEMA.hidden).fill(0);
  for (const sample of parity) {
    const input = Array.from({ length: batch }, () => sample.observation).flat();
    const prediction = await policy.step(input, hidden); hidden = prediction.hidden;
    for (let b = 0; b < batch; b++) {
      for (let i = 0; i < 2; i++) result.maximumActionError = Math.max(result.maximumActionError, Math.abs(prediction.action[b * 2 + i] - sample.action[i]));
      for (let i = 0; i < SCHEMA.hidden; i++) result.maximumHiddenError = Math.max(result.maximumHiddenError, Math.abs(hidden[b * SCHEMA.hidden + i] - sample.hidden[i]));
    }
  }
  const observation = Array.from({ length: batch }, () => parity[0].observation).flat();
  for (let i = 0; i < 30; i++) hidden = (await policy.step(observation, hidden)).hidden;
  const times = [];
  for (let i = 0; i < 200; i++) { const start = performance.now(); hidden = (await policy.step(observation, hidden)).hidden; times.push(performance.now() - start); }
  result.batches[batch] = timing(times);
  await policy.dispose();
}
if (result.maximumActionError > 1e-5 || result.maximumHiddenError > 1e-5) throw Error('Torch -> ONNX recurrent parity failed');
writeFileSync(resolve(directory, 'inference-node.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
