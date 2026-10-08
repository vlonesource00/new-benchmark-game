// Compare predictions with later real rival positions. This deliberately
// remains a tool: the Cartesian forecast has not earned a production change.
import { RazorCombat } from '../src/combat.js';
import { pathPoint, worldForecast, evaluateWorld } from './forecast-model.mjs';
import { CASES, runEncounter } from './encounters.mjs';

const name = process.argv[2] ?? 'gt3-same-class';
const hz = Number(process.argv[3] ?? 60);
const setup = CASES.find(row => row.name === name);
if (!setup || ![20, 30, 60].includes(hz)) throw new Error('Unknown encounter or invalid cadence');
const worldMode = process.argv.includes('--world');
const bodyHorizon = Number(process.argv.find(a => a.startsWith('--body-horizon='))?.slice(15) ?? 0.6);
const horizons = [0.2, 0.6, 1, 2, 3.4], pending = [], samples = [];
const originalUpdate = RazorCombat.prototype.update, originalEvaluate = RazorCombat.prototype.evaluate;
let last = -1, previous = null;
RazorCombat.prototype.update = function (now, car, c, v, field, ...args) {
  if (car.id === 0) {
    const rival = field.list.find(r => r.id === 1);
    if (rival && previous && now > previous.t) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const point = pending[i];
        if (point.at > now + 1e-8) continue;
        const f = Math.max(0, Math.min(1, (point.at - previous.t) / (now - previous.t)));
        const x = previous.x + (rival.car.x - previous.x) * f;
        const z = previous.z + (rival.car.z - previous.z) * f;
        samples.push({ horizon: point.horizon, origin: point.origin,
          scalar: Math.hypot(point.scalar.x - x, point.scalar.z - z),
          world: Math.hypot(point.world.x - x, point.world.z - z) });
        pending.splice(i, 1);
      }
    }
    previous = rival ? { t: now, x: rival.car.x, z: rival.car.z } : null;
  }
  const out = originalUpdate.call(this, now, car, c, v, field, ...args);
  if (car.id === 0 && now - last > 0.5) {
    last = now;
    const rival = field.list.find(r => r.id === 1);
    if (rival) for (const horizon of horizons) {
      const f = this.forecast(rival, horizon);
      const p = pathPoint(this.driver.line, rival.bi, rival.bf, f.ds - rival.ds);
      pending.push({ at: now + horizon, horizon, origin: car.s,
        scalar: { x: p.x + Math.cos(p.yaw) * f.lat, z: p.z - Math.sin(p.yaw) * f.lat },
        world: worldForecast(this, rival, horizon) });
    }
  }
  return out;
};
if (worldMode) RazorCombat.prototype.evaluate = function (q, car, field, focus) {
  this.driver.options.bodyHorizon = bodyHorizon;
  return evaluateWorld(this, q, car, field, focus);
};
let result;
try { result = runEncounter(setup, { hz, duration: 24 }); }
finally {
  RazorCombat.prototype.update = originalUpdate;
  RazorCombat.prototype.evaluate = originalEvaluate;
}
const rounded = n => Number.isFinite(n) ? +n.toFixed(4) : null;
const percentile = (values, f) => {
  values.sort((a, b) => a - b);
  return rounded(values[Math.floor(values.length * f)]);
};
console.log(JSON.stringify({ case: name, hz, experimentalWorld: worldMode, bodyHorizon,
  encounter: { passedAt: result.passedAt, gain: result.gain, contacts: result.contacts,
    severe: result.severe, off: result.off, errors: result.errors, damage: result.damage },
  errors: horizons.map(horizon => {
    const rows = samples.filter(row => row.horizon === horizon);
    return { horizon, samples: rows.length,
      scalarMedian: percentile(rows.map(row => row.scalar), 0.5),
      worldMedian: percentile(rows.map(row => row.world), 0.5),
      scalarP95: percentile(rows.map(row => row.scalar), 0.95),
      worldP95: percentile(rows.map(row => row.world), 0.95) };
  }) }));
