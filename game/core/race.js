import { PaceGovernor } from './difficulty.js';
import { Vehicle, wakes, collisions } from '../engine/sim/vehicle.js';
import { RacingLine } from '../engine/sim/ai.js';
import { createTyre } from '../engine/sim/tyre.js';
import { wrap } from '../engine/sim/math.js';
import { raceInterval } from '../engine/sim/interval.js';
import { halfCarInside } from '../engine/sim/racecraft-policy.js';
import { carSpecFor } from '../engine/sim/car-specs.js';
import { COMPOUNDS, FORMATS, TANK_LITRES, calibrate, serviceTime } from './rules.js';
import { Weather } from './weather.js';
import { PitLane, PitAutopilot } from './pit.js';
import { TeamStrategist, maxWear } from './strategy.js';
import { createSeatBridge } from './field.js';
import { AI_DRIVERS } from './teams.js';
import { Stewards, MEATBALL_DAMAGE } from './stewards.js';
import { fitHybrid, hybridStep, aiDeployMode, HYBRID } from './hybrid.js';
import { classProfile, classForCar } from './classes.js';

export const FIXED_DT = 1 / 120;
/** Lone qualifying: timed laps after the out lap, gap between cars on track (m), session cap (s). */
export const QUALI_LAPS = 2, QUALI_SPACING = 260, QUALI_TIME_LIMIT = 480;

/**
 * Authoritative endurance race. Mirrors the host Session.step loop (same
 * physics order, lap counting and timing history) and adds teams, fuel,
 * tyre compounds, pit stops and driver swaps. Everything a client needs to
 * render is in `snapshot()`; nothing outside this class mutates race state.
 */
