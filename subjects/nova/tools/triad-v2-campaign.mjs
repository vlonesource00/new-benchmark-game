// Read-only racecraft telemetry on the canonical three-architecture host.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));
const root = resolve(args.benchmark ?? '../benchmark');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { Track } = await load('host/astra/src/sim/track.js');
const { Session } = await load('host/astra/src/sim/session.js');
const { createField, TRIAD_CANDIDATES } = await load('sandbox/bridges/index.js');
const orders = [
  ['nova', 'gemini-supreme', 'astra'],
  ['nova', 'astra', 'gemini-supreme'],
  ['gemini-supreme', 'nova', 'astra'],
  ['gemini-supreme', 'astra', 'nova'],
  ['astra', 'nova', 'gemini-supreme'],
  ['astra', 'gemini-supreme', 'nova'],
];
const lapsList = (args.laps ?? '3,5').split(',').map(Number);
const selected = args.grid === undefined ? orders.map((_, i) => i) : [Number(args.grid) - 1];
const dt = 1 / 120;
const sha = path => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
const novaSubject = resolve(root, 'subjects/nova');
const sourceHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const provenance = { nova: sha(resolve('.')), benchmark: sha(root),
  astra: sha(resolve(root, 'subjects/astra')),
  gemini: sha(resolve(root, 'subjects/gemini-supreme')),
  benchmarkNova: sha(novaSubject),
  benchmarkNovaDirty: execFileSync('git', ['status', '--porcelain'], { cwd: novaSubject, encoding: 'utf8' }).trim(),
  topologyHash: sourceHash(resolve(novaSubject, 'src/ai/nova/topology-planner.js')),
  beliefHash: sourceHash(resolve(novaSubject, 'src/ai/nova/belief-occupancy.js')),
  driverHash: sourceHash(resolve(novaSubject, 'src/ai/nova/nova-driver.js')) };
const outputDir = resolve(args.out ?? 'artifacts/triad-v2-baseline');
mkdirSync(outputDir, { recursive: true });
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
};
const round = value => Number.isFinite(value) ? +value.toFixed(3) : null;
const wrap = (difference, length) => ((difference + length * 1.5) % length) - length * 0.5;

