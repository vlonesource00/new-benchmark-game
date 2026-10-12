import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { observationProfile } from '../src/observations.mjs';
import { digest, versions } from './versions.mjs';

export async function createPolicy(directory, { batch = 1, actionContract = 'pulse-actuators-v1' } = {}) {
  if (![1, 16].includes(batch)) throw Error('Exported batch must be 1 or 16');
  const metadata = JSON.parse(readFileSync(resolve(directory, 'metadata.json'), 'utf8'));
  if ((metadata.actionContract ?? 'pulse-actuators-v1') !== actionContract)
    throw Error('Policy action semantics mismatch; lane/pace intentions and actuators require different executors.');
  const { schema: SCHEMA } = observationProfile(metadata.schemaVersion), current = versions(SCHEMA);
  if (metadata.schemaDigest !== digest(SCHEMA) || metadata.simulatorDigest !== current.simulatorDigest || metadata.observationDigest !== current.observationDigest)
    throw Error('Checkpoint schema/physics mismatch. Re-record/retrain; do not silently evaluate old models.');
  const bytes = readFileSync(resolve(directory, `policy-${batch}.onnx`));
  const { createHash } = await import('node:crypto');
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.modelSha256[String(batch)]) throw Error('Model integrity mismatch');
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  return { metadata, schema: SCHEMA,
    async step(observation, hidden) {
      if (observation.length !== SCHEMA.size * batch || hidden.length !== SCHEMA.hidden * batch) throw Error('Policy input size mismatch');
      const result = await session.run({ observation: new ort.Tensor('float32', Float32Array.from(observation), [batch, SCHEMA.size]),
        hidden: new ort.Tensor('float32', Float32Array.from(hidden), [batch, SCHEMA.hidden]) });
      return { action: Array.from(result.action.data), hidden: Array.from(result.nextHidden.data) };
    }, dispose: () => session.release() };
}
