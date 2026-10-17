// Measured grip map: the lap is cut into stretches, and each stretch's planned grip is nudged up or down in turn.
// A nudge is kept only when real laps through the full race loop (fresh race, same start every trial, so the
// comparison is exact) get quicker and stay clean. Slow but honest: every number in the map was driven.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/tune.mjs <gt|lmdh> [track] [sweeps] [json-options] [--save]
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { envelope } from '../src/envelope.js';
import { Line, rng } from '../src/line.js';
import { lineData } from '../src/store.js';
import { soloLaps } from './lap.mjs';

const args = process.argv.slice(2), save = args.includes('--save');
const [cls = 'gt', trackName = 'harbor-ring', sweeps = '3', opts = '{}'] = args.filter((a) => a !== '--save');
const o = JSON.parse(opts), track = new Track(trackName), env = envelope(cls), SEG = o.segment ?? 100, LAPS = o.laps ?? 3;
const key = `${track.id}:${cls}`, base = o.from ? JSON.parse(readFileSync(o.from, 'utf8'))[key] : lineData(track.id, cls);
if (!base) throw new Error(`no stored line for ${track.id}:${cls}; bake one with learn.mjs --save first`);
let w = Float64Array.from(base.w);
const make = (grip, ww = w) => new Line(track, carSpecFor(cls), env, { ...base, w: Array.from(ww), grip: Array.from(grip) }, o);

/** Score of a grip map: mean of the timed laps after the first, with a heavy price for any unclean lap. */
async function score(grip, line = make(grip)) {
  const r = await soloLaps({ cls, trackName, laps: LAPS, compound: o.compound ?? 'hard', options: { ...o, line } });
  const timed = r.rows.slice(1);
  if (!timed.length) return Infinity;
  return timed.reduce((a, x) => a + (x.state === 'red' || x.state === 'pit' ? x.time + 20 : x.time), 0) / timed.length + r.inc * 0.5;
}

const n = base.n, grip = Float64Array.from(base.grip?.length === n ? base.grip : new Array(n).fill(1)), ds = track.length / n;
const segs = Math.round(track.length / SEG), wall = Date.now();
let best = await score(grip); console.log('start', best.toFixed(3));
let step = o.step ?? 0.04;
for (let sw = 0; sw < Number(sweeps); sw++) {
  let gains = 0;
  for (let k = 0; k < segs; k++) {
    for (const dir of [1, -1]) {
      const trial = Float64Array.from(grip), c = (k + 0.5) * SEG / ds, half = SEG / ds;
      // A smooth bump over the stretch, so the profile has no step at its edges.
      for (let d = -Math.ceil(half * 1.5); d <= Math.ceil(half * 1.5); d++) { const i = ((Math.round(c) + d) % n + n) % n, x = Math.abs(d) / half; if (x < 1.5) trial[i] *= 1 + dir * step * (x < 0.5 ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (x - 0.5))); }
      const s = await score(trial);
      if (s < best - 0.005) { best = s; grip.set(trial); gains++; break; }
    }
  }
  console.log(`sweep ${sw + 1} step ${step.toFixed(3)} best ${best.toFixed(3)} gains ${gains} grip ${Math.min(...grip).toFixed(2)}–${Math.max(...grip).toFixed(2)} wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
  if (!gains) { if (step > (o.minStep ?? 0.012)) step /= 2; else break; }
}
// Measured basin hopping: a stretch of line is moved and re-polished in the model, then real laps decide.
if (o.hops) {
  const rand = rng(o.hopSeed ?? 11); let kept = 0;
  for (let h = 0; h < o.hops; h++) {
    const L = make(grip); const p = L.perturb(rand, o.hopPolish ?? 2500, 1000 + h);
    const s = await score(grip, L);
    if (s < best - 0.01) { best = s; w = Float64Array.from(L.w); kept++; console.log(`hop ${h} at ${(p.c * ds).toFixed(0)} m kind ${p.kind} -> ${best.toFixed(3)}`); }
  }
  console.log(`hops ${o.hops} kept ${kept} best ${best.toFixed(3)} wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
}
if (save) {
  const path = o.out ?? new URL('../data/lines.json', import.meta.url); let all = {}; try { all = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const L = make(grip); all[key] = { ...L.data(), tuned: +best.toFixed(3) };
  writeFileSync(path, JSON.stringify(all)); console.log('saved', `${track.id}:${cls}`);
}
