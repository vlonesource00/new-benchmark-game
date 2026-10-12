// One evaluation case in its own worker thread (fresh module state for the game and every rival AI).
import { workerData, parentPort } from 'node:worker_threads';
import { resolve } from 'node:path';
import { HOME, versions } from './versions.mjs';
import { createPolicy } from './policy.mjs';
import { loadFastMotor } from './fast-motor.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import { driveOne } from './drive-cases.mjs';

const { model, actor } = workerData;
const policy = await createPolicy(resolve(HOME, model), { actionContract: actor === 'plan' ? PLAN_CONTRACT.version : 'pulse-actuators-v1' });
try {
  const motor = actor === 'plan' ? null : loadFastMotor(resolve(HOME, model), policy.metadata);
  parentPort.postMessage(await driveOne({ ...workerData, policy, motor, ver: versions(policy.schema) }));
} finally { await policy.dispose(); }
