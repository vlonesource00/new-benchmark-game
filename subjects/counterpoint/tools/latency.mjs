import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { plain } from '../../../game/bridges/remote-sync.js';
import { counterpointState } from '../../../game/bridges/counterpoint-bridge.js';
import { Course } from '../../vanguard-v2/src/course.js';
import { settingsFor } from '../../vanguard-v2/src/settings.js';
import { provenance } from './provenance.mjs';

const args = process.argv.slice(2), flag = (key, d) => {
  const i = args.indexOf('--' + key); return i < 0 ? d : args[i + 1];
};
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const count = +flag('samples', 120), warm = +flag('warmup', 20),
  options = args.includes('--candidate')
    ? { stagedAttacks: true, setupAttacks: true, commitWindow: .35, coastRecovery: true }
    : args.includes('--staged') ? { stagedAttacks: true } : {};
const source = provenance();
if (!Number.isInteger(count) || count < 20 || count > 1000) throw Error('samples must be 20..1000');
const cases = [];
const quantiles = xs => {
  const a = xs.toSorted((x, y) => x - y), at = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return { count: a.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};
for (const trackId of flag('tracks', 'harbor-ring,solenne,nurburgring').split(',')) {
  for (const cls of flag('classes', 'gt,lmdh').split(',')) {
    for (const grid of flag('grids', '1,8,16').split(',').map(Number)) {
      if (!Number.isInteger(grid) || grid < 1 || grid > 16) throw Error('grid must be 1..16');
      const track = new Track(trackId);
      const teams = Array.from({ length: grid }, (_, i) => ({ id: 'latency' + i, index: i, grid: i, starter: 0,
        name: 'latency', short: 'LAT', color: '#00f5d4', classId: cls, raceClass: cls === 'gt' ? 'gt3' : 'gtp',
        drivers: [{ id: i ? 'intercept' : 'counterpoint', name: 'latency', kind: 'ai' }] }));
      const race = new EnduranceRace({ track, teams, laps: 20, seed: 101, weatherSeed: 101, weather: 'clear',
        startCompound: 'soft', startType: 'standing', difficulty: 1,
        format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false } });
      const settings = settingsFor(trackId), course = new Course(track, { ...settings, ...settings.perClass?.[cls] });
      course.prepare(race.cars[0]);
      const worker = new Worker(new URL('./node-seat-worker.mjs', import.meta.url), { type: 'module', workerData: { options } });
      let pending = null, failure = null;
      worker.on('message', data => {
        if (data.type === 'fatal') failure = new Error(data.message);
        if (pending) { const p = pending; pending = null; clearTimeout(p.timer); failure ? p.reject(failure) : p.resolve(data); }
      });
      worker.on('error', error => { failure = error; if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } });
      const request = data => new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const timer = setTimeout(() => { pending = null; reject(Error('seat reply timed out')); }, 30000);
        pending = { resolve, reject, timer }; worker.postMessage(data);
      });
      const snapshot = () => race.cars.map(car => {
        const row = {};
        for (const key in car) if (key !== 'spec' && typeof car[key] !== 'function') row[key] = plain(car[key]);
        return row;
      });
      const place = n => {
        const station = (trackId === 'nurburgring' ? 5900 : trackId === 'solenne' ? 1100 : 250) + n * 5;
        for (const [i, car] of race.cars.entries()) {
          const s = station + (i ? 14 + (i - 1) * 10 : 0), road = track.at(s);
          const c = course.line.closest(road.x, road.z);
          const lateral = course.line.sample(course.line.lat, c.i, c.f) + (i > 1 ? (i % 2 ? 2.4 : -2.4) : 0);
          const speed = Math.min(42, course.line.sample(course.line.vbrk, c.i, c.f) * .88);
          car.place(track, s, lateral, speed);
          car.yaw = course.line.heading(c.i, c.f);
          car.vx = Math.sin(car.yaw) * speed; car.vz = Math.cos(car.yaw) * speed;
          car.gear = course.model.gearAt(speed, 4); car.fuel = 60;
          car.race.progress = s; car.race.previousS = s; car.race.lap = 1;
          car.race.retired = false; car.race.disqualified = false; car.race.finishTime = null;
        }
      };
      try {
        place(0);
        const cold = performance.now();
        const ready = await request({ type: 'init', trackId, index: 0, drivers: teams[0].drivers, cars: snapshot() });
        if (ready.type !== 'ready') throw Error('seat did not initialize');
        const initializationMs = performance.now() - cold;
        const roundTrip = [], compute = []; let errors = 0;
        for (let n = 0; n < warm + count; n++) {
          place(n); race.time = n * .16;
          const data = { type: 'step', slot: 0, seq: n, dt: .075, time: race.time, laps: 20,
            cars: snapshot(), wetness: track.wetness, tempGrip: track.tempGrip, epoch: 0,
            state: { ...counterpointState(race, race.cars[0]), phase: 'racing', formation: false },
            controlDelay: .017, feedbackPeriod: 1 / 120,
            ...(n === 0 ? { rubber: track.rubber, ambient: track.ambient } : {}) };
          const t = performance.now(), reply = await request(data), elapsed = performance.now() - t;
          errors = Math.max(errors, reply.errors ?? 0);
          if (!['throttle', 'brake', 'steer'].every(k => Number.isFinite(reply.controls?.[k]))) throw Error('invalid seat controls');
          if (n >= warm) { roundTrip.push(elapsed); compute.push(reply.measuredWorkerMs); }
        }
        const row = { track: trackId, cls, grid, initializationMs, errors, roundTrip: quantiles(roundTrip), worker: quantiles(compute) };
        cases.push(row); console.log(JSON.stringify(row));
      } finally { await worker.terminate(); }
    }
  }
}
const report = { measurement: 'Real Node worker thread with structured-cloned browser seat messages; representative moving traffic snapshots, one worker at a time. Browser rendering/frame scheduling and simultaneous full-grid worker contention are not measured.',
  ...source, options, samples: count, warmup: warm, cases, finished: new Date().toISOString() };
const endSource = provenance();
report.changesDuringRun = Object.keys(source.sourceHashes).filter(f => source.sourceHashes[f] !== endSource.sourceHashes[f]);
const dir = new URL('../results/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(flag('out', 'latency.json'), dir), JSON.stringify(report, null, 2));
