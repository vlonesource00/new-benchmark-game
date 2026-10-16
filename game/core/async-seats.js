// Runs every AI seat asynchronously on its own worker (one per team) so the
// race can step in lockstep with the render loop. The physics never waits on
// a controller: each seat posts the latest state when its worker is idle and
// the car holds the last controls it received. Human seats stay local.
import { createSeatBridge } from './field.js';
import { plain } from '../bridges/remote-sync.js';
import { nextRacerState } from '../bridges/next-racer-state.js';
import { apexState } from '../bridges/apex-state.js';
import { installApexStrategy } from '../../subjects/apex/src/strategy.js';
import { razorState } from '../bridges/razor-state.js';
import { installRazorStrategy } from '../../subjects/razor/src/strategy.js';
import { installTempestStrategy } from '../../subjects/tempest/src/strategy.js';
import { installInterceptStrategy } from '../../subjects/intercept/src/strategy.js';
import { createInterceptExecutor } from '../bridges/intercept-bridge.js';
import { interceptState } from '../bridges/intercept-state.js';
import { installVanguardStrategy } from '../../subjects/vanguard/src/strategy.js';
import { createVanguardExecutor } from '../bridges/vanguard-bridge.js';
import { vanguardState } from '../bridges/vanguard-state.js';
// TEMPEST runs on RAZOR's seat protocol (control timing, epochs, the public race envelope).
const corridorAi = (id) => id === 'razor' || id === 'tempest';
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
      if (driver.id === 'apex') installApexStrategy(race, race.cars[index]);
      if (driver.id === 'razor') installRazorStrategy(race, race.cars[index]);
      if (driver.id === 'tempest') installTempestStrategy(race, race.cars[index]);
      if (driver.id === 'intercept') installInterceptStrategy(race, race.cars[index]);
      if (driver.id === 'vanguard') installVanguardStrategy(race, race.cars[index]);
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
    const executor = driver.id === 'intercept'
      ? createInterceptExecutor(race.track, index)
      : driver.id === 'vanguard'
        ? createVanguardExecutor(race.track, index)
        : null;
    const execState = driver.id === 'vanguard' ? vanguardState : interceptState;
    const seat = {
      driverId: driver.id, errors: 0, remote: true,
      seq: -1, inFlight: false, controls: null, pendingDt: 0, lastLatency: 0, sentAt: 0, lastDebug: null,
      epoch:0,controlTime:null,preview:null,controlDelay:driver.id==='vanguard'?0:.02,
      receive(data) {
        if((driver.id==='next-racer'||corridorAi(driver.id)||executor)&&data.epoch!==this.epoch)return;
        this.inFlight = false; this.controls = data.controls; this.errors = data.errors;
        if(driver.id==='next-racer'){this.controlTime=data.time;this.preview=data.preview??null;
          this.controlDelay=Math.max(0,Math.min(.2,race.time-data.time));}
        if(corridorAi(driver.id)){this.controlTime=data.time;this.controlDelay=Math.max(0,Math.min(.2,race.time-data.time));}
        if (driver.id === 'apex' || corridorAi(driver.id)) this.intent = data.intent ?? null;
        if(executor){executor.adopt(data.preview,race.cars[index],this.epoch);this.controlTime=data.time;this.preview=data.preview;
          if(driver.id==='vanguard'){
            const observed=Math.max(0,race.time-data.time);
            // Long stalls are handled by the live executor; they must not make
            // the next normal reply's predicted arrival hundreds of ms late.
            if(Number.isFinite(observed)&&observed<=.15)this.controlDelay=.75*this.controlDelay+.25*observed;
          }
        }
        this.lastLatency = performance.now() - this.sentAt;
        if (data.debug) this.lastDebug = data.debug;
        if (data.visual !== undefined) this.lastVisual = data.visual;
      },
      update(car, cars, dt, context) {
        if (host.failed) {
          local ??= createSeatBridge(driver, index, race);
          local.update(car, cars, dt, context); this.errors = local.errors ?? 0; return;
        }
        if (this.controls) car.controls = this.controls;
        if (driver.id === 'apex' || corridorAi(driver.id)) car.intent = this.intent ?? null;
        if(driver.id==='next-racer'&&this.controls)car.controls=guardControls(car,cars,race.track,
          previewFeedback(car,race.track,this.preview,context.time)??this.controls,
          {route:previewRoute(race.track,this.preview,context.time),
            age:this.controlTime==null?0:Math.max(0,context.time-this.controlTime)}).controls;
        if(executor){executor.update(car,cars,dt,{...context,state:execState(race,car)});this.errors=executor.bridge.errors;}
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
        // INTERCEPT/VANGUARD replan at a bounded rate. State accumulated while busy is replaced by the newest snapshot.
        if(executor && this.controls && context.time-(this.lastPostTime??-99)<.075)return;
        this.lastPostTime=context.time;
        this.inFlight = true; this.seq = ++seats.seq; this.sentAt = performance.now();
        // surface and weather go out on this seat's own count: the shared reply counter interleaves the seats, so a
        // modulo of it could skip some seats for good
        const refresh = executor
          ? context.time-(this.lastSurfaceTime??-99)>=.25
          : (this.sent = (this.sent ?? 0) + 1) % RUBBER_EVERY === 1;
        if(refresh&&executor)this.lastSurfaceTime=context.time;
        host.worker.postMessage({
          type: 'step', slot, seq: this.seq, dt: Math.min(0.1, this.pendingDt), time: context.time, laps: context.totalLaps,
          cars: seats.cars(race), wetness: race.track.wetness, tempGrip: race.track.tempGrip,
          rubber: refresh ? race.track.rubber : undefined,
          water: refresh && race.track.water?.live ? race.track.water.depth : undefined,
          weather: refresh ? race.track.weatherInfo : undefined,
          ...(driver.id==='next-racer'?{state:nextRacerState(race,race.cars[index]),
            ambient:race.track.ambient,epoch:this.epoch,controlDelay:this.controlDelay,feedbackPeriod:1/120}:{}),
          ...(driver.id === 'apex' ? { state: apexState(race, race.cars[index]) } : {}),
          ...(executor ? {state:execState(race,race.cars[index]),ambient:race.track.ambient,
             epoch:this.epoch,controlDelay:driver.id==='vanguard'?this.controlDelay:0,feedbackPeriod:1/120}:{}),
          ...(corridorAi(driver.id) ? { state: razorState(race, race.cars[index]),
            ambient: race.track.ambient, epoch: this.epoch, controlDelay: this.controlDelay } : {}),
          debug: seats.wantDebug || undefined,
          // The 3D lens draws only the focused car: its plan geometry, a few times a second.
          visual: (seats.wantDebug && seats.lensIndex === index && (this.lensTick = (this.lensTick ?? 0) + 1) % 4 === 0) || undefined
        });
        this.pendingDt = 0;
      },
      reset() {
        this.epoch++;this.controlTime=null;this.preview=null;
        executor?.reset({cars:race.cars,track:race.track});this.lastPostTime=-99;this.lastSurfaceTime=-99;
        if(driver.id==='next-racer'){this.lastDebug=null;seats.snap=null;seats.snapTime=-1;resetFeedback(race.cars[index]);}
        this.controls = null; this.inFlight = false; this.pendingDt = 0; this.seq = -1; this.sent = 0;
        local?.reset?.({ cars: race.cars, track: race.track, line: race.lineFor(race.cars[index]) });
        if (!host.failed && host.initialised) host.worker.postMessage({ type: 'reset', slot, cars: race.cars.map(snapshotCar) });
      },
      debug() { if(executor&&!local){const debug=executor.debug();return {...debug,planner:this.lastDebug?{intent:this.lastDebug.intent,side:this.lastDebug.side,
        cands:this.lastDebug.cands,resources:this.lastDebug.resources,focus:this.lastDebug.focus,focusGap:this.lastDebug.focusGap}:null,
        workerLatencyMs:this.lastLatency,inFlight:this.inFlight,requestSequence:this.seq,replyTime:this.controlTime};}
        return local?.debug?.() ?? (driver.id==='next-racer'&&this.lastDebug?
        {...this.lastDebug,...feedbackDebug(race.cars[index])}:this.lastDebug) ?? { architecture: driver.arch ?? driver.id }; },
      visualDebug() { const point=driver.id==='next-racer'?feedbackDebug(race.cars[index])?.trackingPoint:null;
        const relayed = this.lastVisual ?? (this.lastDebug?.trackingPoint ? { trackingPoint: this.lastDebug.trackingPoint } : null);
        return local?.visualDebug?.() ?? executor?.visualDebug() ?? (point ? { ...relayed, trackingPoint: point } : relayed); }
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