export class EnduranceRace {
  constructor({ track, teams, format = FORMATS.classic, laps = format.laps, classId = 'gt', startCompound = 'medium', makeBridge = createSeatBridge, difficulty = 1, weather = 'clear', seed = 7, weatherSeed = seed, session = 'race' }) {
    this.track = track; this.teams = teams;
    // 'qualifying': lone qualifying, iRacing-style. Every car runs an out lap and
    // QUALI_LAPS timed laps as a ghost; the best clean lap sets its grid slot.
    this.session = session;
    this.weather = new Weather(weather, weatherSeed); this.weather.apply(track);
    this.format = { ...format, laps };
    this.cal = calibrate(track, laps); this.laps = session === 'qualifying' ? QUALI_LAPS : this.cal.laps;
    this.classId = carSpecFor(classId).key;
    this.lines = new Map();
    this.lane = new PitLane(track, teams.length);
    this.inputs = new Map();
    this.events = []; this.eventSeq = 0;
    this.cars = teams.map((team, i) => {
      const car = new Vehicle(i, team.short, team.color, team.classId ?? this.classId);
      car.team = team; car.fuelScale = this.cal.fuelScale;
      return car;
    });
    this.entries = teams.map((team, i) => ({
      team, car: this.cars[i], active: team.starter ?? 0,
      bridges: [], strategist: new TeamStrategist(team, this.cal, this.format, seed, i),
      pit: null, pitPlan: null, pitStopTime: 0, decidedLap: 0,
      stints: [], stintStart: 0, box: this.lane.boxes[i]
    }));
    // Difficulty applies to all-AI teams only: a human's own AI co-driver runs at
    // full pace. Tyre and wet-weather management applies to every AI stint.
    this.difficulty = difficulty;
    this.entries.forEach((e) => { e.governor = new PaceGovernor(track, e.team.drivers.some((d) => d.kind === 'human') ? 1 : difficulty, classProfile(track, e.car.classId)); });
    this.entries.forEach((e, i) => { e.bridges = e.team.drivers.map((d) => makeBridge(d, i, this)); });
    this.startCompound = startCompound;
    this.phase = 'grid'; this.time = 0; this.countdown = 0; this.contacts = 0;
    this.collisionStats = { peakClosing: 0, severeContacts: 0 };
    this.reset();
    // Race control: incident points, penalties and flags (see core/stewards.js).
    this.stewards = new Stewards(this); this.collisionStats.pairs = this.stewards.pairs;
  }
  lineFor(car) {
    if (!this.lines.has(car.classId)) this.lines.set(car.classId, new RacingLine(this.track, carSpecFor(car.classId)));
    return this.lines.get(car.classId);
  }
  fitTyres(car, compoundId, warm = false) {
    const c = COMPOUNDS[compoundId];
    for (const w of car.wheels) w.tyre = createTyre(car.setup.pressure, { compound: c.id, gripScale: c.grip, wearScale: c.wear * this.cal.wearScale * (car.spec.tyreWear ?? 1), optimum: c.optimum, heat: c.heat, warm });
  }
  reset() {
    const track = this.track, start = track.scenario?.start;
    const rowSpacing = start?.rowSpacingM ?? 9.5, laneOff = start?.laneOffsetM ?? 2.3;
    const gridToFinish = wrap(track.finishS - track.gridS, track.length);
    this.time = 0; this.contacts = 0; this.results = null; this.finishedAt = null;
    this.stewards?.reset();
    this.entries.forEach((e, i) => {
      const c = e.car;
      const quali = this.session === 'qualifying';
      // Qualifying spreads the cars round the lap so each runs in clear air.
      const back = quali ? i * Math.min(QUALI_SPACING, track.length / this.entries.length) : Math.floor(i / 2) * rowSpacing;
      c.place(track, track.gridS - back, quali ? 0 : i % 2 ? -laneOff : laneOff);
      c.fuelScale = this.cal.fuelScale;
      c.fuel = quali ? Math.min(TANK_LITRES, (TANK_LITRES / this.cal.fuelLaps) * (QUALI_LAPS + 1.6)) : TANK_LITRES;
      // All-AI teams pick their own start tyre; a human team starts on the chosen one.
      const allAi = e.team.drivers.every((d) => d.kind === 'ai');
      if (quali) { this.fitTyres(c, 'soft', true); fitHybrid(c, 1); c.hybrid && (c.hybrid.playerMode = 'qual'); }
      else { this.fitTyres(c, allAi ? e.strategist.startCompound(this.cal.fuelLaps) : this.startCompound); fitHybrid(c); }
      c.race = { progress: -gridToFinish - back, previousS: c.s, lap: 1, lastLap: null, bestLap: null, lapStart: 0, sector: 0, valid: true, sectors: [], secMark: 0, secValid: true, secCur: [null, null, null], secState: [null, null, null], secBest: [null, null, null], finishTime: null, offtrack: 0, pitLap: false };
      e.pit = null; e.pitPlan = null; e.retired = null; e.stints = [{ driver: e.active, fromLap: 1, toLap: null }];
      for (const b of e.bridges) b.reset?.({ cars: this.cars, track, line: this.lineFor(c) });
    });
    this.timingHistory = this.cars.map((c) => [{ progress: c.race.progress, time: 0 }]); this.nextTimingAt = 0;
  }
  start() {
    this.reset(); this.phase = 'countdown';
    if (this.session === 'qualifying') { this.countdown = 1.6; this.log('race', null, `QUALIFYING · OUT LAP + ${QUALI_LAPS} TIMED LAPS · GHOSTED`); }
    else { this.countdown = 4; this.log('race', null, `LIGHTS · ${this.laps} LAPS · ${this.cal.fuelLaps}-LAP FUEL STINTS`); }
  }
  /**
   * Marshal rescue: a car parked for 4 s (beached, pinned on a barrier, no
   * reverse gear) is lifted back onto the centreline where it stopped, keeping
   * its fuel, tyres and damage, and ghosts for 2 s so it cannot be collected.
   */
  rescue(e, dt) {
    const c = e.car;
    e.rescueGhost = Math.max(0, (e.rescueGhost ?? 0) - dt);
    // A human parked on purpose is left alone; one pinned on the throttle is rescued.
    const human = e.team.drivers[e.active]?.kind === 'human';
    // Under the pit autopilot nobody is holding the throttle on purpose: a car
    // parked outside its box, or spun round, is put back on the pit line.
    const pit = e.pit && e.pit.phase !== 'service' ? e.pit : null, near = this.track.nearest(c.x, c.z);
    const reversed = pit && Math.cos(near.heading - c.yaw) < -0.2;
    const boxing = pit && pit.phase === 'lane' && this.lane.d(near.s, pit.box) < 12;
    if ((e.pit && !pit) || boxing || c.race.finishTime !== null || this.time < 6 || (c.speed > 1.5 && !reversed) || (!pit && human && c.controls.throttle < 0.5)) { e.stuckTime = 0; return; }
    e.stuckTime = (e.stuckTime ?? 0) + dt;
    if (e.stuckTime < (pit ? 2.5 : 4)) return;
    const p = this.track.at(near.s, pit ? pit.targetLat(near.s) : 0);
    c.x = p.x; c.z = p.z; c.yaw = p.heading; c.lateral = 0;
    c.vx = 0; c.vz = 0; c.u = 0; c.v = 0; c.speed = 0; c.yawRate = 0; c.steering = 0; c.gear = 1;
    c.wheels.forEach((w) => { w.omega = 0; w.steer = 0; });
    e.stuckTime = 0; e.rescueGhost = 2;
    this.log('incident', e, `${e.team.short} · RECOVERED BY MARSHALS${pit ? ` · PIT ${pit.phase.toUpperCase()}` : ''}`);
    if (!pit) this.stewards?.recovered(e);
  }

