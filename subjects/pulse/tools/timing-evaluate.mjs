import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { driveCases } from './drive-cases.mjs';
import { timingProfile } from './timing-profiles.mjs';
const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const name = arg('name'), model = arg('model'), sources = args.flatMap((v, i) => v === '--source' ? [args[i + 1]] : []);
const profiles = arg('profiles', 'native,frame-120,frame-60,frame-30,lag-1,lag-2,jitter,spike-500').split(',');
if (!name || !model || sources.some(v => !/^[a-z0-9-]+$/i.test(v))) throw Error('Unique --name, --model and optional --source reports required');
const scenes = [{ id: 'solo', settings: { track: 'harbor-ring', classId: 'lmdh', fixture: 'solo', weather: 'clear', seconds: 120,
  rate: 60, seed: 7117, start: 20, lateral: 0, rival: 'intercept' }, checkpointDistance: 4500 }];
let sourceVersions;
const sourceDigests = {};
for (const source of sources) {
  const bytes = readFileSync(resolve(HOME, 'artifacts/counterfactuals', source, 'report.json')), search = JSON.parse(bytes);
  sourceVersions ??= search.versions;
  for (const key of ['simulatorDigest', 'observationDigest', 'schemaDigest'])
    if (sourceVersions[key] !== search.versions[key]) throw Error('Sources have different simulation contracts');
  scenes.push({ id: source, settings: search.settings, checkpointDistance: search.checkpointDistance }); sourceDigests[source] = digest(bytes.toString());
}
if (args.includes('--no-solo')) scenes.shift();
const cases = scenes.flatMap(c => profiles.map(profile => ({ ...c, id: c.id + '-' + profile, group: c.id, profile,
  settings: { ...c.settings, ...timingProfile(profile), scheduleSeed: 7123 } })));
const report = await driveCases({ name, model, cases, provenance: { role: 'Reused development encounters across timing profiles', profiles, sourceDigests, sourceVersions } });
console.log(JSON.stringify({ name, accepted: report.accepted, total: report.cases.length, report: 'artifacts/driving-suites/' + name + '/report.json' }));
