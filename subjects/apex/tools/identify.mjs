// g-g-v identification of one car class on the real game Vehicle, on a flat test plane.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/identify.mjs <lmdh|gt> [compound] [fuel] [--write]
// Reference state: warm tyres at their optimum core temperature, no wear, `fuel` litres. Records
//   lateral  [v, ay_max]            steady-state peak lateral acceleration (speed held)
//   steer    [v, [steer per 1 m/s²]] steady-state steering map up to the peak
//   brake    [v, decel]             straight-line ABS braking
//   drive    [v, ax]                full-throttle acceleration without hybrid
//   trade    [v, ratio]             braking decel left while holding 80 % of the lateral peak
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { createTyre } from '../../../game/engine/sim/tyre.js';
import { COMPOUNDS } from '../../../game/core/rules.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const cls = process.argv[2] ?? 'lmdh', compound = process.argv[3] ?? 'medium', fuel = Number(process.argv[4] ?? 30), DT = 1 / 120;
const plane = { surface: () => ({ s: 0, lateral: 0, zone: 'asphalt', grip: 1, bump: 0, resistance: 0.013, pit: false, index: 0, nx: 1, nz: 0 }), deposit() {}, barrierOffset: 1e9, ambient: 24 };
function car(speed) {
  const c = new Vehicle(0, 'T', '#fff', cls); c.fuel = fuel;
  const k = COMPOUNDS[compound];
  for (const w of c.wheels) {
    w.tyre = createTyre(c.setup.pressure, { compound, gripScale: k.grip, wearScale: 0, optimum: k.optimum, heat: k.heat, warm: true });
    w.tyre.core = w.tyre.surface = k.optimum; w.tyre.inner = w.tyre.outer = k.optimum;
  }
  c.vz = speed; c.u = speed; c.speed = speed; c.wheels.forEach((w) => { w.omega = speed / c.spec.radius; });
  for (let g = 1; g < c.spec.gears.length; g++) { c.gear = g; const rpm = speed / c.spec.radius * c.spec.gears[g] * c.spec.finalDrive * 9.5493; if (rpm < 7000) break; }
  return c;
}
const hold = (c, v) => { const k = v / Math.max(0.1, Math.hypot(c.vx, c.vz)); c.vx *= k; c.vz *= k; };
function lateral(v) {
  const c = car(v); let best = 0, bestSteer = 0; const map = [], bmap = [];
  for (let t = 0; t < 16; t += DT) {
    const steer = Math.min(1, t / 16), err = v - c.speed;
    c.controls = { steer, throttle: Math.max(0, Math.min(1, 0.3 + err * 0.5)), brake: err < -1 ? Math.min(1, -err * 0.1) : 0 };
    c.step(DT, plane); hold(c, v);
    // keep core temperature at the optimum: the rig measures grip, not heating
    for (const w of c.wheels) { w.tyre.core = w.tyre.surface = COMPOUNDS[compound].optimum; w.tyre.wear = 0; }
    if (Math.abs(c.ay) > best) { best = Math.abs(c.ay); bestSteer = steer; }
    if (Math.abs(c.ay) >= map.length + 1 && Math.abs(c.ay) >= best - 1e-9) { map.push(+steer.toFixed(4)); bmap.push(+Math.atan2(c.v, Math.max(2, c.u)).toFixed(4)); }
  }
  return { ay: best, steer: bestSteer, map, bmap };
}
function braking(v) {
  const c = car(v); c.controls = { steer: 0, throttle: 0, brake: 1 };
  const out = []; for (let t = 0; t < 9 && c.speed > 5; t += DT) { c.step(DT, plane); for (const w of c.wheels) { w.tyre.core = w.tyre.surface = COMPOUNDS[compound].optimum; w.tyre.wear = 0; } if (t > 0.4) out.push([c.speed, -c.ax]); }
  return out;
}
function drive() {
  const c = car(4); c.controls = { steer: 0, throttle: 1, brake: 0 };
  const out = []; for (let t = 0; t < 45; t += DT) { c.step(DT, plane); for (const w of c.wheels) { w.tyre.core = w.tyre.surface = COMPOUNDS[compound].optimum; w.tyre.wear = 0; } out.push([c.speed, c.ax]); if (c.speed > 100) break; }
  return out;
}
// Brake at the limit while a steady turn holds `frac` of the lateral peak.
function trade(v, steer, frac) {
  const c = car(v); let dec = 0, n = 0;
  for (let t = 0; t < 3; t += DT) {
    c.controls = { steer: steer * Math.min(1, t / 0.6), throttle: 0, brake: t < 0.8 ? 0 : 1 };
    c.step(DT, plane); for (const w of c.wheels) { w.tyre.core = w.tyre.surface = COMPOUNDS[compound].optimum; w.tyre.wear = 0; }
    if (t > 1.2 && c.speed > 0.8 * v) { dec += -c.ax; n++; }
  }
  return n ? dec / n : 0;
}
const bins = (rows, step = 5) => { const m = new Map(); for (const [v, a] of rows) { const k = Math.round(v / step) * step; m.set(k, Math.max(m.get(k) ?? -1e9, a)); } return [...m].sort((a, b) => a[0] - b[0]); };
const speeds = [8, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
const lat = speeds.map((v) => [v, lateral(v)]);
console.log('lateral', cls, compound, fuel, lat.map(([v, r]) => `${v}:${r.ay.toFixed(2)}@${r.steer.toFixed(2)}`).join(' '));
const br = bins([30, 50, 70, 90].flatMap(braking));
console.log('brake', br.map(([v, a]) => `${v}:${a.toFixed(2)}`).join(' '));
const dr = bins(drive());
console.log('drive', dr.map(([v, a]) => `${v}:${a.toFixed(2)}`).join(' '));
const tr = [20, 35, 50, 65].map((v) => { const r = lat.find(([s]) => s === v) ?? lat.find(([s]) => s >= v); const m = r[1].map, steer = m.length ? m[Math.max(0, Math.floor(m.length * 0.8) - 1)] : 0.2; const d = trade(v, steer, 0.8); return [v, +d.toFixed(2)]; });
console.log('trade (decel while turning at ~80% steer map)', tr.map(([v, a]) => `${v}:${a}`).join(' '));
if (process.argv.includes('--write')) {
  const file = new URL('../data/ggv.json', import.meta.url), all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  all[cls] = { compound, fuel, lateral: lat.map(([v, r]) => [v, +r.ay.toFixed(3)]), steer: lat.map(([v, r]) => [v, r.map]), beta: lat.map(([v, r]) => [v, r.bmap]), brake: br.map(([v, a]) => [v, +a.toFixed(3)]), drive: dr.map(([v, a]) => [v, +a.toFixed(3)]) };
  writeFileSync(file, JSON.stringify(all));
}
