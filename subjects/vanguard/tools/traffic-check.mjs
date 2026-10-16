// Verification gates for VANGUARD traffic navigation, hazard evasion, determinism, and latency.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url)),
  dir = fileURLToPath(new URL('../results/', import.meta.url));
const prefixAt = process.argv.indexOf('--prefix');
const prefix = prefixAt < 0 ? 'check-vgd-' : process.argv[prefixAt + 1];
assert.match(prefix, /^[a-zA-Z0-9_-]+$/, 'result prefix must be a filename prefix');

function scene(name, args = []) {
  const r = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/vanguard/tools/traffic.mjs', '--out', prefix + name, ...args], {
    cwd: root, encoding: 'utf8', timeout: 90000
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  const data = JSON.parse(readFileSync(dir + prefix + name + '.json', 'utf8'));
  assert.ok(data.trace.length > 100);
  assert.ok(Number.isFinite(data.summary.straightDelay));
  assert.ok(data.summary.errors.every(x => x === 0));
  assert.ok(data.trace.every(x => [x.time, x.speed, x.x, x.z, ...Object.values(x.controls)].every(Number.isFinite)));
  return data;
}

const signature = d => JSON.stringify(d.trace.map(x => [x.time, x.road, x.speed, x.controls, x.damage, x.debug.intent, x.debug.route?.key]));
const base = scene('train'), repeat = scene('repeat');
assert.equal(signature(base), signature(repeat), 'Worker runs must be deterministic');
assert.equal(base.summary.retainedOnStraight, 3);
assert.equal(base.summary.ownContacts, 0);
assert.equal(base.summary.damage, 0);
assert.ok(base.summary.straightDelay < 1);
assert.deepEqual(base.passes.map(p => p.kind), ['move', 'carried-lane', 'carried-lane']);
assert.ok(base.passes.every(p => p.clear.speed > 60 && p.retained - p.clear.time >= 1));
console.log('ok train: three retained body-clear passes, with route evidence and deterministic workers (delay:', base.summary.straightDelay.toFixed(3), 's)');

const follow = scene('follow', ['--follow']);
assert.equal(follow.summary.retainedOnStraight, 0);
assert.equal(follow.summary.straightOwnContacts, 0);
assert.equal(follow.summary.severe, 0);
assert.ok(follow.summary.damage < 0.01);
assert.ok(follow.summary.straightDelay > base.summary.straightDelay + 2);
console.log('ok follow: following-only control rules out straight-line pace as the passing explanation');

const spike = scene('spikes', ['--lagJitter', '4', '--frameJitter', '.3', '--spikes', '2:0.5,6:0.25']);
assert.ok(spike.summary.planAgeMax > 0.4);
assert.equal(spike.summary.retainedOnStraight, 3);
assert.equal(spike.summary.ownContacts, 0);
assert.equal(spike.summary.damage, 0);
assert.ok(spike.summary.straightDelay < 1);
assert.equal(spike.events.filter(x => x.type === 'latency-spike').length, 2);
console.log('ok spikes: injected delays preserve passing and fresh 120Hz execution (delay:', spike.summary.straightDelay.toFixed(3), 's)');

const staggered = scene('staggered', ['--mode', 'train', '--offsets', '-1.2,1.2,-1.2']);
assert.equal(staggered.summary.retainedOnStraight, 3);
assert.equal(staggered.summary.ownContacts, 0);
assert.equal(staggered.summary.damage, 0);
console.log('ok staggered: 3 staggered GT cars cleared cleanly on straight (delay:', staggered.summary.straightDelay.toFixed(3), 's)');

const braking = scene('early-brake', ['--mode', 'braking', '--positions', '65,180,260', '--speed', '57', '--gt-speed', '52', '--limit', '62', '--brake-at', '1.2']);
assert.equal(braking.summary.straightOwnContacts, 0);
assert.equal(braking.summary.straightDamage, 0);
assert.equal(braking.summary.severe, 0);
assert.ok(braking.summary.damage < 0.01);
assert.equal(braking.passes.find(p => p.id === 0).contacts, 0);
assert.equal(braking.passes.find(p => p.id === 0).status, 'retained');
assert.ok(braking.passes.find(p => p.id === 0).clear.speed > 60);
assert.ok(braking.summary.straightDelay < 0.5);
console.log('ok early-brake: early-braking tow target passed through open space without rear-end or lost pace (delay:', braking.summary.straightDelay.toFixed(3), 's)');

for (const mode of ['stopped', 'spun']) {
  const d = scene(mode, ['--mode', mode]), hazard = d.passes.find(p => p.hazard);
  assert.equal(hazard.status, 'retained');
  assert.equal(d.summary.ownContacts, 0);
  assert.equal(d.summary.damage, 0);
  assert.ok(d.summary.danger.length === 1);
  assert.equal(hazard.rescueAssisted, false);
  assert.ok(!d.events.some(e => e.type === 'marshal-rescue' && e.id === hazard.id));
  assert.ok(d.hazardControl?.trace.length > 100);
  assert.ok(Number.isFinite(d.summary.hazardAddedStraightDelay));
  assert.ok(Number.isFinite(hazard.hazardDelayAtClear));
  const first = d.trace[0].cars[2], last = d.trace.at(-1).cars[2];
  assert.ok(Math.hypot(first.x - last.x, first.z - last.z) < 0.5, 'The obstacle must stay physically in place');
  assert.equal(d.summary.danger[0].fast, true, `${mode} hazard evasion must satisfy fast gate (delay<=0.5s, recovery<=1.5s)`);
  assert.equal(d.summary.danger[0].incrementalFast, true, `${mode} hazard evasion must satisfy incrementalFast gate`);
  console.log(`ok ${mode}: cleared without damage; delayAtClear=${d.summary.danger[0].delay?.toFixed(3)}s, recovery=${d.summary.danger[0].recovery?.toFixed(3)}s, fast=${d.summary.danger[0].fast}, incFast=${d.summary.danger[0].incrementalFast}`);
}
console.log('All VANGUARD traffic checks passed.');