  log(type, entry, text) {
    this.events.push({ id: ++this.eventSeq, time: this.time, type, team: entry?.team.id ?? null, text });
    if (this.events.length > 200) this.events.shift();
  }
  /** Live controls for a human seat; stale (>0.6 s) input hands to the co-driver. */
  setInput(driverId, controls) { this.inputs.set(driverId, { controls, time: this.time }); }
  inputFor(driverId) {
    const v = this.inputs.get(driverId);
    return v && this.time - v.time < 0.6 ? v.controls : null;
  }
  activeDriver(e) { return e.team.drivers[e.active]; }
  requestPit(teamId, request = {}) {
    const e = this.entries.find((x) => x.team.id === teamId); if (!e) return;
    e.strategist.request = e.strategist.request ? null : request;
    this.log('radio', e, e.strategist.request ? `${e.team.short} · BOX, BOX` : `${e.team.short} · BOX CANCELLED`);
  }
  /** Explicit pit request from a team's HUD (null cancels). */
  setPitRequest(teamId, request) {
    const e = this.entries.find((x) => x.team.id === teamId); if (!e) return;
    const had = Boolean(e.strategist.request);
    e.strategist.request = request ?? null;
    if (Boolean(request) !== had) this.log('radio', e, request ? `${e.team.short} · BOX, BOX` : `${e.team.short} · BOX CANCELLED`);
  }
  lapsLeft(c) { return this.laps - c.race.lap + 1; }

  primeSeats() {
    const projections = new Map(this.cars.map((c) => [c.id, this.track.nearest(c.x, c.z)]));
    const context = { projections, order: this.order(), totalLaps: this.laps, mode: 'race', time: this.time, paceObjective: 'race' };
    for (const e of this.entries) e.bridges[e.active].prime?.(e.car, this.cars, context);
  }

