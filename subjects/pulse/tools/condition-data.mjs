// Explicit offline re-encoding of recorded PUBLIC state. Commands, physical
// states, episode grouping and original harness provenance remain unchanged.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Track } from '../../../game/engine/sim/track.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { SCHEMA as V1 } from '../src/schema.mjs';
import { SCHEMA as V2, conditionObservation } from '../src/schema-v2.mjs';
import { HOME, versions, treeDigest } from './versions.mjs';
const args = process.argv.slice(2), at = args.indexOf('--name'), name = at < 0 ? null : args[at + 1];
if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Use a unique simple --name');
const destination = resolve(HOME, 'data', name);
if (existsSync(destination)) throw Error('Converted dataset exists; preserve it');
const current = versions(V1), upgraded = versions(V2), report = [], tracks = new Map();
const sources = ['data', 'data/recovery-03', 'data/c01', 'data/c02', 'data/c04'];
for (const source of sources) for (const split of ['train', 'validation']) {
  const input = resolve(HOME, source, split), output = resolve(destination, source === 'data' ? 'base' : source.split('/').at(-1), split);
  mkdirSync(output, { recursive: true });
  for (const file of readdirSync(input).filter(f => f.endsWith('.jsonl')).sort()) {
    const bytes = readFileSync(resolve(input, file)), records = bytes.toString('utf8').trim().split('\n').map(JSON.parse), manifest = records[0];
    if (['schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest'].some(k => manifest.versions[k] !== current[k])) throw Error('Source data contract differs; do not silently migrate it');
    const id = manifest.settings.track;
    if (!tracks.has(id)) tracks.set(id, new Track(id));
    const track = tracks.get(id), labelsBefore = createHash('sha256'), labelsAfter = createHash('sha256');
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    for (const row of records) if (row.type === 'step') {
      labelsBefore.update(JSON.stringify([row.target, row.teacherControls]));
      const old = row.observation;
      row.observation = conditionObservation(old, { ...row.before, spec: carSpecFor(row.before.classId) }, track);
      // Remove precisely the added fields and prove every original numeric
      // input is preserved. Do not change validity masks or target commands.
      const recovered = [...row.observation.normalized.slice(0, V1.groups.ego.size), ...row.observation.normalized.slice(V1.groups.ego.size + 5)];
      if (JSON.stringify(recovered) !== JSON.stringify(old.normalized)) throw Error('Common observations changed during migration');
      labelsAfter.update(JSON.stringify([row.target, row.teacherControls]));
    }
    if (labelsBefore.digest('hex') !== labelsAfter.digest('hex')) throw Error('Target commands changed during migration');
    manifest.migratedFrom = { source: source + '/' + split + '/' + file, sourceSha256, versions: manifest.versions,
      encoderAtMigrationGit: upgraded.git, migrationDigest: treeDigest(['subjects/pulse/tools/condition-data.mjs']) };
    manifest.versions = { ...manifest.versions, schemaVersion: upgraded.schemaVersion, schemaDigest: upgraded.schemaDigest, observationDigest: upgraded.observationDigest };
    manifest.settings.observationVersion = V2.version;
    writeFileSync(resolve(output, file), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    report.push({ source: source + '/' + split + '/' + file, steps: records.filter(r => r.type === 'step').length, sourceSha256 });
  }
}
writeFileSync(resolve(destination, 'migration.json'), JSON.stringify({ schemaVersion: V2.version, observations: V2.size,
  scope: 'Five additional public-state features; every existing input and target preserved. No replay rerun or new physics claim.', files: report }, null, 2));
console.log(JSON.stringify({ destination: 'data/' + name, files: report.length, steps: report.reduce((n, r) => n + r.steps, 0), observations: V2.size }));
