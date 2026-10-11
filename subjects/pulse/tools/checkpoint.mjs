// Preserve a completed model before another experiment. Existing names are immutable.
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, treeDigest } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name');
if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Use --name with a unique simple experiment name');
const from = resolve(HOME, arg('model', 'artifacts/model')), to = resolve(HOME, 'artifacts/models', name);
if (existsSync(to)) throw Error('Checkpoint already exists; use a new name');
const files = ['model.pt', 'policy-1.onnx', 'policy-16.onnx', 'metadata.json', 'training.json', 'parity.json'];
for (const file of files) if (!existsSync(resolve(from, file))) throw Error('Incomplete checkpoint: ' + file);
mkdirSync(to, { recursive: true });
for (const file of files) copyFileSync(resolve(from, file), resolve(to, file));
writeFileSync(resolve(to, 'archive.json'), JSON.stringify({ name, archivedAt: new Date().toISOString(),
  originalMetadata: JSON.parse(readFileSync(resolve(from, 'metadata.json'), 'utf8')),
  versionsAtArchive: versions(), sourceAtArchiveDigest: treeDigest(['subjects/pulse/training/train.py', 'subjects/pulse/training/model.py',
    'subjects/pulse/pyproject.toml', 'subjects/pulse/uv.lock', 'subjects/pulse/package-lock.json']),
  note: 'Archive-time source is recorded separately; it does not attest which trainer produced an older checkpoint.' }, null, 2));
console.log(JSON.stringify({ preserved: 'subjects/pulse/artifacts/models/' + name }));
