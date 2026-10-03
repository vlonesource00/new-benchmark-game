// g-g-v identification on a flat test plane with the real game Vehicle.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/identify.mjs <lmdh|gt> [compound]
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { createTyre } from '../../../game/engine/sim/tyre.js';
import { COMPOUNDS } from '../../../game/core/rules.js';

const cls = process.argv[2] ?? 'lmdh', compound = process.argv[3] ?? 'soft', DT = 1 / 120;
const plane = { surface: () => ({ s: 0, lateral: 0, zone: 'asphalt', grip: 1, bump: 0, resistance: 0.013, pit: false, index: 0, nx: 1, nz: 0 }), deposit() {}, barrierOffset: 1e9, ambient: 24 };
function car(speed) {
  const c = new Vehicle(0, 'T', '#fff', cls); c.fuel = 40;
  const k = COMPOUNDS[compound];
  for (const w of c.wheels) w.tyre = createTyre(c.setup.pressure, { compound, gripScale: k.grip, wearScale: 0, optimum: k.optimum, heat: k.heat, warm: true });
  c.vz = speed; c.u = speed; c.speed = speed; c.wheels.forEach((w) => { w.omega = speed / c.spec.radius; });
  for (let g = 1; g < c.spec.gears.length; g++) { c.gear = g; const rpm = speed / c.spec.radius * c.spec.gears[g] * c.spec.finalDrive * 9.5493; if (rpm < 7000) break; }
  return c;
}
// Lateral: hold speed, ramp steer slowly, record the best steady ay.
function lateral(v) {
  const c = car(v); let best = 0, bestSteer = 0; const map = [];
  for (let t = 0; t < 14; t += DT) {
    const steer = Math.min(1, t / 14);
    const err = v - c.speed;
    c.controls = { steer, throttle: Math.max(0, Math.min(1, 0.3 + err * 0.5)), brake: err < -1 ? Math.min(1, -err * 0.1) : 0 };
    c.step(DT, plane);
    // Test rig: speed is held exactly, so only lateral capacity is measured.
    const k = v / Math.max(0.1, Math.hypot(c.vx, c.vz)); c.vx *= k; c.vz *= k;
    if (Math.abs(c.ay) > best) { best = Math.abs(c.ay); bestSteer = steer; }
    // Steady-state steer needed for each 1 m/s² of lateral acceleration, up to the peak.
    if (Math.abs(c.ay) >= map.length + 1 && Math.abs(c.ay) >= best - 1e-9) map.push(+steer.toFixed(4));
  }
  return { ay: best, steer: bestSteer, map };
}
function braking(v) {
  const c = car(v); c.controls = { steer: 0, throttle: 0, brake: 1 };
  const out = []; for (let t = 0; t < 8 && c.speed > 5; t += DT) { c.step(DT, plane); if (t > 0.4) out.push([c.speed, -c.ax]); }
  return out;
}
function traction() {
  const c = car(4); c.controls = { steer: 0, throttle: 1, brake: 0 };
  const out = []; for (let t = 0; t < 40; t += DT) { c.step(DT, plane); out.push([c.speed, c.ax]); }
  return out;
}
const bins = (rows, step = 5) => { const m = new Map(); for (const [v, a] of rows) { const k = Math.round(v / step) * step; m.set(k, Math.max(m.get(k) ?? -1e9, a)); } return [...m].sort((a, b) => a[0] - b[0]); };
const out = { lateral: [], steer: [], brake: [], drive: [] };
const lat = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80].map((v) => [v, lateral(v)]);
console.log('lateral', cls, compound, lat.map(([v, r]) => `${v}:${r.ay.toFixed(1)}@${r.steer.toFixed(2)}`).join(' '));
out.lateral = lat.map(([v, r]) => [v, +r.ay.toFixed(2)]); out.steer = lat.map(([v, r]) => [v, r.map]);
const br = bins([20, 40, 60, 80].flatMap(braking));
console.log('brake', br.map(([v, a]) => `${v}:${a.toFixed(1)}`).join(' '));
const dr = bins(traction());
console.log('drive', dr.map(([v, a]) => `${v}:${a.toFixed(1)}`).join(' '));
out.brake = br.map(([v, a]) => [v, +a.toFixed(2)]); out.drive = dr.map(([v, a]) => [v, +a.toFixed(2)]);
if (process.argv.includes('--write')) {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const file = new URL('../data/ggv.json', import.meta.url);
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  all[cls] = { compound, ...out };
  writeFileSync(file, JSON.stringify(all));
}
