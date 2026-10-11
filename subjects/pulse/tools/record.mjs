import { mkdirSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { runScenario } from './scenario.mjs';
import { HOME, versions, digest } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const settings = { track: arg('track', 'harbor-ring'), classId: arg('class', 'lmdh'), fixture: arg('fixture', 'solo'),
  seconds: +arg('seconds', 60), seed: +arg('seed', 7), rate: +arg('rate', 60), mode: arg('mode', 'teacher'), weather: arg('weather', 'clear'),
  lagMs: +arg('lag-ms', 0), spikeMs: +arg('spike-ms', 0), spikeAt: +arg('spike-at', 3), speed: +arg('speed', 45),
  stallMs: +arg('stall-ms', 0), stallAt: +arg('stall-at', 3),
  hazardAt: +arg('hazard-at', 0),
  expertMix: +arg('expert-mix', .5), expertBlockMs: +arg('expert-block-ms', 250),
  start: +arg('start', 20), lateral: +arg('lateral', 0), rivalOffset: +arg('rival-offset', 0), yawOffset: +arg('yaw-offset', 0), rival: arg('rival', 'intercept') };
if (!['lmdh', 'gt'].includes(settings.classId)) throw Error('class must be lmdh or gt');
const ver = versions(), split = arg('split', settings.mode === 'policy' ? 'test' : 'train'), name = arg('name', `${settings.fixture}-${settings.classId}-${settings.seed}`);
if (!/^[a-z0-9-]+$/i.test(name) || !['train', 'validation', 'test'].includes(split)) throw Error('Invalid episode name or split');
let policy;
if (settings.mode !== 'teacher') {
  const { createPolicy } = await import('./policy.mjs');
  policy = await createPolicy(resolve(HOME, arg('model', 'artifacts/model')));
  if ((!policy.metadata.supportedTracks.includes(settings.track) || !policy.metadata.supportedClasses.includes(settings.classId)) && !args.includes('--allow-ood'))
    throw Error('Model has not trained on this class/track. Use teacher mode; --allow-ood explicitly records an out-of-domain experiment.');
  settings.policy = policy.step;
}
const dataRoot = arg('data-root', 'data');
if (!/^data(?:\/[a-z0-9-]+)*$/i.test(dataRoot)) throw Error('data-root must be an owned path beneath data/');
const directory = resolve(HOME, dataRoot, split); mkdirSync(directory, { recursive: true });
const replayDirectory = resolve(HOME, 'results'); mkdirSync(replayDirectory, { recursive: true });
if (!args.includes('--replace') && (existsSync(resolve(directory, name + '.jsonl')) || existsSync(resolve(replayDirectory, name + '.json'))))
  throw Error('Episode name already exists. Use a new name, or --replace explicitly for this owned generated episode.');
const episodeId = digest(Object.fromEntries(['track', 'classId', 'fixture', 'seed', 'weather', 'start', 'lateral', 'rivalOffset', 'yawOffset', 'speed', 'rival', 'rate'].map(k => [k, settings[k]])));
const manifest = { type: 'manifest', format: 'pulse-episode-v1', episodeId, name, split, settings: { ...settings, policy: undefined },
  versions: ver, policy: policy?.metadata ?? null, sampleRate: settings.rate, teacherSuppliesStrategy: true, path: 'native',
  trainingOnly: settings.mode === 'dagger', labelSource: settings.mode === 'dagger' || settings.mode === 'policy' ? 'teacherControls on visited states' : 'executed teacher controls' };
const dataset = createWriteStream(resolve(directory, name + '.jsonl'));
dataset.write(JSON.stringify(manifest) + '\n');
try {
  const result = await runScenario({ ...settings, onRow: row => { if (!dataset.write(JSON.stringify(row) + '\n')) { /* bounded episode: Node buffers until final drain */ } } });
  dataset.end(JSON.stringify({ type: 'summary', ...result.summary }) + '\n'); await once(dataset, 'finish');
  const replay = { manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) };
  writeFileSync(resolve(replayDirectory, name + '.json'), JSON.stringify(replay));
  console.log(JSON.stringify({ dataset: `subjects/pulse/${dataRoot}/${split}/${name}.jsonl`, replay: `subjects/pulse/results/${name}.json`, ...result.summary }));
} finally { await policy?.dispose(); if (!dataset.writableEnded) dataset.destroy(); }
