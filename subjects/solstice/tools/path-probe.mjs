// Static game-specific line diagnostics; this private vehicle is not a race car.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { RacingPath } from '../src/path.js';
import config from '../config.json' with { type: 'json' };

const track = new Track(process.argv[2] ?? 'harbor-ring'), car = new Vehicle();
const options = JSON.parse(process.env.SOLSTICE_OPTIONS ?? '{}');
car.fuel = 35;
for (const w of car.wheels) Object.assign(w.tyre, { core: 85, surface: 90,
  pressure: 2.15, wear: 0, gripScale: 1.045, compound: 'soft' });
const path = new RacingPath(track, { ...config.path, ...options.path, car });
path.rebuildEnvelope(car, options.policy?.gripUse ?? .93);
const rows = Array.from({ length: path.n }, (_, i) => {
  const s = i * path.step, p = path.at(s), road = track.at(s);
  return { s, x: p.x, z: p.z, roadX: road.x, roadZ: road.z, offset: p.offset,
    curvature: p.curvature, roadCurvature: road.curvature, speed: p.speed };
});
const report = { track: track.id, options, estimate: path.estimatedLapTime,
  note: 'Warm private steady-state envelope; an estimate, not a measured lap or physical lower bound.', rows };
if (process.argv[3]) {
  const output = resolve(process.argv[3]); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
const critical = [...rows].sort((a, b) => a.speed - b.speed).filter((r, i, a) =>
  !a.slice(0, i).some(x => Math.abs(x.s - r.s) < 35)).slice(0, 12);
console.log(JSON.stringify({ track: track.id, estimate: path.estimatedLapTime,
  offsetRange: [Math.min(...path.q), Math.max(...path.q)], critical,
  firstTurn: rows.filter(r => r.s >= 680 && r.s < 1000 && Math.round(r.s / path.step) % 5 === 0) }));
