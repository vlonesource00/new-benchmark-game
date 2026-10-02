import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { RacingPath } from '../src/path.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const overrides = JSON.parse(process.env.SOLSTICE_OPTIONS ?? '{}');
const lines = [];
for (const id of ['harbor-ring', 'solenne', 'alpine', 'desert']) {
  const track = new Track(id), car = new Vehicle(0, 'PRIVATE GEOMETRY', '#ffcf6b', 'gt');
  const options = { ...config.path, ...config.tracks?.[id]?.path, ...overrides.path,
    ...overrides.tracks?.[id]?.path, car, unbaked: true };
  const path = new RacingPath(track, options);
  lines.push({ track: id, key: path.geometryKey, offsets: Array.from(path.q), estimatedLapTime: path.estimatedLapTime });
  console.log(JSON.stringify({ track: id, points: path.n, modelSeconds: path.estimatedLapTime }));
}
const output = new URL('../data/lines.json', import.meta.url);
const sourceHash = createHash('sha256').update(readFileSync(new URL('../src/path.js', import.meta.url))).digest('hex');
writeFileSync(output, JSON.stringify({ version: 1, sourceHash, lines }) + '\n');