  step(dt) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      // Async seats query their controller during the lights so every car
      // already holds launch controls at green instead of waiting a round trip.
      if (this.countdown < 1.5) this.primeSeats();
      if (this.countdown <= 0) this.phase = 'racing';
      return;
    }
    if (this.phase !== 'racing') return;
    this.time += dt;
    this.weather.step(dt); this.weather.apply(this.track);
    const track = this.track, cars = this.cars, lane = this.lane;
    const projections = new Map(cars.map((c) => [c.id, track.nearest(c.x, c.z)]));
    const order = this.order();
    const context = { projections, order, totalLaps: this.laps, mode: 'race', time: this.time, paceObjective: 'race' };
    for (const e of this.entries) {
      const c = e.car, s = projections.get(c.id).s;
      // A disqualified car sits in its box, out of everyone's way.
      if (e.retired) { c.controls = { throttle: 0, brake: 1, steer: 0 }; continue; }
      // Strategy call once per lap, just before the approach point.
      if (this.session !== 'qualifying' && !e.pit && c.race.finishTime === null && c.race.progress > 0 && e.decidedLap !== c.race.lap && lane.inWindow(s, wrap(lane.approach - 120, lane.L), lane.approach)) {
        e.decidedLap = c.race.lap;
        e.pitPlan = e.strategist.decide(c, this.lapsLeft(c), e.team.drivers[e.active]?.kind !== 'human');
        if (e.pitPlan) this.log('strategy', e, `${e.team.short} · BOX THIS LAP · ${e.strategist.reason}`);
        // Race control overrides strategy: a drive-through comes first, and the
        // meatball (heavy damage) calls the car in for repairs.
        const penalty = this.stewards.pendingPenalty(e);
        if (penalty) { e.pitPlan = { litres: 0, tyres: false, swap: false, compound: c.wheels[0].tyre.compound, penalty: penalty.type }; this.log('strategy', e, `${e.team.short} · BOX THIS LAP · SERVE ${penalty.type.toUpperCase()}`); }
        else if (!e.pitPlan && (c.damage ?? 0) >= MEATBALL_DAMAGE) { e.pitPlan = e.strategist.servicePlan(c, this.lapsLeft(c)); this.log('strategy', e, `${e.team.short} · BOX THIS LAP · DAMAGE REPAIR`); }
      }
      if (!e.pit && e.pitPlan && c.race.finishTime === null && lane.inWindow(s, lane.approach, lane.entry)) {
        e.pit = new PitAutopilot(lane, e.box, this.lineFor(c)); e.pit.calledOnLap = c.race.lap; c.race.pitLap = true;
      }
      if (e.pit) {
        const p = e.pit, toEntry = lane.d(s, lane.entry);
        // AI drivers keep the wheel to the lane entry, a human until the final
        // lateral move: cars arrive here at the limit, often holding a slide the
        // AIs drive on, and only their own controller can carry that. A lock-aware
        // governor scrubs speed to the approach profile meanwhile.
        const cross = e.team.drivers[e.active]?.kind === 'human' ? lane.cross : Math.min(lane.cross, 0.5);
        if (p.phase === 'approach' && toEntry > cross && toEntry <= lane.d(lane.approach, lane.entry) && lane.cross < lane.d(lane.approach, lane.entry)) {
          e.bridges[e.active].update(c, cars, dt, context);
          p.track = track;
          const over = c.speed - p.targetSpeed(s, c), k = c.controls, lock = Math.min(1, Math.abs(k.steer ?? 0) * 2.5);
          if (over > -1.5) c.controls = { ...k, throttle: over <= 0 ? k.throttle * Math.min(1, -over / 1.5) : 0, brake: over > 1 ? Math.max(k.brake, Math.min(0.85, (over - 1) / 5) * (1 - 0.8 * lock)) : k.brake };
        } else {
          // Hand-over: blend from the driver's inputs to the autopilot over 1 s so
          // the lift and the steering change never snap the rear loose.
          const blend = p.phase !== 'service' && (p.age ?? 0) < 1;
          let driver = null;
          if (blend) { e.bridges[e.active].update(c, cars, dt, context); driver = { ...c.controls }; }
          c.automatic = true;
          this.pitStep(e, c, dt);
          if (blend && e.pit === p && p.phase !== 'service') {
            p.age = (p.age ?? 0) + dt;
            const w = Math.min(1, p.age), a = c.controls, mix = (key) => (driver[key] ?? 0) * (1 - w) + (a[key] ?? 0) * w;
            c.controls = { ...a, throttle: mix('throttle'), brake: mix('brake'), steer: mix('steer') };
          }
        }
      }
      else {
        const bridge = e.bridges[e.active];
        // AI drivers never shift by hand; a car handed over from a manual stint gets its auto box back.
        if (!bridge.human) c.automatic = true;
        bridge.update(c, cars, dt, context);
        if (!bridge.human || bridge.assisted) {
          // No point saving tyres on the last lap or the lap they come off.
          // Roster entries with `manage: false` run flat out all stint (no tyre-saving cap).
          const roster = AI_DRIVERS.find((a) => a.id === e.team.drivers[e.active]?.id);
          if (!(roster?.governor === false && e.governor.base >= .999)) {
            e.governor.push = this.session === 'qualifying' || roster?.manage === false || this.lapsLeft(c) <= 1 || Boolean(e.pitPlan?.tyres);
            e.governor.manageStep(c, dt); e.governor.apply(c, s);
          }
        }
        if (c.race.finishTime !== null) c.controls = { ...c.controls, throttle: Math.min(0.35, c.controls.throttle), brake: Math.max(c.controls.brake, c.speed > 25 ? 0.2 : 0) };
      }
    }
    // GTP hybrids: AI cars get their deploy mode from the gaps to same-class rivals.
    for (const e of this.entries) {
      const c = e.car; if (!c.hybrid) continue;
      const bridge = e.bridges[e.active];
      c.hybrid.auto = !bridge.human || bridge.assisted;
      if (c.hybrid.auto) {
        // Only same-class rivals are worth the energy; other-class traffic is passed on pace.
        let ahead = Infinity, behind = Infinity;
        for (const o of cars) if (o !== c && o.classId === c.classId) {
          const d = wrap(o.s - c.s, track.length);
          if (d > 0) { ahead = Math.min(ahead, d); behind = Math.min(behind, track.length - d); }
        }
        aiDeployMode(c, ahead, this.lapsLeft(c), this.session === 'qualifying' ? (c.race.progress < 0 ? 'out' : 'push') : false, behind);
      } else c.hybrid.mode = c.hybrid.playerMode ?? 'balanced';
      hybridStep(c, dt);
    }
    const airflow = wakes(cars);
    cars.forEach((c, i) => c.step(dt, track, airflow[i]));
    // Pit-lane ghosting: two cars inside the lane under the autopilot never collide,
    // so box entries and releases cannot jam the lane.
    this.entries.forEach((e) => this.rescue(e, dt));
    for (const e of this.entries) { const c = e.car; c.ghost = this.session === 'qualifying' || e.rescueGhost > 0 || Boolean(e.retired) || Boolean(e.pit && e.pit.phase !== 'approach' && this.lane.inLane(this.track.nearest(c.x, c.z).s)); }
    this.contacts += collisions(cars, this.collisionStats);
    this.stewards.step(dt);
    this.entries.forEach((e) => this.timing(e));
    if (this.time >= this.nextTimingAt) {
      this.nextTimingAt = this.time + 0.25;
      for (const c of cars) { const h = this.timingHistory[c.id]; if (c.race.progress > h.at(-1).progress) { h.push({ progress: c.race.progress, time: this.time }); if (h.length > 4000) h.shift(); } }
    }
    const done = cars.filter((c) => c.race.finishTime !== null), home = done.filter((c) => !c.race.dq);
    if (this.session === 'qualifying') {
      // Session ends when every car has run its laps, or at the time limit.
      if (done.length === cars.length || this.time > QUALI_TIME_LIMIT) { this.phase = 'finished'; this.results = this.standings(); this.log('flag', null, 'QUALIFYING COMPLETE'); }
      return;
    }
    if (home.length && this.finishedAt === null) { this.finishedAt = this.time; this.log('flag', null, `CHEQUERED FLAG · ${home[0].team.name} WINS`); }
    if (done.length === cars.length || (this.finishedAt !== null && this.time - this.finishedAt > 120)) { this.phase = 'finished'; this.results = this.standings(); }
  }

  pitStep(e, c, dt) {
    const p = e.pit;
    if (p.phase !== 'service') {
      const handed = p.update(c, this.track, dt);
      if (p.phase === 'service') this.beginService(e, c);
      if (handed) {
        e.pit = null; e.pitPlan = null; c.race.pitLap = false;
        e.bridges[e.active].reset?.({ cars: this.cars, track: this.track, line: this.lineFor(c) });
      }
      return;
    }
    c.controls = { throttle: 0, brake: 1, steer: 0 };
    p.serviceLeft -= dt;
    const plan = e.pitPlan;
    if (plan.penalty) {
      // Drive-through: no service, the car is released as soon as the lane is clear.
      if (!p.serviced) { p.serviced = true; this.stewards.serve(e); }
      if (this.releaseClear(e, c)) p.release();
      return;
    }
    c.fuel = Math.min(TANK_LITRES, c.fuel + plan.litres * dt / Math.max(0.1, p.serviceTotal));
    if (p.serviceLeft <= 0 && !p.serviced) {
      p.serviced = true;
      if (plan.tyres) this.fitTyres(c, plan.compound, true);
      if (plan.repair) c.damage = 0;
      if (plan.swap) {
        const prev = e.active; e.active = (e.active + 1) % e.team.drivers.length;
        e.stints.at(-1).toLap = c.race.lap; e.stints.push({ driver: e.active, fromLap: c.race.lap, toLap: null });
        this.log('swap', e, `${e.team.short} · ${e.team.drivers[prev].name} → ${this.activeDriver(e).name}`);
      }
      e.strategist.stopDone(plan);
      this.log('pit', e, `${e.team.short} · ${p.serviceTotal.toFixed(1)}s${plan.litres > 0.5 ? ` · +${plan.litres.toFixed(0)}L` : ''}${plan.tyres ? ` · ${COMPOUNDS[plan.compound].label}` : ''}${plan.repair ? ' · REPAIR' : ''}`);
      e.pitStopTime += p.serviceTotal;
    }
    // Unsafe-release guard: wait while another car is about to pass the box.
    if (p.serviced && this.releaseClear(e, c)) p.release();
  }
  releaseClear(e, c) {
    const lane = this.lane;
    return this.cars.every((o) => {
      if (o === c) return true;
      const s = this.track.nearest(o.x, o.z).s;
      if (!lane.inLane(s)) return true;
      return lane.d(s, e.box) > 35 && lane.d(e.box, s) > 8;
    });
  }
  beginService(e, c) {
    // The plan is refreshed at the box so human choices made in the lane count.
    // Laps after the stop are counted from the lap the stop was called on: the
    // line can sit inside the pit lane (Harbor Ring), so the lap counter may
    // already have ticked over by the time the car reaches its box.
    const calledOn = e.pit.calledOnLap ?? c.race.lap;
    if (e.pitPlan?.penalty) { e.pit.serviceTotal = e.pit.serviceLeft = 0; c.vx = 0; c.vz = 0; return; }
    e.pitPlan = e.strategist.servicePlan(c, Math.max(0, this.laps - calledOn));
    // Damage is repaired at every stop: 3 s per 10% of damage (fast-repair style).
    const damage = c.damage ?? 0; if (damage >= 0.05) e.pitPlan = { ...e.pitPlan, repair: damage };
    e.pit.serviceTotal = serviceTime(this.cal, e.pitPlan) + (e.pitPlan.repair ?? 0) * 30;
    e.pit.serviceLeft = e.pit.serviceTotal;
    c.vx = 0; c.vz = 0;
  }

  timing(e) {
    const c = e.car, r = c.race, track = this.track;
    const previousProgress = r.progress;
    const delta = wrap(c.s - r.previousS + track.length / 2, track.length) - track.length / 2;
    r.previousS = c.s;
    if (Math.abs(delta) < 20) r.progress += delta;
    if (previousProgress < 0 && r.progress >= 0) { r.lapStart = r.secMark = this.time; r.valid = r.secValid = true; }
    // Kerbs count as track: a lap is lost only with the car centre beyond the kerb.
    if (!e.pit && !halfCarInside(c.lateral, track.halfWidth + (track.curbWidth ?? 0))) { r.valid = r.secValid = false; r.offtrack += 1 / 120; }
    const totalSectors = Math.floor(Math.max(0, r.progress) / (track.length / 3));
    if (totalSectors > r.sector) {
      r.sectors.push(this.time); r.sector = totalSectors;
      this.sectorTime(e, (totalSectors - 1) % 3);
      if (totalSectors % 3 === 0) {
        r.lastLap = this.time - r.lapStart;
        const clean = r.valid && !r.pitLap && !e.pit && !e.lapHadPit;
        // Lap colours as for sectors: purple overall best, green personal best, yellow slower, red invalid.
        this.lapBest ??= null;
        r.lastState = !clean ? (r.valid ? 'pit' : 'red') : this.lapBest === null || r.lastLap < this.lapBest ? 'purple' : r.bestLap === null || r.lastLap < r.bestLap ? 'green' : 'yellow';
        if (clean && (this.lapBest === null || r.lastLap < this.lapBest)) this.lapBest = r.lastLap;
        if (clean && (r.bestLap === null || r.lastLap < r.bestLap)) r.bestLap = r.lastLap;
        e.strategist.observeLap(c, clean && r.lap > 1);
        e.lapHadPit = Boolean(e.pit);
        r.lapStart = this.time; r.lap++; r.valid = true;
        // Chequered flag: once the winner is home, everyone finishes at their next crossing.
        if ((r.lap > this.laps || (this.finishedAt != null && this.session !== 'qualifying')) && r.finishTime === null) { r.finishTime = this.time; r.finishLaps = r.lap - 1; e.stints.at(-1).toLap = r.lap - 1; }
      }
    }
  }
  /** Sector split colours: purple = overall best, green = personal best, yellow = slower, red = track limits. */
  sectorTime(e, k) {
    const r = e.car.race, t = this.time - r.secMark;
    r.secMark = this.time;
    if (k === 0) { r.secCur[1] = r.secCur[2] = null; r.secState[1] = r.secState[2] = null; }
    r.secCur[k] = t;
    const counts = r.secValid && !e.pit && !r.pitLap && !e.lapHadPit;
    r.secValid = true;
    if (!counts) { r.secState[k] = e.pit || e.lapHadPit ? 'pit' : 'red'; return; }
    this.secBest ??= [null, null, null];
    const overall = this.secBest[k] === null || t < this.secBest[k], personal = r.secBest[k] === null || t < r.secBest[k];
    if (personal) r.secBest[k] = t;
    if (overall) this.secBest[k] = t;
    r.secState[k] = overall ? 'purple' : personal ? 'green' : 'yellow';
  }
  order() {
    // Qualifying ranks by best clean lap; cars without a time follow in grid order.
    if (this.session === 'qualifying') return [...this.cars].sort((a, b) => (a.race.bestLap ?? Infinity) - (b.race.bestLap ?? Infinity) || a.id - b.id);
    return [...this.cars].sort((a, b) => {
      if (Boolean(a.race.dq) !== Boolean(b.race.dq)) return a.race.dq ? 1 : -1;
      const fa = a.race.finishTime !== null, fb = b.race.finishTime !== null;
      if (fa && fb) return b.race.finishLaps - a.race.finishLaps || a.race.finishTime - b.race.finishTime;
      return fa !== fb ? (fa ? -1 : 1) : b.race.progress - a.race.progress;
    });
  }
  standings() { return this.order(); }
  interval(car, leader = this.order()[0]) {
    if (car === leader) return 0;
    if (this.session === 'qualifying') return car.race.bestLap !== null && leader.race.bestLap !== null ? car.race.bestLap - leader.race.bestLap : null;
    if (car.race.finishTime !== null && leader.race.finishTime !== null) return car.race.finishTime - leader.race.finishTime;
    return raceInterval(this.timingHistory[leader.id], car.race.progress, this.time, leader.race.progress);
  }
  entryOf(car) { return this.entries[car.id]; }

  /** Takes a car out of the race (disqualification): parked in its box, ghosted, classified last. */
  retire(e, reason) {
    const c = e.car; e.retired = reason; e.pit = null; e.pitPlan = null;
    c.race.dq = reason === 'DQ'; c.race.finishTime = this.time; c.race.finishLaps = Math.max(0, c.race.lap - 1);
    e.stints.at(-1).toLap = c.race.finishLaps;
    const box = this.track.at(e.box, this.lane.boxLat ?? 0);
    c.x = box.x; c.z = box.z; c.yaw = box.heading; c.vx = c.vz = c.u = c.v = c.speed = c.yawRate = 0;
  }

  /** Finishing classification for the results screen. */
  /** Position of each car inside its own class (multiclass fields). */
  classPositions(order) {
    const seen = {}, out = new Map();
    for (const c of order) { const k = classForCar(c).id; seen[k] = (seen[k] ?? 0) + 1; out.set(c, seen[k]); }
    return out;
  }
  classification() {
    const order = this.standings(), leader = order[0], inClass = this.classPositions(order);
    return order.map((c, i) => {
      const e = this.entryOf(c);
      return {
        position: i + 1, id: c.id, raceClass: classForCar(c).id, classPosition: inClass.get(c), team: e.team.id, finishTime: c.race.finishTime, lapsDone: c.race.finishLaps ?? Math.min(this.laps, c.race.lap - 1),
        gap: this.interval(c, leader), bestLap: c.race.bestLap, stops: e.strategist.stops, swaps: e.strategist.swaps,
        pitStopTime: e.pitStopTime, stints: e.stints, fuel: c.fuel, damage: c.damage,
        incidents: this.stewards.of(e).inc, dq: Boolean(c.race.dq), penaltiesServed: this.stewards.of(e).served
      };
    });
  }

  /** Compact, serialisable state for HUD / network clients. */
  snapshot() {
    const order = this.order(), leader = order[0], hazards = this.stewards.hazards(), inClass = this.classPositions(order);
    return {
      flag: this.stewards.raceFlag(), incidentLimits: this.stewards.limits,
      session: this.session, phase: this.phase, time: this.time, countdown: this.countdown, laps: this.laps, cal: { fuelLaps: this.cal.fuelLaps, tyreLaps: this.cal.tyreLaps },
      cars: this.cars.map((c) => {
        const e = this.entryOf(c), d = this.activeDriver(e);
        return {
          id: c.id, team: e.team.id, x: c.x, z: c.z, y: c.y, yaw: c.yaw, roll: c.roll, pitch: c.pitch, heave: c.heave, speed: c.speed, rpm: c.rpm, gear: c.gear, steering: c.steering,
          throttle: c.controls.throttle, brake: c.controls.brake,
          fuel: c.fuel, wear: c.wheels.map((w) => w.tyre.wear), temps: c.wheels.map((w) => w.tyre.surface), compound: c.wheels[0].tyre.compound, damage: c.damage,
          lap: Math.min(c.race.lap, this.laps), progress: c.race.progress, lastLap: c.race.lastLap, lastLapState: c.race.lastState === 'purple' && c.race.lastLap > this.lapBest ? 'green' : c.race.lastState ?? null, bestLap: c.race.bestLap, finished: c.race.finishTime !== null,
          position: order.indexOf(c) + 1, gap: this.interval(c, leader), raceClass: classForCar(c).id, classPosition: inClass.get(c),
          hybrid: c.hybrid ? { soc: c.hybrid.energy / HYBRID.capacity, mode: c.hybrid.mode, kw: c.hybrid.kw } : null,
          driver: d.id, driverName: d.name, driverKind: d.kind, stops: e.strategist.stops, pit: e.pit?.phase ?? null, boxCalled: Boolean(e.pitPlan || e.strategist.request),
          serviceLeft: e.pit?.phase === 'service' ? e.pit.serviceLeft : 0, serviceTotal: e.pit?.serviceTotal ?? 0,
          active: e.active, fuelPerLap: e.strategist.fuelPerLap, reason: e.strategist.reason, request: e.strategist.request,
          plan: e.pitPlan, stints: e.stints, pitStopTime: e.pitStopTime, finishTime: c.race.finishTime, valid: c.race.valid, sectors: c.race.secCur.slice(), sectorState: c.race.secState.map((st, k) => (st === 'purple' && c.race.secCur[k] > this.secBest?.[k] ? 'green' : st)), sectorBest: c.race.secBest.slice(),
          coDriving: Boolean(e.bridges[e.active]?.assisted),
          s: c.s, lateral: c.lateral, incidents: this.stewards.of(e).inc, flag: this.stewards.flagFor(e, hazards), penalty: this.stewards.pendingPenalty(e)?.type ?? null, dq: Boolean(c.race.dq)
        };
      }),
      weather: this.weather.snapshot(),
      events: this.events.slice(-12)
    };
  }
}

export { maxWear };
