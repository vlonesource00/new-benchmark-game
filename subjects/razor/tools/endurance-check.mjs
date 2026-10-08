import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const classId of ['lmdh', 'gt']) for (const { laps, compound, oneStop } of [
  { laps: 12, compound: 'hard', oneStop: true }, { laps: 20 }
]) {
  const args = ['--import', './scripts/json-loader.mjs', 'subjects/razor/tools/race.mjs',
    'razor,apex', classId, String(laps), 'clear', '7'];
  if (compound) args.push(compound);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 40000 });
  assert.equal(result.status, 0, result.stderr);
  const race = JSON.parse(result.stdout), razor = race.rows.find(r => r.id === 'razor');
  assert.ok(Number.isFinite(razor.finish));
  assert.ok(razor.errors.every(n => n === 0));
  assert.equal(race.severe, 0);
  assert.ok(!razor.incidents.some(kind => /off track|wall|loss of control|recovery/i.test(kind)), JSON.stringify(razor.incidents));
  assert.ok(razor.swaps >= 1);
  const groups = Object.groupBy(razor.laps.filter(l => l.valid && l.lap > 1), l => l.stops);
  const fade = Object.values(groups).map(laps => Math.max(...laps.map(l => l.t)) - Math.min(...laps.map(l => l.t)));
  assert.ok(fade.every(seconds => seconds <= 4), 'Valid-lap stint spread exceeds four seconds: ' + JSON.stringify(fade));
  if (oneStop) assert.equal(razor.stops, 1, 'Do not choose a long soft finish, then add repeated window stops');
  console.log(JSON.stringify({ classId, laps, passed: true, contacts: race.contacts, fade: fade.map(t => +t.toFixed(3)),
    rows: race.rows.map(r => ({ id: r.id, finish: +r.finish.toFixed(2), stops: r.stops, incidents: r.incidents })) }));
}
