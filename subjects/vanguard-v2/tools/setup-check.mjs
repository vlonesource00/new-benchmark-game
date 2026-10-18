import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = execFileSync(process.execPath, ['--import', './scripts/json-loader.mjs',
  'subjects/vanguard/tools/probe.mjs', '--time', '0', '--cls', 'gt', '--tyres', 'wet',
  '--weather', 'rain', '--wear', '0.6', '--fuel', '20'], { cwd: root, encoding: 'utf8', timeout: 30000 });
const result = JSON.parse(output.trim().split('\n').at(-1));
assert.equal(result.harnessVersion, 'post-start-setup-v2');
assert(result.actualStart[0].compounds.every(c => c === 'wet'), 'start() must not silently undo the requested compound');
assert(result.actualStart[0].wear.every(w => w === 0.6), 'start() must not silently reset the requested tyre wear');
assert.equal(result.actualStart[0].fuel, 20, 'requested fuel survives race reset');
assert(result.cars[0].wear.every(w => w === 0.6), 'the simulated car has the actual setup, not just result labels');
console.log('VANGUARD benchmark setup checks passed.');
