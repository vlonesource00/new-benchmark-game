// Same-cadence, warm-tyre encounters through the game's actual AsyncSeats and
// seat-worker replicas. Physics runs between answers at the selected cadence,
// retaining the real snapshot age instead of executing a native driver.
import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createRazorBridge } from '../../../game/bridges/razor-bridge.js';

const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const rival = args[0] ?? 'razor';
const classId = args[1] ?? 'lmdh';
const rivalClassId = args[2] ?? classId;
const option = (name, fallback) => Number(process.argv.find(a => a.startsWith('--' + name + '='))?.split('=')[1] ?? fallback);
const hz = option('hz', 30), seconds = option('seconds', 24), start = option('start', 300);
const gap = option('gap', rivalClassId === classId ? 13 : 23);
const trackId = process.argv.find(a => a.startsWith('--track='))?.slice(8) ?? 'harbor-ring';
const driverOptions = JSON.parse(process.argv.find(a => a.startsWith('--driver-options='))?.slice(17) ?? '{}');
const solo = process.argv.includes('--solo');
const cadence = process.argv.find(a => a.startsWith('--cadence='))?.slice(10).split(',').map(Number) ?? [hz];
assert.ok([20, 30, 60].includes(hz), 'Worker cadence must be 20, 30 or 60 Hz');
assert.ok(cadence.every(n => [20, 30, 60].includes(n)), 'Invalid cadence schedule');
assert.ok(Number.isFinite(start) && Number.isFinite(gap) && seconds > 0 && seconds <= 180);
const tracing = process.argv.includes('--trace');
assert.ok(AI_DRIVERS.some(d => d.id === rival), 'Unknown opponent');
assert.ok([classId, rivalClassId].every(id => ['lmdh', 'gt'].includes(id)), 'Class must be lmdh or gt');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sampleAt = (line, array, s) => {
  const j = line.stationOf(s);
  return line.sample(array, Math.floor(j), j % 1);
};

