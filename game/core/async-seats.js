// Runs every AI seat asynchronously on its own worker (one per team) so the
// race can step in lockstep with the render loop. The physics never waits on
// a controller: each seat posts the latest state when its worker is idle and
// the car holds the last controls it received. Human seats stay local.
import { createSeatBridge } from './field.js';
import { plain } from '../bridges/remote-sync.js';

const RUBBER_EVERY = 30;

function snapshotCar(car) {
  const out = {};
  for (const key in car) {
    if (key === 'spec') continue;
    const v = car[key];
    if (typeof v !== 'function') out[key] = plain(v);
  }
  return out;
}

export class AsyncSeats {
  constructor(trackId) {
    this.trackId = trackId;
    this.hosts = [];
    this.snapTime = -1; this.snap = null; this.seq = 0;
    this.wantDebug = false;   // set while the debugger panel is open
  }

  /** `makeBridge` for EnduranceRace. */
  factory() {
    return (driver, index, race) => {
      if (driver.kind === 'human') return createSeatBridge(driver, index, race);
      return this.seat(driver, index, race);
    };
  }

  /** Field snapshot shared by every seat that asks at the same sim time. */
  cars(race) {
    if (this.snapTime !== race.time || !this.snap) { this.snapTime = race.time; this.snap = race.cars.map(snapshotCar); }
    return this.snap;
  }

  host(index, race) {
    if (this.hosts[index]) return this.hosts[index];
    const worker = new Worker(new URL('./seat-worker.js', import.meta.url), { type: 'module' });
    const host = { worker, seats: [], ready: null, failed: false };
    host.ready = new Promise((resolve) => { host.resolve = resolve; });
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') { host.resolve(); return; }
      if (data.type === 'fatal') {
        console.warn(`[seats] team ${index} worker failed, driving on the main thread`, data.message);
        host.failed = true; host.resolve(); return;
      }
      if (data.type === 'controls') for (const s of host.seats) if (s.seq === data.seq) s.receive(data);
    };
    worker.onerror = (event) => { event.preventDefault?.(); console.warn(`[seats] team ${index} worker error`, event.message); host.failed = true; host.resolve(); };
    // Init is posted once the whole team is registered (see `start`).
    this.hosts[index] = host;
    return host;
  }

  seat(driver, index, race) {
    const host = this.host(index, race), slot = race.teams[index].drivers.indexOf(driver);
    const seats = this;
    let local = null;
    const seat = {
      driverId: driver.id, errors: 0, remote: true,
      seq: -1, inFlight: false, controls: null, pendingDt: 0, lastLatency: 0, sentAt: 0, lastDebug: null,
      receive(data) {
        this.inFlight = false; this.controls = data.controls; this.errors = data.errors;
        this.lastLatency = performance.now() - this.sentAt;
        if (data.debug) this.lastDebug = data.debug;
      },
      update(car, cars, dt, context) {
        if (host.failed) {
          local ??= createSeatBridge(driver, index, race);
          local.update(car, cars, dt, context); this.errors = local.errors ?? 0; return;
        }
        if (this.controls) car.controls = this.controls;
        this.pendingDt += dt;
        this.post(context);
      },
      /** Countdown: ask the controller for launch controls without driving. */
      prime(car, cars, context) {
        if (host.failed) return;
        this.pendingDt = 1 / 120;
        this.post(context);
      },
      post(context) {
        if (this.inFlight) return;
        this.inFlight = true; this.seq = ++seats.seq; this.sentAt = performance.now();
        host.worker.postMessage({
          type: 'step', slot, seq: this.seq, dt: Math.min(0.1, this.pendingDt), time: context.time, laps: context.totalLaps,
          cars: seats.cars(race), wetness: race.track.wetness, tempGrip: race.track.tempGrip,
          rubber: this.seq % RUBBER_EVERY === 1 ? race.track.rubber : undefined,
          debug: seats.wantDebug || undefined
        });
        this.pendingDt = 0;
      },
      reset() {
        this.controls = null; this.inFlight = false; this.pendingDt = 0; this.seq = -1;
        local?.reset?.({ cars: race.cars, track: race.track, line: race.lineFor(race.cars[index]) });
        if (!host.failed && host.initialised) host.worker.postMessage({ type: 'reset', slot, cars: race.cars.map(snapshotCar) });
      },
      debug() { return local?.debug?.() ?? this.lastDebug ?? { architecture: driver.arch ?? driver.id }; },
      visualDebug() { return null; }
    };
    host.seats.push(seat);
    return seat;
  }

  /** Boots every team worker; resolves once all are ready (or fell back). */
  start(race) {
    const cars = race.cars.map(snapshotCar);
    this.hosts.forEach((host, index) => {
      if (!host) return;
      host.worker.postMessage({ type: 'init', trackId: this.trackId, index, drivers: race.teams[index].drivers, cars });
      host.initialised = true;
    });
    return Promise.all(this.hosts.filter(Boolean).map((h) => h.ready));
  }

  dispose() { for (const h of this.hosts) h?.worker.terminate(); this.hosts = []; }
}
