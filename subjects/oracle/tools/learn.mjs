// Practice laps that teach ORACLE's line where the car really has grip. Each lap, every stretch of line is scored:
// a slide or a wide moment lowers the grip the profile plans on for the braking zone and corner leading to it;
// a clean, fast stretch raises it a little. The profile is rebuilt between laps; the best lap's line is kept.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/learn.mjs <gt|lmdh> [track] [laps] [json-options] [--save]
import { readFileSync, writeFileSync } from 'node:fs';
import { soloLaps } from './lap.mjs';

const args = process.argv.slice(2), save = args.includes('--save');
const [cls = 'gt', trackName = 'harbor-ring', laps = '12', opts = '{}'] = args.filter((a) => a !== '--save');
const o = JSON.parse(opts.startsWith('@') ? readFileSync(opts.slice(1), 'utf8') : opts);
if (o.linesFile) o.lineData = JSON.parse(readFileSync(o.linesFile, 'utf8'));
const SLIDE = o.learnSlide ?? 0.35, WIDE = o.learnWide ?? 1.6, CUT = o.learnCut ?? 0.95, GAIN = o.learnGain ?? 1.015, BACK = o.learnBack ?? 60;

let line = null, stats = null, lap = -1, best = { time: Infinity, grip: null }, log = [];
const fresh = () => ({ slide: new Float64Array(line.n), wide: new Float64Array(line.n) });
const wall = Date.now();
const r = await soloLaps({ cls, trackName, laps: Number(laps), compound: o.compound ?? 'soft', options: o, onStep: (c, d) => {
  // A test day, not a stint: tyres stay new and the tank stays at the race reference, so every lap is comparable.
  for (const w of c.wheels) w.tyre.wear = 0;
  c.fuel = o.fuel ?? 50;
  if (!d?.trace) return;
  if (!line) { line = d.line; stats = fresh(); }
  if (c.race.lap !== lap) {
    // Score the lap just finished (not the start lap) and teach the line before the next one.
    if (lap >= 1 && Number.isFinite(c.race.lastLap)) {
      const t = c.race.lastLap, clean = c.race.lastState !== 'red' && c.race.lastState !== 'pit';
      log.push(`${t.toFixed(2)}${clean ? '' : '!'}`);
      if (clean && t < best.time) best = { time: t, grip: Float64Array.from(line.grip) };
      teach();
    }
    lap = c.race.lap; stats = fresh();
  }
  const i = d.loc.i; stats.slide[i] = Math.max(stats.slide[i], d.trace.slide); stats.wide[i] = Math.max(stats.wide[i], Math.abs(d.trace.e));
} });

function teach() {
  const n = line.n, back = Math.round(BACK / line.ds), cut = new Float64Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (stats.slide[i] < SLIDE && stats.wide[i] < WIDE) continue;
    // Trouble at i: the braking zone and the turn-in before it were planned too fast.
    for (let j = -back; j <= 4; j++) { const k = (i + j + n) % n, w = 1 - (1 - CUT) * (1 - Math.abs(j) / (back + 1) * 0.5); cut[k] = Math.min(cut[k], w); }
  }
  for (let i = 0; i < n; i++) {
    if (cut[i] < 1) line.grip[i] *= cut[i];
    else if (stats.slide[i] < SLIDE * 0.55 && stats.wide[i] < WIDE * 0.6) line.grip[i] = Math.min(o.learnMax ?? 1.35, line.grip[i] * GAIN);
  }
  // Grip is a property of a stretch of road, not of one point: smooth it.
  for (let p = 0; p < 3; p++) { const g = Float64Array.from(line.grip); for (let i = 0; i < n; i++) line.grip[i] = (g[(i - 1 + n) % n] + 2 * g[i] + g[(i + 1) % n]) / 4; }
  line.build();
}

if (best.grip) { line.grip.set(best.grip); line.build(); }
console.log(`${cls} ${trackName} laps ${log.join(' ')} | best ${best.time.toFixed(2)} model ${line.time.toFixed(2)} grip ${Math.min(...line.grip).toFixed(2)}–${Math.max(...line.grip).toFixed(2)} inc ${r.inc} wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
if (save) {
  const path = o.out ?? new URL('../data/lines.json', import.meta.url); let all = {}; try { all = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  all[`${line.track.id}:${cls}`] = { ...line.data(), best: best.time };
  delete o.lineData;
  writeFileSync(path, JSON.stringify(all));
  console.log('saved', `${line.track.id}:${cls}`);
}
