// Test-only C2 delayed departure. Neither the production driver nor its
// browser worker imports this module. Retain failures as measurable evidence.
import { clamp, angle } from '../../apex/src/math.js';
import { RazorCombat } from '../src/combat.js';
import { Corridors } from '../src/corridor.js';

const smooth = t => { t = clamp(t, 0, 1); return t * t * t * (10 + t * (-15 + 6 * t)); };
const originalBuild = Corridors.prototype.build;
const originalMake = RazorCombat.prototype.make;
const originalNeighbor = RazorCombat.prototype.neighbor;
let source = originalBuild.toString();
function replace(before, after) {
  if (!source.includes(before)) throw new Error('Departure experiment no longer matches the corridor implementation');
  source = source.replace(before, after);
}
replace('build(car, c, goal, entry, hold, active = null)', 'function build(car, c, goal, entry, hold, active = null, wait = 0)');
replace('entry + hold + Math.max(50, v * 1.5)', 'wait + entry + hold + Math.max(50, v * 1.5)');
replace('Math.max(entry, Math.min(entry + hold,', 'Math.max(wait + entry, Math.min(wait + entry + hold,');
replace('const t = clamp(x / entry, 0, 1), S = smooth(t);', 'const t = clamp((x - wait) / entry, 0, 1), S = smooth(t);');
replace('const initial = d0 * (1 - S) + slope * entry * h1 + curve * entry * entry * h2;',
  'const initial = (d0 + slope * wait + 0.5 * curve * wait * wait) * (1 - S) + (slope + curve * wait) * entry * h1 + curve * entry * entry * h2;');
replace('return (initial + target * S) * tail;', 'return (x < wait ? d0 + slope * x + 0.5 * curve * x * x : initial + target * S) * tail;');
replace('entry, total, n };', 'entry: entry + wait, wait, total, n };');
const delayedBuild = Function('clamp', 'angle', 'smooth', 'return (' + source + ')')(clamp, angle, smooth);
const neighborSource = originalNeighbor.toString()
  .replace('neighbor(v) {', 'function neighbor(v) {')
  .replace('const width = this.car.spec.halfWidth ?? 0.98;',
    'const width = this.driver.options.projectedGuard ? (this.ownWidth ?? this.car.spec.halfWidth ?? 0.98) : (this.car.spec.halfWidth ?? 0.98);');
if (!originalNeighbor.toString().includes('const width = this.car.spec.halfWidth ?? 0.98;')) throw new Error('Body-guard experiment no longer matches the controller');
const projectedNeighbor = Function('clamp', 'return (' + neighborSource + ')')(clamp);
const originalClearance = "const clearance = kind === 'attack' && room ? d.options.passClearance ?? 0.14 : 0.14;";
const makeSource = originalMake.toString().replace('make(car, c, r, side, kind, active) {',
  'function make(car, c, r, side, kind, active) {').replace(originalClearance,
  "const clearance = kind === 'attack' && room ? d.options.passClearance ?? 0.14 : kind === 'attack' && d.options.retainClearance && this.plan?.kind === 'attack' && this.plan.target === r.id ? this.plan.clearance ?? 0.14 : 0.14;");
if (!originalMake.toString().includes(originalClearance)) throw new Error('Clearance experiment no longer matches the planner');
const retainedMake = Function('clamp', 'return (' + makeSource + ')')(clamp);

function timedNeighbor(v) {
  if (!this.driver.options.timedGuard) return projectedNeighbor.call(this, v);
  if (!this.field || !this.car) return null;
  const d = this.driver, car = this.car, pose = d.controlPose ?? car;
  const r = this.field.list.find(row => row.alongside && Math.abs(row.dlat) < car.spec.halfWidth + row.width + 0.8);
  if (!r) return null;
  const base = d.line, path = d.path ?? base, delay = Math.max(0, Math.min(0.06, d.delay ?? 0));
  const b = base.closest(pose.x, pose.z, d.cursor), h = base.heading(b.i, b.f);
  const otherYaw = r.car.yaw + r.car.yawRate * delay;
  const dx = r.car.x + r.car.vx * delay - pose.x, dz = r.car.z + r.car.vz * delay - pose.z;
  const across = dx * Math.cos(h) - dz * Math.sin(h), ahead = dx * Math.sin(h) + dz * Math.cos(h);
  const ownAngle = pose.yaw - h, otherAngle = otherYaw - h;
  const width = car.spec.halfWidth * Math.abs(Math.cos(ownAngle)) + car.spec.halfLength * Math.abs(Math.sin(ownAngle));
  const otherWidth = r.halfWidth * Math.abs(Math.cos(otherAngle)) + r.halfLength * Math.abs(Math.sin(otherAngle));
  const gap = Math.abs(across) - width - otherWidth, dir = Math.sign(across);
  const q = path.closest(pose.x, pose.z, d.cur?.i ?? this.me.i);
  const legacySlope = clamp((path.sample(path.lat, path.idx(q.i + 2), q.f) - path.sample(path.lat, path.idx(q.i - 2), q.f)) / (4 * path.ds), -0.6, 0.6);
  const sweep = Math.sin(path.heading(q.i, q.f) - h);
  const rivalLateral = r.car.vx * Math.cos(h) - r.car.vz * Math.sin(h)
    - ahead * v * base.sample(base.ks, b.i, b.f);
  return { id: r.id, dir, gap, rate: Math.max(-0.25, (gap + 0.06) / 0.35) + dir * (rivalLateral + v * (legacySlope - sweep)) };
}

export function installDepartureExperiment() {
  RazorCombat.prototype.neighbor = timedNeighbor;
  RazorCombat.prototype.make = function (car, c, rival, side, kind, active) {
    const fresh = this.plan?.kind !== 'attack' || this.plan.target !== rival.id;
    this.corridors.departureRival = kind === 'attack' && fresh ? rival : null;
    let q;
    try { q = retainedMake.call(this, car, c, rival, side, kind, active); }
    finally { this.corridors.departureRival = null; }
    if (q.wait > 0) q.rebuildAt += q.wait / Math.max(12, car.speed);
    return q;
  };
  Corridors.prototype.build = function (car, c, goal, entry, hold, active) {
    const d = this.driver, r = this.departureRival, maxDelay = d.options.departureDelay ?? 0;
    let wait = 0;
    if (maxDelay > 0 && r?.target && r.cls === car.classId && !r.alongside && !r.hazard
      && Math.abs(r.dlat) < 0.8 && car.speed > r.v + 0.5) {
      const gap = r.ds - r.along - (car.spec.halfLength ?? 2.28) - 1;
      const closing = Math.max(0.5, car.speed - r.v);
      const formation = entry / Math.max(12, car.speed);
      const delay = Math.min(maxDelay, Math.max(0, Math.min(1.65, gap / closing - 0.2) - formation));
      wait = car.speed * delay;
    }
    return wait > 0 ? delayedBuild.call(this, car, c, goal, entry, hold, active, wait)
      : originalBuild.call(this, car, c, goal, entry, hold, active);
  };
  return () => {
    RazorCombat.prototype.make = originalMake;
    Corridors.prototype.build = originalBuild;
    RazorCombat.prototype.neighbor = originalNeighbor;
  };
}
