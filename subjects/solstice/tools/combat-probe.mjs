// Controlled encounters on native vehicle, tyre, wake and collision physics.
// Initial placement/tyres are fixtures; subsequent motion comes from controls.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Vehicle, collisions, wakes } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { COMPOUNDS } from '../../../game/core/rules.js';
import { createSolsticeBridge } from '../../../game/bridges/solstice-bridge.js';
import { RacingPath } from '../src/path.js';
import { ForcePolicy } from '../src/policy.js';
import { distance } from '../src/math.js';
import { runBenchmark } from './bench.mjs';

const DT = 1 / 120;
const sourceHashes = Object.freeze(Object.fromEntries([
  ...['traffic', 'driver', 'policy', 'path'].map(name => [name, `../src/${name}.js`]),
  ['config', '../config.json'], ['lines', '../data/lines.json'],
  ['nativeVehicle', '../../../game/engine/sim/vehicle.js'],
  ['nativeTyre', '../../../game/engine/sim/tyre.js'], ['nativeTrack', '../../../game/engine/sim/track.js'],
  ['probe', './combat-probe.mjs']
].map(([name, path]) => [name, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')])));
function fixture(track, id, s, q, speed, worn = false) {
  const car = new Vehicle(id, `PROBE ${id}`, '#abcdef', 'gt');
  car.place(track, s, q, speed);
  car.race = { lap: 1, progress: 0, finishTime: null, offtrack: 0, valid: true };
  const compound = COMPOUNDS.hard;
  for (const [i, wheel] of car.wheels.entries()) Object.assign(wheel.tyre, {
    compound: compound.id, gripScale: compound.grip, optimum: compound.optimum,
    heat: compound.heat, wearScale: compound.wear, core: compound.optimum + 7,
    surface: compound.optimum + 10, pressure: 2.15,
    wear: worn ? (i === 3 ? .75 : .15) : .05
  });
  while (car.gear < 6 && speed / car.spec.radius * car.spec.gears[car.gear] * car.spec.finalDrive * 9.5493 > 7450) car.gear++;
  car.rpm = speed / car.spec.radius * car.spec.gears[car.gear] * car.spec.finalDrive * 9.5493;
  return car;
}

function encounters(track, path) {
  const gentle = side => {
    const points = Array.from({ length: Math.floor(track.length / 5) }, (_, i) => i * 5)
      .filter(s => side * track.at(s).curvature > .001 && side * track.at(s).curvature < .004
        && path.at(s).speed > 32 && Math.abs(track.at(s + 60).curvature) < .012);
    return points.sort((a, b) => Math.abs(track.at(a).curvature - side * .002)
      - Math.abs(track.at(b).curvature - side * .002))[0];
  };
  return [
    { name: 'straight', s: 250, speed: 48, rivalSpeed: 34, gap: 40 },
    { name: 'straight-late', s: 250, speed: 48, rivalSpeed: 34, gap: 22 },
    { name: 'straight-offset', s: 320, speed: 44, rivalSpeed: 32, gap: 35, lane: 1 },
    ...[1, -1].map(side => ({ name: `gentle-${side > 0 ? 'right' : 'left'}`,
      s: gentle(side), speed: 36, rivalSpeed: 26, gap: 35 })),
    { name: 'defend-t1', s: 700, speed: 36, rivalSpeed: 42, gap: -22, worn: true },
    { name: 'defend-braking', s: 620, speed: 54, rivalSpeed: 60, gap: -22, worn: true },
    { name: 'defend-close', s: 620, speed: 54, rivalSpeed: 60, gap: -14, worn: true },
    { name: 'defend-corner', s: 1650, speed: 30, rivalSpeed: 36, gap: -22, worn: true }
  ].filter(c => Number.isFinite(c.s));
}

function runEncounter(trackId, setup, seconds, hz, free = false, scores = false) {
  const track = new Track(trackId);
  const seedCar = fixture(track, 0, setup.s, 0, setup.speed, setup.worn);
  const bridge = createSolsticeBridge({ hostTrack: track });
  bridge.reset({ cars: [seedCar] });
  const line = bridge.driver.path;
  const self = fixture(track, 0, setup.s, line.at(setup.s).offset, setup.speed, setup.worn);
  const start = line.at(setup.s);
  self.yaw = start.heading; self.vx = Math.sin(start.heading) * setup.speed;
  self.vz = Math.cos(start.heading) * setup.speed; self.yawRate = setup.speed * start.curvature;
  const rivalLane = setup.lane ?? line.at(setup.s + setup.gap).offset;
  const rival = fixture(track, 1, setup.s + setup.gap, rivalLane,
    setup.rivalSpeed);
  const rivalPath = new RacingPath(track, { car: rival }); rivalPath.rebuildEnvelope(rival, .9);
  const rivalPolicy = new ForcePolicy(track, rivalPath, { courseForceLimit: .9, actualBrakeReserve: true });
  const evaluations = [];
  if (scores && !free) {
    const evaluate = bridge.driver.rollout.bind(bridge.driver);
    bridge.driver.rollout = (car, proposal, resource) => {
      const score = evaluate(car, proposal, resource), d = bridge.driver;
      const p = track.nearest(d.shadow.x, d.shadow.z), rival = d.traffic.list[0];
      evaluations.push({ time: d.lastTime, proposal, score, ...d.lastRollout,
        endS: p.s, endQ: p.lateral, endGap: rival ? d.traffic.delta(d.traffic.predict(rival,
          d.o.horizon).s, p.s) : null });
      return score;
    };
  }
  const cars = free ? [self] : [self, rival];
  let previous = track.nearest(self.x, self.z).s, progress = 0, contactSteps = 0, offtrackSeconds = 0;
  let minimumSpeed = Infinity, maximumBrake = 0, stoppedSeconds = 0, passedAt = null;
  let nextUpdate = 0, nextSample = 0, minimumOverlapClearance = Infinity;
  let defenseSelectedSeconds = 0, minimumRearGap = Infinity, rivalPassedAt = null;
  const modes = {}, samples = [];
  for (let time = 0; time < seconds - DT / 2; time += DT) {
    const projections = new Map(cars.map(car => [car.id, track.nearest(car.x, car.z)]));
    if (time + 1e-9 >= nextUpdate) {
      bridge.update(self, cars, 1 / hz, { time, projections });
      nextUpdate += 1 / hz;
    }
    if (!free) rival.controls = rivalPolicy.control(rival, projections.get(rival.id),
      { hold: rivalLane, forceGuard: 1 }, setup.rivalSpeed);
    const airflow = wakes(cars);
    cars.forEach((car, i) => car.step(DT, track, airflow[i]));
    contactSteps += collisions(cars);
    const p = track.nearest(self.x, self.z), other = track.nearest(rival.x, rival.z);
    progress += distance(p.s, previous, track.length); previous = p.s;
    const gap = distance(other.s, p.s, track.length), lateralClearance = Math.abs(other.lateral - p.lateral);
    if (!free && setup.gap < 0) {
      minimumRearGap = Math.min(minimumRearGap, Math.abs(gap));
      if (gap > 12 && rivalPassedAt == null) rivalPassedAt = time;
    }
    if (bridge.driver.selected.tactic === 'defend') defenseSelectedSeconds += DT;
    if (!free && Math.abs(gap) < self.spec.halfLength + rival.spec.halfLength)
      minimumOverlapClearance = Math.min(minimumOverlapClearance, lateralClearance);
    if (!free && setup.gap > 0 && gap < -12 && passedAt == null) passedAt = time;
    if (Math.abs(p.lateral) > track.halfWidth + track.curbWidth) offtrackSeconds += DT;
    if (time > .5) minimumSpeed = Math.min(minimumSpeed, self.speed);
    maximumBrake = Math.max(maximumBrake, self.controls.brake);
    if (self.speed < 5) stoppedSeconds += DT;
    const mode = bridge.debug().intent;
    modes[mode] = (modes[mode] ?? 0) + DT;
    if (time + 1e-9 >= nextSample) {
      samples.push({ time, s: p.s, q: p.lateral, gap, rivalQ: other.lateral, speed: self.speed,
        targetSpeed: bridge.driver.targetSpeed, mode, throttle: self.controls.throttle,
        brake: self.controls.brake, selected: { ...bridge.driver.selected },
        actualExtra: bridge.driver.extra, hold: bridge.driver.hold,
        bounds: bridge.driver.bounds, speedCap: bridge.driver.traffic.speedCap });
      nextSample += .25;
    }
  }
  return { free, progress, minimumSpeed, stoppedSeconds, maximumBrake, passedAt,
    defenseSelectedSeconds, rivalPassedAt,
    minimumRearGap: Number.isFinite(minimumRearGap) ? minimumRearGap : null,
    minimumOverlapClearance: Number.isFinite(minimumOverlapClearance) ? minimumOverlapClearance : null,
    contactSteps, offtrackSeconds, damage: self.damage, bridgeErrors: bridge.errors,
    traffic: { ...bridge.driver.traffic.stats }, modes, samples, ...(scores ? { evaluations } : {}) };
}

export function runCombatProbe({ seconds = 10, hz = 30, filter = null, scores = false } = {}) {
  const track = new Track('harbor-ring');
  const car = fixture(track, 0, 250, 0, 40);
  const bridge = createSolsticeBridge({ hostTrack: track }); bridge.reset({ cars: [car] });
  const cases = encounters(track, bridge.driver.path).filter(c => !filter || c.name.includes(filter));
  if (!cases.length || !Number.isFinite(seconds) || seconds <= 0 || ![20, 30, 60, 120].includes(hz)) throw new Error('Invalid probe selection');
  const results = cases.map(setup => {
    const free = runEncounter(track.id, setup, seconds, hz, true), combat = runEncounter(track.id, setup, seconds, hz, false, scores);
    return { setup, free, combat, progressLoss: free.progress - combat.progress,
      progressRatio: combat.progress / free.progress };
  });
  return { type: 'controlled-combat', conditions: { track: track.id, seconds, hz, fixedDt: DT,
    compound: 'hard', startingWear: { fresh: [.05, .05, .05, .05], worn: [.15, .15, .15, .75] },
    opponent: 'native force policy at a fixed lane/speed cap',
    note: 'Initial placement and warm tyres are fixtures; subsequent controls, wakes, tyres and collisions use native physics. Not an endurance race.', sha256: sourceHashes }, results };
}

// The real first-lap turn-in encounter previously drove the selected corner
// envelope to half pace and produced body contact. No scripted opponent here.
export function runCornerRaceProbe() {
  let trafficSeconds = 0, alongsideSeconds = 0, minimumSpeed = Infinity, minimumTarget = Infinity;
  const race = runBenchmark({ field: ['solstice', 'gemini-supreme-v4'], track: 'harbor-ring',
    teams: 2, laps: 12, seconds: 80, seed: 7, onStep(race, dt) {
      const entry = race.entries[0], driver = entry.bridges[entry.active].driver;
      const s = race.track.nearest(entry.car.x, entry.car.z).s;
      if (race.time > 15 && driver.mode === 'ALONGSIDE') alongsideSeconds += dt;
      if (race.time > 15 && driver.traffic.list.some(o => Math.abs(o.ds) < 25)) trafficSeconds += dt;
      if (s > 2200 && s < 2400) {
        minimumSpeed = Math.min(minimumSpeed, entry.car.speed);
        minimumTarget = Math.min(minimumTarget, driver.targetSpeed);
      }
    } });
  return { type: 'native-corner-combat', conditions: race.config, provenance: race.sourceProvenance,
    truncated: race.truncated, note: 'First 80 seconds of the normal race, including the reproduced corner encounter; not a completed endurance race.',
    simulatedSeconds: race.simulatedSeconds, totalContacts: race.totalContacts,
    trafficSeconds, alongsideSeconds, minimumSpeed: Number.isFinite(minimumSpeed) ? minimumSpeed : null,
    minimumTarget: Number.isFinite(minimumTarget) ? minimumTarget : null,
    results: race.results.map(({ driver, offtrackSeconds, damage, rescues, bridgeErrors, finite }) =>
      ({ driver, offtrackSeconds, damage, rescues, bridgeErrors, finite })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {}; let output = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--output') output = args[i + 1];
    else if (args[i] === '--case') options.filter = args[i + 1];
    else if (args[i] === '--scores') options.scores = args[i + 1] === '1';
    else if (['--seconds', '--hz'].includes(args[i])) options[args[i].slice(2)] = Number(args[i + 1]);
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  const report = options.filter === 'native-corners' ? runCornerRaceProbe() : runCombatProbe(options);
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  if (report.type === 'native-corner-combat') console.log(JSON.stringify({ ...report, provenance: undefined }));
  else console.log(JSON.stringify(report.results.map(({ setup, free, combat, progressLoss, progressRatio }) => ({
    case: setup.name, s: setup.s, progressLoss, progressRatio, freeMinSpeed: free.minimumSpeed,
    ...Object.fromEntries(Object.entries(combat).filter(([key]) => !['samples', 'modes', 'evaluations'].includes(key))), modes: combat.modes
  }))));
}
