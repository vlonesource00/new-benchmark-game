// Preserve failed whole demonstrations, and admit only their independently
// labelled clean prefix as corrections. Never rewrite the source measurements.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), source = arg('source');
if (!name || !source || ![name, source].every(x => /^[a-z0-9-]+$/i.test(x))) throw Error('Simple source and new dataset names required');
const output = resolve(HOME, 'data', name);
if (existsSync(output)) throw Error('Output exists; preserve it');
const quality = JSON.parse(readFileSync(resolve(HOME, 'data', source, 'quality.json'), 'utf8'));
mkdirSync(output, { recursive: true });
const report = { source, name, scope: 'Failed expert demonstrations contribute clean-prefix correction labels only, never whole-episode success.', episodes: [] };
for (const c of quality.rejected) {
  if (!/^[a-z0-9-]+$/i.test(c.episode) || !['train', 'validation'].includes(c.split)) throw Error('Invalid source identity');
  const raw = readFileSync(resolve(HOME, 'data', source, 'candidates', c.split, c.episode + '.jsonl'), 'utf8');
  const packets = raw.trim().split('\n').map(JSON.parse), original = packets[0], summary = packets.at(-1);
  if (original.settings.mode !== 'teacher' || original.split !== c.split || summary.type !== 'summary' || summary.endedEarly || summary.minFuel < 1)
    throw Error('Incomplete or non-expert source');
  const manifest = { ...original, name: name + '-' + c.episode, trainingOnly: true, cleanPrefixTraining: true, expertCleanPrefixTraining: true,
    sourceSha256: digest(raw), labelSource: 'teacherControls on the clean prefix only; original failures retained in the summary' };
  const folder = resolve(output, c.split); mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, manifest.name + '.jsonl'), [manifest, ...packets.slice(1)].map(JSON.stringify).join('\n') + '\n');
  report.episodes.push({ sourceEpisode: c.episode, name: manifest.name, split: c.split, originalDamage: summary.cumulativeDamage, originalIllegal: summary.trackLimitSeconds });
}
writeFileSync(resolve(output, 'quality.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ complete: true, episodes: report.episodes.length }));
