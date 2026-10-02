import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { RacingPath } from '../src/path.js';

const data = JSON.parse(readFileSync(new URL('../data/lines.json', import.meta.url)));
for (const record of data.lines) {
  const track = new Track(record.track), car = new Vehicle(0, 'PRIVATE LINE CHECK', '#ffcf6b', 'gt');
  const options = { ...JSON.parse(record.key.slice(record.key.indexOf('{'))), car };
  const started = performance.now(), loaded = new RacingPath(track, options);
  const loadedMs = performance.now() - started;
  assert.equal(loaded.geometrySource, 'baked');
  assert.equal(loaded.geometryKey, record.key);
  const began = performance.now(), rebuilt = new RacingPath(track, { ...options, unbaked: true });
  const rebuiltMs = performance.now() - began;
  let maxError = 0;
  for (let i = 0; i < loaded.n; i++) {
    assert.equal(loaded.q[i], rebuilt.q[i], `${record.track} offset ${i}`);
    for (const key of ['x', 'z', 'ds', 'heading', 'curvature'])
      maxError = Math.max(maxError, Math.abs(loaded.geometry[key][i] - rebuilt.geometry[key][i]));
    const p = loaded.points[i];
    for (const lateral of [-car.spec.halfWidth, car.spec.halfWidth])
      for (const longitudinal of [-car.spec.halfLength, car.spec.halfLength]) {
        const x = p.x + lateral * Math.cos(p.heading) + longitudinal * Math.sin(p.heading);
        const z = p.z - lateral * Math.sin(p.heading) + longitudinal * Math.cos(p.heading);
        assert.ok(Math.abs(track.nearest(x, z).lateral) <= track.halfWidth + track.curbWidth + .03);
      }
  }
  assert.ok(maxError < 1e-10, `${record.track} baked geometry parity`);
  console.log(JSON.stringify({ track: record.track, points: loaded.n,
    loadedMs, rebuiltMs, maxError, legalFootprint: true }));
}