async function encounter(attacks) {
  let workerIndex = 0, liveRace;
  const replies = [0, 0], ages = [], previousWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor(target) {
      const index = workerIndex++;
      this.thread = new Thread(new URL('./worker-host.mjs', import.meta.url), {
        workerData: { target: target.href, attacks: index === 0 ? attacks : true,
          options: index === 0 || process.argv.includes('--both-options') ? driverOptions : undefined }
      });
      this.thread.on('message', data => {
        if (this.closed) return;
        if (data.type === 'controls') {
          replies[index]++;
          if (index === 0) ages.push(Math.max(0, liveRace.time - data.time));
        }
        this.onmessage?.({ data });
      });
      this.thread.on('error', error => this.onerror?.({ message: String(error), preventDefault() {} }));
    }
    postMessage(data) { this.thread.postMessage(data); }
    terminate() { this.closed = true; return this.thread.terminate(); }
  };
  const track = new Track(trackId), seats = new AsyncSeats(track.id);
  const teams = ['razor', rival].map((id, index) => ({
    id: 't' + index, name: id, short: id, color: '#fff', index, grid: index, starter: 0,
    classId: index === 0 ? classId : rivalClassId,
    raceClass: (index === 0 ? classId : rivalClassId) === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ ...AI_DRIVERS.find(d => d.id === id), kind: 'ai' }]
  }));
  const race = new EnduranceRace({ track, teams, laps: 30, seed: 7, difficulty: 1,
    startCompound: 'soft', caution: 'off', makeBridge: seats.factory(),
    format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false } });
  liveRace = race; seats.wantDebug = true;
  async function answers() {
    const deadline = performance.now() + 10000;
    while (seats.hosts.some(h => h.seats.some(s => s.inFlight)) && performance.now() < deadline) await sleep(1);
    assert.ok(!seats.hosts.some(h => h.failed || h.seats.some(s => s.inFlight)), 'Worker failure or timeout');
  }
  try {
    await seats.start(race); race.start();
    race.phase = 'racing'; race.formation = null; race.countdown = 0; race.greenAt = 0;
    const geometries = race.cars.map((_, index) => {
      const bridge = createRazorBridge({ hostTrack: track, index, options: { strategy: false } });
      bridge.reset({ cars: race.cars });
      return bridge.driver;
    });
    const line = geometries[0].line;
    const speed = Math.min(65, sampleAt(line, line.v, start) * 0.96);
    for (const [index, car] of race.cars.entries()) {
      const geometry = geometries[index], line = geometry.line;
      const s = start + index * gap, v = Math.min(speed, sampleAt(line, line.v, s) * 0.96);
      car.place(track, s, sampleAt(line, line.lat, s), v); race.fitTyres(car, 'soft', true); car.fuel = 35;
      for (const wheel of car.wheels) {
        wheel.tyre.core = wheel.tyre.optimum; wheel.tyre.surface = wheel.tyre.optimum; wheel.tyre.wear = 0.1;
      }
      const q = line.closest(car.x, car.z), heading = line.heading(q.i, q.f);
      car.yaw = heading; car.vx = Math.sin(heading) * v; car.vz = Math.cos(heading) * v;
      car.u = v; car.v = 0; car.yawRate = sampleAt(line, line.ks, s) * v; car.gear = geometry.model.gearAt(v);
      car.race.previousS = car.s; car.race.progress = s - start; car.race.lapStart = 0;
      race.entries[index].strategist.decide = () => null;
    }
    for (const entry of race.entries) entry.bridges[0].reset();
    let clearSince = null, passedAt = null;
    let lapSeen = race.cars[0].race.lap;
    const lapTimes = [];
    const off = [0, 0], trace = [], contactLog = []; let nextTrace = 0;
    const pairs = race.collisionStats.pairs, pushPairs = pairs.push.bind(pairs);
    pairs.push = (...rows) => {
      if (tracing && (contactLog.length === 0 || race.time - contactLog.at(-1).t > 0.25)) {
        const [car, other] = race.cars, dx = other.x - car.x, dz = other.z - car.z;
        const rounded = value => +value.toFixed(3);
        contactLog.push({ t: rounded(race.time), s: rounded(car.s), closing: rounded(rows[0][2]),
          ahead: rounded(dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw)),
          across: rounded(dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw)),
          yawDifference: rounded(other.yaw - car.yaw), v: rounded(car.speed), rivalV: rounded(other.speed),
          controls: { ...car.controls } });
      }
      return pushPairs(...rows);
    };
    while (race.time < seconds) {
      const frameHz = cadence[Math.floor(race.time / 2) % cadence.length];
      for (let step = 0; step < 120 / frameHz; step++) {
        race.step(FIXED_DT);
        const [car, other] = race.cars, ds = other.race.progress - car.race.progress;
        if (car.race.lap !== lapSeen) {
          lapTimes.push({ lap: lapSeen, time: car.race.lastLap, state: car.race.lastState });
          lapSeen = car.race.lap;
        }
        if (ds < -6) {
          clearSince ??= race.time;
          if (race.time - clearSince > 1.5) passedAt ??= clearSince;
        } else clearSince = null;
        for (const [index, current] of race.cars.entries()) {
          if (Math.abs(current.lateral) > track.halfWidth + track.curbWidth) off[index] += FIXED_DT;
        }
      }
      await answers();
      if (tracing && race.time >= nextTrace) {
        const [car, other] = race.cars, debug = seats.hosts[0].seats[0].debug();
        const n = x => Number.isFinite(x) ? +x.toFixed(3) : null;
        trace.push({ t: n(race.time), s: n(car.s), gap: n(other.race.progress - car.race.progress),
          v: n(car.speed), rivalV: n(other.speed), lat: n(car.lateral), rivalLat: n(other.lateral),
          throttle: n(car.controls.throttle), brake: n(car.controls.brake), steer: n(car.controls.steer),
           target: n(debug.targetSpeed), line: n(debug.lineSpeed), e: n(debug.e), stability: n(debug.stability),
           timing: debug.controlTiming, neighbor: debug.neighbor,
           curvature: n(debug.requestedCurvature), clearance: n(debug.combat?.clearance),
           geometry: debug.pathGeometry,
          mode: debug.mode, state: debug.combat?.state, side: debug.combat?.side, cap: debug.combat?.cap, cands: debug.combat?.cands,
          rival: process.argv.includes('--quiet-trace') ? undefined : seats.hosts[1]?.seats[0]?.debug() });
        nextTrace = process.argv.includes('--trace-every-frame') ? race.time : race.time + 0.2;
      }
    }
    const debug = seats.hosts[0].seats[0].debug(), errors = race.entries.map(e => e.bridges[0].errors ?? 0);
    ages.sort((a, b) => a - b);
    assert.ok(replies.every(n => n > 0), 'Both workers must answer');
    assert.ok(errors.every(n => n === 0));
    if (!process.argv.includes('--allow-incidents')) {
      assert.equal(race.collisionStats.severeContacts, 0); assert.equal(off[0], 0);
    }
    return { attacks, passedAt: passedAt === null ? null : +passedAt.toFixed(2),
      gain: +(race.cars[0].race.progress - race.cars[1].race.progress).toFixed(1),
      contacts: race.contacts, severe: race.collisionStats.severeContacts,
      peakClosing: race.collisionStats.peakClosing, damage: race.cars.map(c => c.damage),
      off: off[0], rivalOff: off[1], errors, replies,
      replyAgeP95: ages[Math.floor(ages.length * 0.95)],
      lapTimes,
      associatedPasses: debug.combat?.stats?.associatedPasses ?? 0, events: debug.combat?.events ?? [],
      stats: debug.combat?.stats,
      ...(tracing ? { trace, contactLog } : {}) };
  } finally {
    seats.dispose();
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
}

const enabled = await encounter(true), control = solo ? enabled : await encounter(false);
const moveDemonstrated = enabled.passedAt !== null && enabled.associatedPasses > 0 && enabled.rivalOff === 0
  && (control.passedAt === null || enabled.passedAt + 1 < control.passedAt);
console.log(JSON.stringify({ trackId, rival, classId, rivalClassId, hz, cadence, seconds, start, gap, enabled, control, moveDemonstrated: !solo && moveDemonstrated }));
if (process.argv.includes('--require-move')) assert.ok(moveDemonstrated, 'The worker must execute a causal pass');
