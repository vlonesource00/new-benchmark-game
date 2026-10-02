// Two independent SOLSTICE drivers. Only initial poses/tyres are fixtures;
// every subsequent movement uses native controls, vehicle, wakes and collisions.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Vehicle, collisions, wakes } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { COMPOUNDS } from '../../../game/core/rules.js';
import { createSolsticeBridge } from '../../../game/bridges/solstice-bridge.js';
import { distance } from '../src/math.js';

const DT = 1 / 120;
const hashes = () => Object.fromEntries([
  ...['driver', 'traffic', 'path', 'policy', 'plant'].map(n => [n, `../src/${n}.js`]),
  ['config', '../config.json'], ['lines', '../data/lines.json'], ['probe', './duel-probe.mjs'],
  ['nativeVehicle', '../../../game/engine/sim/vehicle.js'], ['nativeTyre', '../../../game/engine/sim/tyre.js']
].map(([name, file]) => [name, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]));
const sourceHashes = hashes();

function fixture(track, id, s, q, speed, worn) {
  const car = new Vehicle(id, `DUEL ${id}`, '#ffcf6b', 'gt');
  car.place(track, s, q, speed);
  car.race = { lap: 1, progress: 0, finishTime: null, offtrack: 0, valid: true };
  const c = COMPOUNDS.hard;
  car.wheels.forEach((w, i) => Object.assign(w.tyre, { compound: c.id, gripScale: c.grip,
    optimum: c.optimum, heat: c.heat, wearScale: c.wear, core: c.optimum + 7,
    surface: c.optimum + 10, pressure: 2.15, wear: worn ? (i === 3 ? .75 : .15) : .05 }));
  while (car.gear < 6 && speed / car.spec.radius * car.spec.gears[car.gear] * car.spec.finalDrive * 9.5493 > 7450) car.gear++;
  car.rpm = speed / car.spec.radius * car.spec.gears[car.gear] * car.spec.finalDrive * 9.5493;
  return car;
}

function run(trackId, setup, seconds, hz, freeId = null, scores = false) {
  const track = new Track(trackId);
  const all = [fixture(track, 0, setup.s, 0, setup.speed, false),
    fixture(track, 1, setup.s + setup.gap, 0, setup.leadSpeed ?? setup.speed, setup.worn)];
  const bridges = all.map((_, index) => createSolsticeBridge({ hostTrack: track, index }));
  bridges.forEach(b => b.reset({ cars: all }));
  all.forEach((car, i) => {
    const s = setup.s + (i ? setup.gap : 0), p = bridges[i].driver.path.at(s);
    const q = setup.lanes?.[i] ?? p.offset;
    const pose = setup.lanes ? track.at(s, q) : p;
    // Vehicle.place() resets tyres and gearbox; keep the initialized fixture.
    car.x = pose.x; car.z = pose.z; car.s = pose.s; car.lateral = q;
    car.yaw = pose.heading; car.vx = Math.sin(pose.heading) * car.speed;
    car.vz = Math.cos(pose.heading) * car.speed; car.yawRate = car.speed * pose.curvature;
  });
  const cars = freeId == null ? all : [all[freeId]];
  const evaluations = [];
  if (scores && freeId == null) bridges.forEach((b, id) => {
    const rollout = b.driver.rollout.bind(b.driver);
    b.driver.rollout = (car, proposal, resource) => {
      const cost = rollout(car, proposal, resource);
      evaluations.push({ id, time: b.driver.lastTime, cost, proposal, ...b.driver.lastRollout });
      return cost;
    };
  });
  const metrics = all.map(() => ({ progress: 0, minimumSpeed: Infinity, offtrackSeconds: 0,
    stoppedSeconds: 0, modes: {}, sideChanges: 0, lastSide: null }));
  let previous = all.map(c => track.nearest(c.x, c.z).s), nextUpdate = 0, nextSample = 0;
  let contactSteps = 0, firstClearAt = null, clearedSince = null, passCompletedAt = null;
  const samples = [], incidents = [];
  for (let time = 0; time < seconds - DT / 2; time += DT) {
    const projections = new Map(cars.map(c => [c.id, track.nearest(c.x, c.z)]));
    if (time + 1e-9 >= nextUpdate) {
      cars.forEach(c => bridges[c.id].update(c, cars, 1 / hz, { time, projections, totalLaps: 1 }));
      nextUpdate += 1 / hz;
    }
    const airflow = wakes(cars);
    cars.forEach((c, i) => c.step(DT, track, airflow[i]));
    const contacts = collisions(cars);
    contactSteps += contacts;
    if (contacts) incidents.push({ time, contacts, cars: cars.map(c => ({ id: c.id,
      s: c.s, q: c.lateral, speed: c.speed, yaw: c.yaw, damage: c.damage,
      mode: bridges[c.id].driver.mode, plan: { ...bridges[c.id].driver.selected } })) });
    const p = all.map(c => track.nearest(c.x, c.z));
    const gap = distance(p[1].s, p[0].s, track.length);
    if (freeId == null) {
      if (gap < -12) { firstClearAt ??= time; clearedSince ??= time; }
      else clearedSince = null;
      if (clearedSince != null && time - clearedSince >= 1) passCompletedAt ??= clearedSince;
    }
    cars.forEach(c => {
      const m = metrics[c.id], b = bridges[c.id], e = b.driver.traffic.engagement;
      m.progress += distance(p[c.id].s, previous[c.id], track.length); previous[c.id] = p[c.id].s;
      if (time > .5) m.minimumSpeed = Math.min(m.minimumSpeed, c.speed);
      if (Math.abs(p[c.id].lateral) > track.halfWidth + track.curbWidth) m.offtrackSeconds += DT;
      if (c.speed < 5) m.stoppedSeconds += DT;
      m.modes[b.driver.mode] = (m.modes[b.driver.mode] ?? 0) + DT;
      if (e?.type === 'attack' && e.committed) {
        if (m.lastSide != null && m.lastSide !== e.side) m.sideChanges++;
        m.lastSide = e.side;
      }
    });
    if (time + 1e-9 >= nextSample) {
      samples.push({ time, gap, cars: cars.map(c => { const d = bridges[c.id].driver; return {
        id: c.id, s: p[c.id].s, q: p[c.id].lateral, speed: c.speed, target: d.targetSpeed,
        throttle: c.controls.throttle, brake: c.controls.brake, mode: d.mode, plan: { ...d.selected },
        engagement: d.traffic.engagement && { ...d.traffic.engagement }, cost: d.stats.cost,
        cap: d.traffic.speedCap, bounds: d.bounds, traffic: { ...d.traffic.stats }
      }; }) });
      nextSample += .25;
    }
  }
  return { freeId, contactSteps, firstClearAt, passCompletedAt,
    incidents, metrics: cars.map(c => ({ id: c.id, ...metrics[c.id], damage: c.damage,
      errors: bridges[c.id].errors, finite: Number.isFinite(c.x + c.z + c.speed),
      traffic: { ...bridges[c.id].driver.traffic.stats } })), samples, ...(scores ? { evaluations } : {}) };
}

