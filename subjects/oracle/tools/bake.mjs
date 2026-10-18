// Physics-in-the-loop line bake. ORACLE's forward model of its own car is the game's Vehicle itself, so a change
// to the line is judged by driving it: from a state recorded on a real lap, a shadow copy of the car and of the
// driver runs through the corner on the exact physics, and the clock to a point well past the exit decides.
// Offsets (where the car goes) and the per-point grip plan (how fast it goes) are both searched, a corner window at
// a time, so the line the bake keeps is one ORACLE's own controller really drives at that speed.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/bake.mjs <gt|lmdh> [track] [json-options]
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { envelope } from '../src/envelope.js';
import { Line, rng } from '../src/line.js';
import { lineData } from '../src/store.js';
import { cloneCar, cloneDriver } from '../src/shadow.js';
import { soloLaps } from './lap.mjs';
import { bench, jsonArg } from './bench.mjs';

const DT = 1 / 120;

export async function bake({ cls = 'gt', trackName = 'harbor-ring', o = {} }) {
  const track = new Track(trackName), env = envelope(cls), base0 = o.from ? JSON.parse(readFileSync(o.from, 'utf8'))[`${track.id}:${cls}`] : lineData(track.id, cls);
  // A new edge margin (o.edge, metres inside the tarmac the car centre keeps; negative is onto the kerb) measures the
  // bounds afresh; the offsets carry over.
  const base = base0 && o.edge != null ? { ...base0, lo: null, hi: null, fine: false } : base0;
  // Start from a baked line, or from the model's own minimum-time solve when there is none (o.solve iterations).
  const line = new Line(track, carSpecFor(cls), env, base && !o.solve ? { ...base, latScale: o.latScale ?? base.latScale, grip: o.flat ? new Array(base.n).fill(1) : base.grip } : null, o);
  if (o.solve || !base) { const r = line.solve(o.solve ?? 150000, o.seed ?? 1); console.log(`solved model ${r.time.toFixed(2)} (start ${r.start})`); }
  const shadow = Object.create(track); shadow.deposit = () => 0;
  const n = line.n, ds = line.ds, L = track.length, rand = rng(o.seed ?? 5);
  const WIN = o.win ?? 300, PRE = o.pre ?? 100, POST = o.post ?? 160, STRIDE = o.stride ?? 150, TRIALS = o.trials ?? 120, LIMIT = track.halfWidth + track.curbWidth * (o.kerb ?? 0.7);
  const fwd = (a, b) => ((b - a) % L + L) % L;
  // The states at every window's start, recorded on a real flying lap.
  async function record() {
    const snaps = new Map(), starts = [];
    for (let a = 0; a < L - STRIDE / 2; a += STRIDE) starts.push(a);
    // The benchmark's own race (alien difficulty, clear weather, hard tyres calibrated to a 12-lap race), so the
    // bake and the yardstick agree on what a lap costs.
    let lap = 0;
    const rows = await bench({ ais: ['oracle'], cls, trackName, laps: o.checkLaps ?? 3, raceLaps: 12, compound: o.compound ?? 'hard', oracle: { guard: false, ...o, line }, onStep: (race, drivers) => {
      const c = race.cars[0], d = drivers.get(c);
      if (c.race.lap !== 2 || !d?.loc) return;
      for (const a of starts) { const s0 = ((a - PRE) % L + L) % L; if (!snaps.has(a) && fwd(s0, d.loc.s) < 8) snaps.set(a, { car: cloneCar(c), drv: cloneDriver(d, { forceLane: 0 }), s0 }); }
    } });
    const row = rows[0], fly = row.laps.slice(1).filter((t) => t != null), r = { inc: row.inc };
    const bad = row.inc > 0 || row.red > 0 || !fly.length;
    // wearCost: the worst tyre's wear per lap is priced in seconds per unit, so the best pass is the best stint.
    lap = bad ? Infinity : fly.reduce((a, x) => a + x, 0) / fly.length + (o.wearCost ?? 0) * row.wear / 100 / (o.checkLaps ?? 3);
    return { snaps, lap, laps: fly.map((x) => x.toFixed(2)).join(' '), inc: r.inc };
  }
  // Clock from the snapshot to the end of the window plus the exit run; a slide or an off fails the trial.
  function drive(snap, endS) {
    const c = cloneCar(snap.car), d = cloneDriver(snap.drv), total = fwd(snap.s0, endS);
    // Slide and kerb-overrun time are priced (a slide costs tyre and risk the clock does not show); a spin or a car
    // past the stewards' line is a failure.
    let t = 0, slip = 0, wide = 0;
    // wearCost (s per unit of the worst tyre's wear): a line that saves a hundredth by sliding the tyres pays for it
    // on every later lap of the stint, so the trial's clock carries that cost.
    const w0 = c.wheels.map((w) => w.tyre.wear), worn = () => (o.wearCost ? o.wearCost * Math.max(...c.wheels.map((w, k) => w.tyre.wear - w0[k])) : 0);
    while (t < 40) {
      d.update(c, [c], DT, {}); c.step(DT, shadow); t += DT;
      const b = Math.abs(Math.atan2(c.v, Math.max(2, c.u))), lat = Math.abs(track.nearest(c.x, c.z).lateral);
      if (b > (o.slideB ?? 0.3)) slip += DT;
      if (lat > LIMIT) wide += DT;
      if (b > 0.9 || lat > track.halfWidth + track.curbWidth + 0.8) return Infinity;
      const done = fwd(snap.s0, d.loc.s); if (done >= total && done < total + 60) return t + slip * (o.slipCost ?? 1.5) + wide * (o.wideCost ?? 4) + worn();
    }
    return Infinity;
  }
  let keep = null;
  for (let pass = 0; pass < (o.passes ?? 2); pass++) {
    const { snaps, lap, laps, inc } = await record();
    console.log(`pass ${pass} laps ${laps} inc ${inc} model ${line.time.toFixed(2)}`);
    // Windows interact (a quicker exit is a different entry to the next corner): the best whole lap is kept.
    if (!keep || lap < keep.lap) keep = { lap, w: Float64Array.from(line.w), grip: Float64Array.from(line.grip) };
    for (const [a, snap] of snaps) {
      const endS = (a + WIN + POST + (o.bigRate ? 120 : 0)) % L, i0 = Math.round(a / ds), m = Math.round(WIN / ds);
      let best = drive(snap, endS), kept = 0;
      const start = best;
      for (let t = 0; t < TRIALS; t++) {
        const heat = 1 - t / TRIALS, c = i0 + Math.floor(rand() * m), grip = rand() < (o.gripRate ?? 0.4);
        // Corner-scale moves as well as local ones: a whole corner taken a few metres wider or tighter is a different
        // line that small nudges never reach.
        const big = !grip && rand() < (o.bigRate ?? 0);
        const sigma = big ? 15 + rand() * 40 : 3 + rand() * 22 * heat, span = Math.ceil(sigma * 2.5);
        const amp = grip ? (rand() * 2 - 1) * (0.006 + 0.04 * heat * rand()) : big ? (rand() * 2 - 1) * (1 + 3 * heat * rand()) : (rand() * 2 - 1) * (0.15 + 1.6 * heat * rand());
        const save = [];
        for (let k = -span; k <= span; k++) {
          const i = ((c + k) % n + n) % n, g = Math.exp(-0.5 * (k / sigma) ** 2); save.push([i, line.w[i], line.grip[i]]);
          if (grip) line.grip[i] = Math.min(o.gripMax ?? 1.25, Math.max(0.7, line.grip[i] * (1 + amp * g)));
          else line.w[i] = Math.min(line.hi[i], Math.max(line.lo[i], line.w[i] + amp * g));
        }
        line.build();
        const tt = drive(snap, endS);
        if (tt < best - 1e-4) { best = tt; kept++; } else { for (const [i, w, g] of save) { line.w[i] = w; line.grip[i] = g; } line.build(); }
      }
      if (o.verbose) console.log(`  win ${a} ${start.toFixed(3)} -> ${best.toFixed(3)} kept ${kept}`);
    }
  }
  const fin = await record();
  console.log(`final laps ${fin.laps} inc ${fin.inc} model ${line.time.toFixed(2)}`);
  if (keep && keep.lap < fin.lap) { line.w.set(keep.w); line.grip.set(keep.grip); line.build(); console.log(`kept the best pass: ${keep.lap.toFixed(2)}`); return { line, lap: keep.lap }; }
  return { line, lap: fin.lap };
}

if (process.argv[1]?.endsWith('bake.mjs')) {
  const [cls = 'gt', trackName = 'harbor-ring', opts = '{}'] = process.argv.slice(2), o = jsonArg(opts), wall = Date.now();
  const { line, lap } = await bake({ cls, trackName, o });
  console.log(`wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
  if (o.out) {
    let all = {}; try { all = JSON.parse(readFileSync(o.out, 'utf8')); } catch {}
    all[`${line.track.id}:${cls}`] = { ...line.data(), best: lap }; writeFileSync(o.out, JSON.stringify(all)); console.log('saved', o.out);
  }
}
