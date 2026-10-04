// Runs every AI seat asynchronously on its own worker (one per team) so the
// race can step in lockstep with the render loop. The physics never waits on
// a controller: each seat posts the latest state when its worker is idle and
// the car holds the last controls it received. Human seats stay local.
import { createSeatBridge } from './field.js';
import { plain } from '../bridges/remote-sync.js';
import { nextRacerState } from '../bridges/next-racer-state.js';
import { installNativeStrategy } from '../../subjects/next-racer/src/strategy.js';
import { guardControls,previewRoute } from '../../subjects/next-racer/src/safety.js';
import { previewFeedback,feedbackDebug,resetFeedback } from '../../subjects/next-racer/src/feedback.js';

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
      if (driver.id === 'next-racer') installNativeStrategy(race,race.cars[index]);
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
      epoch:0,controlTime:null,preview:null,controlDelay:.02,
      receive(data) {
        if(driver.id==='next-racer'&&data.epoch!==this.epoch)return;
        this.inFlight = false; this.controls = data.controls; this.errors = data.errors;
        if(driver.id==='next-racer'){this.controlTime=data.time;this.preview=data.preview??null;
          this.controlDelay=Math.max(0,Math.min(.2,race.time-data.time));}
        this.lastLatency = performance.now() - this.sentAt;
        if (data.debug) this.lastDebug = data.debug;
      },
      update(car, cars, dt, context) {
        if (host.failed) {
          local ??= createSeatBridge(driver, index, race);
          local.update(car, cars, dt, context); this.errors = local.errors ?? 0; return;
        }
        if (this.controls) car.controls = this.controls;
        if(driver.id==='next-racer'&&this.controls)car.controls=guardControls(car,cars,race.track,
          previewFeedback(car,race.track,this.preview,context.time)??this.controls,
          {route:previewRoute(race.track,this.preview,context.time),
            age:this.controlTime==null?0:Math.max(0,context.time-this.controlTime)}).controls;
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
          ...(driver.id==='next-racer'?{state:nextRacerState(race,race.cars[index]),
            ambient:race.track.ambient,epoch:this.epoch,controlDelay:this.controlDelay,feedbackPeriod:1/120}:{}),
          debug: seats.wantDebug || undefined
        });
        this.pendingDt = 0;
      },
      reset() {
        this.epoch++;this.controlTime=null;this.preview=null;
        if(driver.id==='next-racer'){this.lastDebug=null;seats.snap=null;seats.snapTime=-1;resetFeedback(race.cars[index]);}
        this.controls = null; this.inFlight = false; this.pendingDt = 0; this.seq = -1;
        local?.reset?.({ cars: race.cars, track: race.track, line: race.lineFor(race.cars[index]) });
        if (!host.failed && host.initialised) host.worker.postMessage({ type: 'reset', slot, cars: race.cars.map(snapshotCar) });
      },
      debug() { return local?.debug?.() ?? (driver.id==='next-racer'&&this.lastDebug?
        {...this.lastDebug,...feedbackDebug(race.cars[index])}:this.lastDebug) ?? { architecture: driver.arch ?? driver.id }; },
      visualDebug() { const point=driver.id==='next-racer'?feedbackDebug(race.cars[index])?.trackingPoint:null;
        return local?.visualDebug?.() ?? (point?{trackingPoint:point}:this.lastDebug?.trackingPoint ? { trackingPoint: this.lastDebug.trackingPoint } : null); }
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