export function runDuelProbe({ trackId = 'harbor-ring', seconds = 20, hz = 30, filter = null, scores = false } = {}) {
  const cases = [
    { name: 'straight-worn', s: 250, speed: 48, leadSpeed: 42, gap: 28, worn: true },
    { name: 'straight-fresh', s: 250, speed: 50, leadSpeed: 44, gap: 28 },
    { name: 'straight-matched', s: 250, speed: 48, gap: 16 },
    { name: 'braking-worn', s: 620, speed: 52, leadSpeed: 48, gap: 20, worn: true },
    { name: 'exit-worn', s: 740, speed: 32, leadSpeed: 30, gap: 16, worn: true },
    { name: 'sector-1060', s: 1060, speed: 36, leadSpeed: 32, gap: 20, worn: true },
    { name: 'sector-1550', s: 1550, speed: 36, leadSpeed: 32, gap: 20, worn: true },
    { name: 'right-alongside', s: 700, speed: 34, leadSpeed: 34, gap: 2, lanes: [1.6, -1.6], worn: true },
    { name: 'left-alongside', s: 700, speed: 34, leadSpeed: 34, gap: 2, lanes: [-1.6, 1.6], worn: true },
    { name: 'gentle-right', s: 870, speed: 36, leadSpeed: 28, gap: 25, worn: true },
    { name: 'gentle-left', s: 1895, speed: 36, leadSpeed: 28, gap: 25, worn: true }
  ].filter(c => !filter || c.name.includes(filter));
  if (!cases.length || !Number.isFinite(seconds) || seconds <= 0 || ![20, 30, 60, 120].includes(hz)) throw new Error('Invalid duel selection');
  const results = cases.map(setup => {
    const free = [0, 1].map(id => run(trackId, setup, seconds, hz, id));
    const duel = run(trackId, setup, seconds, hz, null, scores);
    return { setup, free, duel, progressRatios: duel.metrics.map((m, i) => m.progress / free[i].metrics[0].progress) };
  });
  return { type: 'solstice-duel', conditions: { track: trackId, seconds, hz, fixedDt: DT,
    compound: 'hard', startingWear: { fresh: [.05, .05, .05, .05], worn: [.15, .15, .15, .75] },
    opponent: 'independent SOLSTICE; no fixed lane or speed cap', sha256: sourceHashes,
    note: 'Native encounter fixtures, not complete races. Matched-pace case is a control, not a guaranteed passing opportunity.' }, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), opts = {}; let output = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--output') output = args[i + 1];
    else if (args[i] === '--case') opts.filter = args[i + 1];
    else if (args[i] === '--track') opts.trackId = args[i + 1];
    else if (args[i] === '--scores') opts.scores = args[i + 1] === '1';
    else if (['--seconds', '--hz'].includes(args[i])) opts[args[i].slice(2)] = Number(args[i + 1]);
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  const report = runDuelProbe(opts);
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report.results.map(({ setup, duel, progressRatios }) => ({ case: setup.name,
    contactSteps: duel.contactSteps, passCompletedAt: duel.passCompletedAt, progressRatios,
    cars: duel.metrics.map(({ modes, ...m }) => m) }))));
}
