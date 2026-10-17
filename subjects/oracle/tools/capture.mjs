// A driven lap as a line: any AI's car path on one flying lap, turned into ORACLE offsets on its reference frame, so
// the model can time a line the real car is known to drive (and the search can start from it).
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/capture.mjs <ai> <cls> <track> [lap] [out] [smooth]
import { readFileSync, writeFileSync } from 'node:fs';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { envelope } from '../src/envelope.js';
import { Line } from '../src/line.js';
import { bench } from './bench.mjs';
import { roughness, smoothOffsets } from './resolve.mjs';

export async function capture(ai, cls, trackName, lap = 2) {
  const pts = []; let track = null;
  await bench({ ais: [ai], cls, trackName, laps: lap + 1, raceLaps: 12, compound: 'hard', onStep: (race) => { track ??= race.track; const c = race.cars[0]; if (c.race.lap === lap) pts.push([c.x, c.z]); } });
  const L = new Line(track, carSpecFor(cls), envelope(cls), null, { refPasses: undefined, latScale: 1, noSeed: true });
  const n = L.n, w = new Float64Array(n), got = new Uint8Array(n);
  // Station i takes the path where it crosses that station's normal (the sign change of the along-track coordinate).
  let hint = -1;
  for (let p = 1; p < pts.length; p++) {
    const [x0, z0] = pts[p - 1], [x1, z1] = pts[p], loc = L.locateRef(x1, z1, hint); hint = loc;
    for (let d = -3; d <= 3; d++) {
      const i = (loc + d + n) % n, tx = -L.nz[i], tz = L.nx[i];
      const a0 = (x0 - L.cx[i]) * tx + (z0 - L.cz[i]) * tz, a1 = (x1 - L.cx[i]) * tx + (z1 - L.cz[i]) * tz;
      if (a0 <= 0 && a1 > 0 || a0 >= 0 && a1 < 0) { const u = a0 / (a0 - a1), x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * u; w[i] = (x - L.cx[i]) * L.nx[i] + (z - L.cz[i]) * L.nz[i]; got[i] = 1; }
    }
  }
  for (let i = 0; i < n; i++) if (!got[i]) { let a = i, b = i; while (!got[(a - 1 + n) % n] && a > i - n) a--; while (!got[(b + 1) % n] && b < i + n) b++; const wa = w[(a - 1 + n) % n], wb = w[(b + 1) % n]; w[i] = wa + (wb - wa) * (i - a + 1) / (b - a + 2); }
  L.w.set(w); L.build();
  return L;
}

if (process.argv[1]?.endsWith('capture.mjs')) {
  const [ai = 'intercept', cls = 'gt', trackName = 'harbor-ring', lap = '2', out = '', smooth = '0'] = process.argv.slice(2);
  const L = await capture(ai, cls, trackName, Number(lap));
  console.log(`${ai} ${cls} ${trackName} model ${L.time.toFixed(2)} rough ${roughness(L).toFixed(2)}`);
  if (+smooth) { smoothOffsets(L, +smooth); L.build(); console.log(`smoothed ${smooth}: model ${L.time.toFixed(2)} rough ${roughness(L).toFixed(2)}`); }
  if (out) { let all = {}; try { all = JSON.parse(readFileSync(out, 'utf8')); } catch {} all[`${L.track.id}:${cls}`] = { ...L.data(), source: ai }; writeFileSync(out, JSON.stringify(all)); console.log('saved', out); }
}
