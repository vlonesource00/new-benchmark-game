// Real-time seat-worker conditions: the game's AsyncSeats + seat-worker module in worker threads, rolling start,
// the host stepping 4 physics steps per 30 Hz frame, replies landing one frame late (or on a wall clock with --realtime).
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/worker.mjs --drivers apex,next-racer --class lmdh --track harbor-ring --laps 3
//   flags: --realtime  --burst-ms=75  --seed=7  --classes=lmdh,gt (per car)  --endurance  --fps=30
import { Worker as Thread } from 'node:worker_threads';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { FORMATS } from '../../../game/core/rules.js';

const args = process.argv.slice(2), get = (k, d) => args.find((a) => a.startsWith('--' + k + '='))?.slice(k.length + 3) ?? d;
const ids = get('drivers', 'apex').split(','), classId = get('class', 'lmdh'), laps = Number(get('laps', 3)), seed = Number(get('seed', 7));
const realtime = args.includes('--realtime'), burstMs = Number(get('burst-ms', 0)), fps = Number(get('fps', 30)), endurance = args.includes('--endurance'), duel = args.includes('--duel');   // --duel: the game's duel setup (custom format, no mandatory stop, one driver per car, 12 laps, strategists live)
const perCar = get('classes', '').split(',').filter(Boolean), trackId = get('track', 'harbor-ring'), startType = get('start', 'rolling');
const delays = []; let liveRace = null, workers = 0;
globalThis.Worker = class {
  constructor(target) {
    this.index = workers++;
    this.thread = new Thread(new URL('./seat-host.mjs', import.meta.url), { workerData: { target: target.href } });
    this.thread.on('message', (data) => {
      const deliver = () => { if (this.closed) return; if (data.type === 'controls' && liveRace) delays.push(Math.max(0, liveRace.time - data.time)); this.onmessage?.({ data }); };
      if (data.type === 'controls' && burstMs && Math.floor(data.time / 3) % 2 === 1 && data.time % 3 < 0.3) setTimeout(deliver, burstMs); else deliver();
    });
    this.thread.on('error', (e) => this.onerror?.({ message: String(e), preventDefault() {} }));
  }
  postMessage(data) { this.thread.postMessage(data); }
  terminate() { this.closed = true; return this.thread.terminate(); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const track = new Track(trackId), seats = new AsyncSeats(trackId);
const teams = ids.map((id, i) => { const cls = perCar[i] ?? classId; return { id: 'w' + i, name: id, short: (AI_DRIVERS.find((d) => d.id === id)?.short ?? id).slice(0, 3) + i, color: '#ddd', index: i, grid: i, starter: 0,
  classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: Array.from({ length: endurance ? 2 : 1 }, () => ({ kind: 'ai', ...AI_DRIVERS.find((d) => d.id === id) })) }; });
const race = new EnduranceRace({ track, teams, laps: endurance || duel ? 12 : 30, format: endurance ? FORMATS.classic : { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, classId, difficulty: 1, weather: 'clear', seed, weatherSeed: seed, startType, makeBridge: seats.factory() });
liveRace = race;
if (!endurance && !duel) for (const e of race.entries) e.strategist.decide = () => null;
// --contacts=<min closing m/s>: print every contact with the geometry and pedals of both cars (stderr)
if (get('contacts', null)) {
  const pairs = race.collisionStats.pairs, push = pairs.push.bind(pairs), min = Number(get('contacts', 2)), last = new Map();
  pairs.push = (...a) => {
    for (const [ia, ib, closing] of a) {
      const key = ia + ':' + ib; if (closing < min || race.time - (last.get(key) ?? -9) < 0.5) continue; last.set(key, race.time);
      const car = (id) => race.cars.find((x) => x.id === id), desc = (id) => { const c = car(id); return `${race.entryOf(c).team.name.slice(0, 3)}${c.id} s${c.s.toFixed(0)} lat${c.lateral.toFixed(1)} v${c.speed.toFixed(1)} thr${c.controls.throttle.toFixed(1)} brk${c.controls.brake.toFixed(1)} str${c.controls.steer.toFixed(2)}`; };
      const A = car(ia), B = car(ib), dsAB = ((A.s - B.s + track.length * 1.5) % track.length) - track.length / 2;
      const [front, back] = dsAB >= 0 ? [A, B] : [B, A], fx = Math.sin(front.yaw), fz = Math.cos(front.yaw), rx = fz, rz = -fx;
      const dx = back.x - front.x, dz = back.z - front.z, dvx = back.vx - front.vx, dvz = back.vz - front.vz;
      const lon = dx * fx + dz * fz, lat = dx * rx + dz * rz, vlon = dvx * fx + dvz * fz, vlat = dvx * rx + dvz * rz;
      const kind = Math.abs(lat) < 2.2 && lon < -2.6 ? 'REAR-END' : Math.abs(lon) < 3.6 ? 'SIDE' : 'CORNER';
      console.error(`CONTACT t${race.time.toFixed(2)} closing ${closing.toFixed(1)} ${kind} (${desc(back.id).slice(0, 4)} behind ${desc(front.id).slice(0, 4)}: lon ${lon.toFixed(1)} lat ${lat.toFixed(1)} vlon ${vlon.toFixed(1)} vlat ${vlat.toFixed(1)}): ${desc(ia)} | ${desc(ib)}`);
    }
    return push(...a);
  };
}
async function answers() {
  const until = performance.now() + 10000;
  while (seats.hosts.some((h) => h?.seats.some((s) => s.inFlight)) && performance.now() < until) await sleep(1);
}
const t0 = performance.now();
try {
  race.start(); await seats.start(race);
  const compound0 = race.cars.map((c) => c.wheels[0].tyre.compound + '/' + c.fuel.toFixed(0) + 'L');
  for (const [index, h] of seats.hosts.entries()) for (const s of h.seats) s.prime(race.cars[index], race.cars, { time: 0, totalLaps: laps });
  await answers();
  let frame = 0; const started = performance.now(), lapRows = race.cars.map(() => []), tyreRows = race.cars.map(() => []), lastLap = race.cars.map(() => 1);
  while (race.cars.some((c) => c.race.lap <= laps) && race.time < 4000 && race.phase !== 'finished') {
    for (let step = 0; step < 4; step++) {
      race.step(FIXED_DT);
      race.cars.forEach((c, i) => { if (c.race.lap !== lastLap[i]) { lapRows[i].push(+c.race.lastLap.toFixed(2)); tyreRows[i].push(c.wheels[0].tyre.compound[0].toUpperCase() + Math.max(...c.wheels.map((w) => w.tyre.wear)).toFixed(2).slice(1) + (c.pit ? 'P' : '')); lastLap[i] = c.race.lap; } });
    }
    frame++;
    if (realtime) await sleep(Math.max(0, started + (frame * 1000) / fps - performance.now())); else await answers();
  }
  delays.sort((a, b) => a - b);
  const ms = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ drivers: ids, classId, track: trackId, realtime, burstMs, simSeconds: +race.time.toFixed(1), wall: +ms.toFixed(1),
    laps: lapRows, tyres: tyreRows, compound0, compoundEnd: race.cars.map((c) => c.wheels[0].tyre.compound + '/' + c.fuel.toFixed(0) + 'L w' + Math.max(...c.wheels.map((w) => w.tyre.wear)).toFixed(2)), order: race.order().map((c) => c.team.name + ':' + c.race.progress.toFixed(0)), contacts: race.contacts,
    incidents: race.entries.map((e) => race.stewards.of(e).inc), log: race.entries.map((e) => [...new Set(race.stewards.of(e).log.map((l) => l.kind))]),
    delayP50: delays[Math.floor(delays.length * 0.5)]?.toFixed(3), delayP95: delays[Math.floor(delays.length * 0.95)]?.toFixed(3), delayMax: delays.at(-1)?.toFixed(3),
    stints: race.entries.map((e) => ({ stops: e.stops ?? e.strategist.stops, stints: e.stints, pitTime: +(e.pitStopTime ?? 0).toFixed(1), reason: e.strategist.reason })),
    finish: race.cars.map((c) => (c.race.finishTime == null ? null : +c.race.finishTime.toFixed(2))),
    stewards: race.entries.map((e) => race.stewards.of(e).log.map((l) => `${l.time.toFixed(0)}s L${l.lap} ${l.kind} ${l.points ?? ''}`)),
    errors: seats.hosts.map((h) => h?.seats[0]?.errors ?? 0) }));
} finally { seats.dispose(); delete globalThis.Worker; }