function heat(grid, laps) {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt', mixed: false });
  session.laps = laps;
  session.field = 3;
  session.cars = session.cars.slice(0, 3);
  session.drivers = session.drivers.slice(0, 3);
  const field = createField({ session, hostTrack: track, order: grid, candidatesList: TRIAD_CANDIDATES });
  session.start({ freshTrack: true });
  field.attach(true);
  if (field.bridges.some((bridge, i) => session.drivers[i] !== bridge)) throw new Error('Host bridge reset');
  session.phase = 'racing';
  session.countdown = 0;
  const rows = grid.map((id, i) => ({ id, gridSlot: i + 1, laps: [], lastLap: 1,
    lastOfftrack: 0, spinEvents: 0, spinning: false, peakDamage: 0, contactFrames: 0,
    finishTime: null, bestLap: null, offtrackSec: 0, errors: 0 }));
  const novaIndex = grid.indexOf('nova');
  const nova = session.cars[novaIndex];
  const bridge = field.bridges[novaIndex];
  const phases = {}, topologies = {}, samples = [], caps = [], contacts = [], passes = [];
  const history = [];
  let prevPhase = null, currentCap = null, lastContactTime = -Infinity;
  let attackInitiations = 0, aborts = 0, steeringReversals = 0, priorSteer = 0;
  let overlaps = 0, completedPhases = 0, corridorSwitches = 0, previousCorridor = null;
  let capSeconds = 0, capBrakeSeconds = 0, concedeSeconds = 0;
  const previousBodyGaps = new Map();
  const pendingPasses = [];
  let tick = 0, lastContactCount = 0;
  while (tick < (laps * 100 + 40) / dt) {
    if (session.phase === 'finished' && !session.activeCars.every(c => c.race.finishTime !== null)) session.phase = 'racing';
    session.step(dt, { throttle: 0, brake: 0, steer: 0 });
    tick++;
    const t = session.time;
    for (let i = 0; i < 3; i++) {
      const car = session.cars[i], row = rows[i];
      if (row.finishTime !== null) continue;
      if (car.race.lap > row.lastLap) {
        row.laps.push({ lap: row.lastLap, seconds: car.race.lastLap,
          offtrackSec: round(car.race.offtrack - row.lastOfftrack) });
        row.lastLap = car.race.lap;
        row.lastOfftrack = car.race.offtrack;
      }
      const slip = Math.abs(Math.atan2(car.v, Math.max(0.1, Math.abs(car.u))));
      const spinning = slip > 0.35 && Math.abs(car.yawRate) > 1.2;
      if (spinning && !row.spinning) row.spinEvents++;
      row.spinning = spinning;
      row.peakDamage = Math.max(row.peakDamage, car.damage);
      if (car.race.finishTime !== null) {
        row.finishTime = car.race.finishTime;
        row.bestLap = car.race.bestLap;
        row.offtrackSec = car.race.offtrack;
        row.damage = car.damage;
        row.errors = field.bridges[i].errors ?? 0;
      }
    }
    if (rows[novaIndex].finishTime !== null) {
      lastContactCount = session.contacts;
      if (session.activeCars.every(c => c.race.finishTime !== null)) break;
      continue;
    }
    const topo = bridge.driver.topologyResult;
    const cc = bridge.driver.coupledController.state;
    const reference = bridge.driver.trackData;
    const aheadStation = (nova.s + nova.speed * 1.5) % reference.length;
    const aheadIndex = Math.floor(aheadStation / reference.ds) % reference.kappa.length;
    const phase = topo?.phase ?? 'UNKNOWN';
    const topology = topo?.activeTopology ?? 'UNKNOWN';
    phases[phase] = (phases[phase] ?? 0) + dt;
    topologies[topology] = (topologies[topology] ?? 0) + dt;
    if (phase !== prevPhase) {
      if (phase === 'ATTACK_COMMITTED' || phase === 'PRE_OVERLAP') attackInitiations++;
      if (phase === 'ABORT') aborts++;
      if (phase === 'OVERLAP') overlaps++;
      if (phase === 'PASS_COMPLETE') completedPhases++;
      prevPhase = phase;
    }
    const corridor = topo?.selectedCorridor?.map(value => round(value));
    if (corridor && previousCorridor && Math.abs((corridor[0] + corridor[1] - previousCorridor[0] - previousCorridor[1]) / 2) > 2.5)
      corridorSwitches++;
    previousCorridor = corridor;
    if (phase === 'CONCEDE') concedeSeconds += dt;
    const steerSign = Math.sign(nova.controls.steer);
    if (steerSign && priorSteer && steerSign !== priorSteer) steeringReversals++;
    if (steerSign) priorSteer = steerSign;
    const rivalStates = session.cars.filter(c => c !== nova).map(car => {
      const physical = bridge.driver.beliefEngine.getPhysicalState(car.id);
      return { id: field.bridges[car.id].candidateId,
        ds: round(wrap(car.s - nova.s, track.length)), dq: round(car.lateral - nova.lateral),
        speed: round(car.speed), qDot: round(physical?.qDot),
      bodyGap: round(car.race.progress - nova.race.progress), yaw: round(car.yaw),
      halfLength: 2.325, halfWidth: 1.01 };
    });
    const state = { t: round(t), s: round(nova.s), q: round(nova.lateral), speed: round(nova.speed),
      yaw: round(nova.yaw),
      phase, topology, targetQ: round(topo?.targetQ), cap: round(topo?.targetSpeedCap),
      capReason: topo?.targetSpeedCapReason ?? null,
      sweptRisk: round(topo?.sweptPrediction?.peakRisk),
      sweptTTC: round(topo?.sweptPrediction?.firstTTC),
      sweptClearance: round(topo?.sweptPrediction?.minClearance),
      sweptModes: topo?.sweptPrediction?.modes ?? [],
      freeIntervals: topo?.sweptPrediction?.freeIntervals ?? [],
      availableCorridors: topo?.corridorGraph?.layers?.[3]?.intervals?.filter(x => x.reachable)
        .map(x => [round(x.lo), round(x.hi)]) ?? [],
      projectedQ: round(topo?.projectedQ),
      corridor,
      brake: round(nova.controls.brake), throttle: round(nova.controls.throttle),
      steer: round(nova.controls.steer), refKappa: round(cc.refKappa),
      upcomingKappa: round(reference.kappa[aheadIndex]),
      refSpeed: round(cc.refSpeedHere), brakeReason: cc.brakeReason,
      targetLimitReason: cc.targetLimitReason, stabilityLimit: cc.stabilityLimitActive,
      selectedCost: round(topo?.candidates?.find(c => c.topology === topology)?.cost),
      candidateCosts: topo?.candidates?.map(c => ({ topology: c.topology, cost: round(c.cost),
        risk: round(c.predicted?.peakRisk), corridorFeasible: c.trajectory.corridorFeasible,
        rollout: c.rollout && { duration: round(c.rollout.duration),
          exitSpeed: round(c.rollout.exitSpeed), braking: round(c.rollout.requiredBraking) } })),
      rivals: rivalStates };
    if (tick % 12 === 0) {
      samples.push(state);
      history.push(state);
      if (history.length > 32) history.shift();
    }
    const cap = topo?.targetSpeedCap;
    if (Number.isFinite(cap)) {
      capSeconds += dt;
      if (cc.brakeReason === 'TRAFFIC' && nova.controls.brake > 0.02) capBrakeSeconds += dt;
      if (!currentCap) currentCap = { start: round(t), startState: state, minCap: cap,
        brakeSeconds: 0, phase, samples: 0 };
      currentCap.minCap = Math.min(currentCap.minCap, cap);
      currentCap.samples++;
      if (cc.brakeReason === 'TRAFFIC' && nova.controls.brake > 0.02) currentCap.brakeSeconds += dt;
    } else if (currentCap) {
      caps.push({ ...currentCap, end: round(t), duration: round(currentCap.samples * dt),
        minCap: round(currentCap.minCap), brakeSeconds: round(currentCap.brakeSeconds),
        endState: state });
      currentCap = null;
    }
    for (const rival of rivalStates) {
      const previous = previousBodyGaps.get(rival.id);
      const now = -rival.bodyGap;
      if (previous !== undefined && previous <= 5.2 && now > 5.2) {
        const pass = { rival: rival.id, t: round(t), s: round(nova.s),
          startGap: round(previous), completed: true, retained100m: null,
          contactAffected: t - lastContactTime < 3 };
        passes.push(pass);
        pendingPasses.push(pass);
      }
      previousBodyGaps.set(rival.id, now);
    }
    for (const pass of pendingPasses) {
      if (pass.retained100m !== null) continue;
      if (wrap(nova.s - pass.s, track.length) >= 100) {
        const rival = rivalStates.find(r => r.id === pass.rival);
        pass.retained100m = rival ? -rival.bodyGap > 5.2 : null;
      }
    }
    if (session.contacts > lastContactCount) {
      if (t - lastContactTime > 0.5) contacts.push({ t: round(t),
        novaImpact: round(nova.impact), before: [...history], at: state,
        candidates: state.candidateCosts,
        geometry: { ego: { yaw: round(nova.yaw), halfLength: 2.325, halfWidth: 1.01 },
          rivals: rivalStates },
        opponentModes: rivalStates.map(r => ({ id: r.id,
          belief: bridge.driver.beliefEngine.getBelief(session.cars.find(c => field.bridges[c.id].candidateId === r.id)?.id) })) });
      lastContactTime = t;
      for (const car of session.cars) if (car.impact > 0.05) rows[car.id].contactFrames++;
    }
    lastContactCount = session.contacts;
    if (session.activeCars.every(c => c.race.finishTime !== null)) break;
  }
  if (currentCap) caps.push({ ...currentCap, duration: round(currentCap.samples * dt),
    minCap: round(currentCap.minCap), brakeSeconds: round(currentCap.brakeSeconds) });
  const standings = session.standings();
  for (const row of rows) {
    const index = grid.indexOf(row.id), car = session.cars[index];
    row.position = standings.findIndex(c => c.id === car.id) + 1;
    row.finishTime ??= car.race.finishTime;
    row.bestLap ??= car.race.bestLap;
    if (row.finishTime === null) row.offtrackSec = car.race.offtrack;
    row.damage ??= car.damage;
    row.errors = field.bridges[index].errors ?? 0;
    row.medianLap = median(row.laps.map(l => l.seconds).filter(Number.isFinite));
    row.worstLap = Math.max(...row.laps.map(l => l.seconds).filter(Number.isFinite));
  }
  return { grid, laps, elapsed: session.time, contactsTotal: session.contacts,
    collisionStats: session.collisionStats, rows,
    nova: { phases, topologies, capSeconds: round(capSeconds), capBrakeSeconds: round(capBrakeSeconds),
      concedeSeconds: round(concedeSeconds), attackInitiations, aborts, overlaps,
      completedPhases, corridorSwitches, steeringReversals,
      passes, caps, contacts, samples } };
}

const all = [];
for (const laps of lapsList) for (const index of selected) {
  const result = heat(orders[index], laps);
  all.push(result);
  const output = resolve(outputDir, `${laps}lap-grid${index + 1}.json`);
  writeFileSync(output, JSON.stringify({ provenance, ...result }));
  const nova = result.rows.find(r => r.id === 'nova');
  console.log(JSON.stringify({ output, laps, grid: index + 1, nova: {
    finish: nova.finishTime, best: nova.bestLap, offtrack: nova.offtrackSec,
    damage: nova.damage, contacts: nova.contactFrames, errors: nova.errors,
    position: nova.position }, caps: result.nova.caps.length,
    capSeconds: result.nova.capSeconds, passes: result.nova.passes.length,
    retained: result.nova.passes.filter(p => p.retained100m).length }));
}
writeFileSync(resolve(outputDir, 'index.json'), JSON.stringify({ provenance,
  heats: all.map(({ nova, ...rest }) => ({ ...rest,
    nova: { ...nova, caps: nova.caps.length, contacts: nova.contacts.length,
      samples: nova.samples.length } })) }, null, 2));
