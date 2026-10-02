import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { RacingPath } from '../src/path.js';

const angle = x => Math.atan2(Math.sin(x), Math.cos(x));
const digest = a => createHash('sha256').update(new Uint8Array(a.buffer)).digest('hex');
const round = x => Number(x.toFixed(6));
const records = [];
for (const id of ['harbor-ring', 'solenne', 'alpine', 'desert']) {
  const track = new Track(id), car = new Vehicle(), path = new RacingPath(track);
  car.fuel = 35;
  for (const w of car.wheels) Object.assign(w.tyre, { core: 85, surface: 90, pressure: 2.15, wear: 0 });
  path.rebuildEnvelope(car, .93);
  const base = path.variant(), edge = track.halfWidth - path.margin;
  const qHash = digest(path.q), xHash = digest(path.geometry.x), speedHash = digest(path.speed);
  let defaultExact = base.q === path.q && base.geometry === path.geometry && base.speed === path.speed;
  // Compare the unchanged default against the former at() interpolation.
  for (let s = 0; s < track.length; s += 3) {
    const station = ((s % track.length) + track.length) % track.length;
    const actual = path.at(s), p = station / path.step, i = Math.floor(p), j = (i + 1) % path.n, t = p - i;
    let nx = path.base[i].nx + (path.base[j].nx - path.base[i].nx) * t;
    let nz = path.base[i].nz + (path.base[j].nz - path.base[i].nz) * t;
    const norm = Math.hypot(nx, nz); nx /= norm; nz /= norm;
    const heading = path.geometry.heading[i] + angle(path.geometry.heading[j] - path.geometry.heading[i]) * t;
    const expected = { x: path.sample(path.geometry.x, station) + nx * 0,
      z: path.sample(path.geometry.z, station) + nz * 0, heading: angle(heading),
      offset: path.sample(path.q, station), curvature: path.sample(path.geometry.curvature, station),
      speed: path.sample(path.speed, station), nx, nz, tx: Math.sin(heading), tz: Math.cos(heading) };
    for (const [key, value] of Object.entries(expected)) defaultExact &&= Object.is(actual[key], value);
  }
  const cases = [[1.5, null], [-2.3, null], [0, { min: 0, max: edge }],
    [0, { min: -edge, max: 0 }], [.8, { min: 1.1, max: 3.9 }],
    [0, { min: .37, max: .37 }], [2.5, { min: edge - .5, max: edge }]];
  const rows = [];
  for (const [extra, bounds] of cases) {
    const start = performance.now(), v = path.variant(extra, bounds), buildMs = performance.now() - start;
    let margin = Infinity, corridorViolation = 0, finite = true, atError = 0;
    for (const name of ['x', 'z', 'ds', 'heading', 'curvature', 'raw']) {
      for (const value of v.geometry[name]) finite &&= Number.isFinite(value);
    }
    for (const value of v.speed) finite &&= Number.isFinite(value) && value > 0;
    for (let s = 0; s < track.length; s += 3) {
      const a = path.at(s, extra, bounds), tx = Math.sin(a.heading), tz = Math.cos(a.heading);
      const nx = Math.cos(a.heading), nz = -Math.sin(a.heading);
      atError = Math.max(atError, Math.abs(a.x - path.sample(v.geometry.x, s)),
        Math.abs(a.z - path.sample(v.geometry.z, s)), Math.abs(a.curvature - path.sample(v.geometry.curvature, s)));
      if (bounds) corridorViolation = Math.max(corridorViolation, bounds.min - a.offset, a.offset - bounds.max);
      for (const side of [-1, 1]) for (const end of [-1, 1]) {
        const p = track.nearest(a.x + nx * side * car.spec.halfWidth + tx * end * car.spec.halfLength,
          a.z + nz * side * car.spec.halfWidth + tz * end * car.spec.halfLength);
        margin = Math.min(margin, track.halfWidth - Math.abs(p.lateral));
      }
    }
    const a = path.at(-1, extra, bounds), b = path.at(track.length - 1, extra, bounds);
    const cacheSame = path.variant(extra, bounds);
    rows.push({ extra, bounds, buildMs: round(buildMs), minimumBodyMargin: round(margin),
      corridorViolation: round(corridorViolation), finite, atError, periodic: a.x === b.x && a.z === b.z,
      cacheSame: cacheSame.geometry === v.geometry && cacheSame.q === v.q && cacheSame.speed === v.speed });
  }
  const retained = path.variant(.8, { min: 1.1, max: 3.9 });
  const retainedHash = digest(retained.q);
  for (let i = 0; i < 90; i++) path.variant(i * .25 - 11, { min: -.75, max: 2.75 });
  const cacheSizes = [path.variantGeometries.size, path.variantEnvelopes.size];
  // Retain this geometry across the rebuild rather than stress-evicting it.
  const old = path.variant(.8, { min: 1.1, max: 3.9 });
  for (const w of car.wheels) w.tyre.wear = .45;
  path.rebuildEnvelope(car, .93);
  const speedsCleared = path.variantEnvelopes.size === 0;
  const fresh = path.variant(.8, { min: 1.1, max: 3.9 });
  const bad = path.variant(Infinity, { min: NaN, max: Infinity });
  records.push({ track: id, defaultExact, baselineQHash: qHash, baselineXHash: xHash,
    baselineSpeedHash: speedHash, baselineUnchanged: qHash === digest(path.q) && xHash === digest(path.geometry.x),
    retainedUnchanged: retainedHash === digest(retained.q), cacheSizes, speedsCleared,
    geometryRetainedAfterRebuild: old.geometry === fresh.geometry,
    speedReplacedAfterRebuild: old.speed !== fresh.speed,
    invalidInputsFinite: Number.isFinite(bad.estimatedLapTime), rows });
}
const result = { conditions: { classId: 'gt', tyreCore: 85, tyreSurface: 90, wear: 0,
  fuel: 35, gripUse: .93, sampleMetres: 3, note: 'Static geometry/cache verification; no race pace claim.' }, records };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(records.map(r => ({ track: r.track, defaultExact: r.defaultExact,
  baselineUnchanged: r.baselineUnchanged, retainedUnchanged: r.retainedUnchanged, cacheSizes: r.cacheSizes,
  speedsCleared: r.speedsCleared, geometryRetainedAfterRebuild: r.geometryRetainedAfterRebuild,
  speedReplacedAfterRebuild: r.speedReplacedAfterRebuild, invalidInputsFinite: r.invalidInputsFinite,
  rows: r.rows })), null, 2));
