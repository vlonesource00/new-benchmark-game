import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { halfCarInside } from '../../../game/engine/sim/racecraft-policy.js';
import { observe, toAction, toControls, gap, angle, SCHEMA } from '../src/schema.mjs';
import { ActionMailbox, supervise, timing } from '../src/runtime.mjs';
import { observationProfile } from '../src/observations.mjs';
import { SeatTiming } from '../src/seat-timing.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';

export const pose = c => ({ id: c.id, classId: c.classId, x: c.x, z: c.z, yaw: c.yaw, speed: c.speed,
  s: c.s, lateral: c.lateral, progress: c.race.progress, fuel: c.fuel, damage: c.damage,
  battery: c.hybrid?.energy ?? 0, controls: { ...c.controls }, tc: c.tcActive, abs: c.absActive, ghost: !!c.ghost,
  lap: c.race.lap, lapValid: c.race.valid, gameOfftrack: c.race.offtrack,
  tyres: c.wheels.map(w => ({ core: w.tyre.core, wear: w.tyre.wear, kappa: w.tyre.kappa, alpha: w.tyre.alpha })) });

export async function runScenario(options = {}) {
  const initializationStart = performance.now();
  const settings = { track: 'harbor-ring', classId: 'lmdh', fixture: 'solo', seconds: 60, seed: 7, rate: 60,
    weather: 'clear', mode: 'teacher', start: 20, lateral: 0, rivalOffset: 0, yawOffset: 0, speed: 45, rival: 'intercept',
    lagMs: 0, spikeAt: 3, spikeMs: 0, stallAt: 3, stallMs: 0, hazardAt: 0,
    expertMix: .5, expertBlockMs: 250, traceExpert: false, probeExpertHistory: false, holdExpert: false, heldExpertLagMs: 0, warmupToStart: false, velocityYawOffset: 0,
    disturbanceSteer: 0, disturbanceLongitudinal: 0, disturbanceDuration: .2, disturbancePeriod: 3,
    diagnosticExpertActuator: null, trainingExpertActuator: null,
    rivalGap: 55, trainSpacing: 85, rivalSpeed: null, tailGapDelta: 0, tailSpeed: null,
    fastMotor: false, motorRate: 60, expertDriver: 'intercept',
    transport: 'native', frameSteps: 2, lagFrames: 0, lagJitter: 0, frameJitter: 0, scheduleSeed: 7, replyServiceMs: null,
    observationVersion: SCHEMA.version, ...options };
  const { schema, observe: observeAt } = observationProfile(settings.observationVersion);
  if (!['teacher', 'shadow', 'policy', 'dagger'].includes(settings.mode)) throw Error('Invalid mode');
  if (!['solo', 'pair', 'train', 'stopped', 'spun', 'field'].includes(settings.fixture)) throw Error('Invalid fixture');
  // Generated field: each rival has its own driver, class, placement and an
  // optional stop/spin time (0 = already stopped). Speeds are physical m/s.
  if (settings.fixture === 'field' && (!Array.isArray(settings.field) || settings.field.length < 1 || settings.field.length > 6
    || settings.field.some(f => typeof f.driver !== 'string' || !['gt', 'lmdh'].includes(f.classId)
      || !(f.gap >= -80 && f.gap <= 400) || !(Math.abs(f.lateral) <= 9) || !(f.speed >= 0 && f.speed <= 90)
      || !(f.stopAt === null || f.stopAt === undefined || f.stopAt >= 0 && f.stopAt <= 120)
      || ![null, undefined, 'stopped', 'spun'].includes(f.hazard) || (!f.hazard) !== (f.stopAt === null || f.stopAt === undefined))))
    throw Error('Invalid bounded generated field');
  if (![20, 30, 60, 120].includes(settings.rate)) throw Error('rate must be 20, 30, 60 or 120');
  if (!(settings.seconds > 0 && settings.seconds <= 600)) throw Error('Duration must be between 0 and 600 seconds');
  if (![settings.seed, settings.start, settings.lateral, settings.rivalOffset, settings.yawOffset, settings.speed, settings.lagMs, settings.spikeMs, settings.spikeAt, settings.stallAt, settings.stallMs, settings.hazardAt].every(Number.isFinite)
    || settings.lagMs < 0 || settings.spikeMs < 0 || settings.stallMs < 0 || settings.speed < 0) throw Error('Finite nonnegative speeds/delays required');
  if (settings.mode !== 'teacher' && !settings.policy) throw Error('shadow/policy requires a checkpoint');
  if (settings.planFactory && (settings.mode !== 'policy' || settings.fastMotor || settings.diagnosticExpertActuator
    || settings.trainingExpertActuator || settings.actionContract !== PLAN_CONTRACT.version))
    throw Error('Plan execution requires its explicit action contract and unassisted policy mode');
  if (!settings.planFactory && settings.actionContract === PLAN_CONTRACT.version)
    throw Error('Lane/pace intentions cannot drive raw actuators');
  if (!['native', 'seat-frame'].includes(settings.transport)) throw Error('Invalid transport');
  if (settings.transport === 'seat-frame' && (settings.mode === 'teacher' || settings.holdExpert))
    throw Error('Seat-frame transport currently requires a policy; held teacher uses its separate diagnostic');
  if (settings.replyServiceMs !== null && (!Number.isFinite(settings.replyServiceMs) || settings.replyServiceMs < 0 || settings.replyServiceMs > 2000))
    throw Error('Invalid emulated inference service time');
  const seatTiming = settings.transport === 'seat-frame' ? new SeatTiming({ ...settings, step: FIXED_DT }) : null;
  if (!['intercept', 'razor', 'apex', 'next-racer'].includes(settings.expertDriver)
    || (settings.expertDriver !== 'intercept' && (settings.mode !== 'teacher' || settings.traceExpert || settings.probeExpertHistory)))
    throw Error('Alternative expert is a teacher-only comparison, without INTERCEPT-specific probes');
  if (settings.fastMotor && (settings.mode !== 'policy' || typeof settings.motor !== 'function'
    || ![20, 30, 60, 120].includes(settings.motorRate) || settings.diagnosticExpertActuator || settings.trainingExpertActuator))
    throw Error('Two-rate motor requires unassisted policy mode and a compatible local motor');
  if (settings.diagnosticExpertActuator && (settings.mode !== 'policy' || !['steer', 'longitudinal'].includes(settings.diagnosticExpertActuator)))
    throw Error('Component intervention is a policy-only diagnostic');
  if (settings.trainingExpertActuator && (settings.mode !== 'dagger' || settings.trainingExpertActuator !== 'longitudinal'))
    throw Error('Pedal curriculum is training-only DAgger; no evaluation actuator assistance');
  if (settings.holdExpert && settings.mode !== 'teacher') throw Error('Held expert is a teacher-only cadence diagnostic');
  if (!Number.isFinite(settings.heldExpertLagMs) || settings.heldExpertLagMs < 0 || settings.heldExpertLagMs > 100
    || (settings.heldExpertLagMs && !settings.holdExpert)) throw Error('Expert delay requires the bounded held-teacher diagnostic');
  if (![settings.disturbanceSteer, settings.disturbanceLongitudinal, settings.disturbanceDuration, settings.disturbancePeriod].every(Number.isFinite)
    || settings.disturbanceSteer < 0 || settings.disturbanceSteer > .25 || settings.disturbanceLongitudinal < 0 || settings.disturbanceLongitudinal > 1
    || settings.disturbanceDuration < .05 || settings.disturbanceDuration > .75
    || settings.disturbancePeriod < 1.5 || settings.disturbancePeriod > 10) throw Error('Invalid bounded training disturbance');
  if ((settings.disturbanceSteer || settings.disturbanceLongitudinal) && (settings.mode !== 'teacher' || settings.holdExpert || settings.probeExpertHistory))
    throw Error('Training disturbances require the unheld teacher; they cannot drive a policy evaluation');
  if (settings.warmupToStart && (settings.mode !== 'teacher' || settings.fixture !== 'solo')) throw Error('Warm recoveries are teacher-only solo collection');
  if (!Number.isFinite(settings.velocityYawOffset) || Math.abs(settings.velocityYawOffset) > .2 || (settings.velocityYawOffset && !settings.warmupToStart))
    throw Error('Velocity perturbation requires bounded warm collection');
  if (!(settings.expertMix >= 0 && settings.expertMix <= 1) || !(settings.expertBlockMs >= 50 && settings.expertBlockMs <= 2000)) throw Error('Invalid bounded expert mixture');
  if (!Number.isFinite(settings.rivalGap) || settings.rivalGap < 12 || settings.rivalGap > 240
    || !Number.isFinite(settings.trainSpacing) || settings.trainSpacing < 15 || settings.trainSpacing > 220
    || (settings.rivalSpeed !== null && (!Number.isFinite(settings.rivalSpeed) || settings.rivalSpeed < 0 || settings.rivalSpeed > 90)))
    throw Error('Invalid bounded traffic placement');
  if (!Number.isFinite(settings.tailGapDelta) || Math.abs(settings.tailGapDelta) > 30
    || (settings.tailSpeed !== null && (!Number.isFinite(settings.tailSpeed) || settings.tailSpeed < 0 || settings.tailSpeed > 90))
    || (settings.fixture !== 'train' && (settings.tailGapDelta || settings.tailSpeed !== null)))
    throw Error('Tail-car variation requires bounded moving train traffic');
  const count = settings.fixture === 'field' ? 1 + settings.field.length : settings.fixture === 'solo' ? 1 : settings.fixture === 'train' ? 4 : 2;
  const fieldAt = i => settings.fixture === 'field' && i ? settings.field[i - 1] : null;
  const teams = Array.from({ length: count }, (_, i) => ({ id: `pulse-lab-${i}`, index: i, grid: i, starter: 0,
    name: i ? `Rival ${i}` : 'PULSE laboratory', short: i ? `GT${i}` : 'PLS', color: i ? '#51d5df' : '#ffd166',
    classId: fieldAt(i)?.classId ?? (i && settings.fixture === 'train' ? 'gt' : settings.classId),
    drivers: [{ id: i ? fieldAt(i)?.driver ?? settings.rival : settings.expertDriver, kind: 'ai', name: i ? fieldAt(i)?.driver ?? settings.rival : settings.expertDriver + ' reference', short: i ? 'RIV' : 'REF' }] }));
  const mailbox = new ActionMailbox({ actionSize: settings.planFactory ? PLAN_CONTRACT.width : 2 }), delayed = [], rows = [], events = [], teacherMs = [], encoderMs = [], inferenceMs = [], supervisorMs = [];
  let armed = false, current = null, previous = [0, 0], race, acceptedAt = 0;
  let planExecutor = null;
  let motorAction = [0, 0], motorPending = null, trafficCorrection = [0, 0], lastMotorRequestAt = 0, motorAcceptedAt = 0;
  const motorMs = [];
  const combinedAction = () => motorAction.map((value, i) => Math.max(-1, Math.min(1, value + trafficCorrection[i])));
  const expertQueue = []; let expertHeld = { throttle: 0, brake: 0, steer: 0 };
  const makeBridge = (driver, index, r) => {
    const teacher = createSeatBridge(driver, index, r);
    if (index) return teacher;
    const wrapped = Object.create(teacher);
    wrapped.update = (car, cars, dt, context) => {
      const traceThis = armed && settings.traceExpert && current && !current.teacherControls;
      const beforeController = traceThis ? { curvature: teacher.driver.controller.kc, acceleration: teacher.driver.controller.acceleration,
        actualSteer: car.controls.steer } : null;
      const t = performance.now(); teacher.update(car, cars, dt, context); teacherMs.push(performance.now() - t);
      if (!armed) return;
      if (current && !current.teacherControls) {
        current.teacherControls = { ...car.controls };
        if (traceThis) current.teacherTrace = { previous: beforeController, ...teacher.driver.controller.trace,
          intent: teacher.driver.battle.state, routeKey: teacher.driver.path.key };
        if (settings.probeExpertHistory) {
          // Label-only counterfactual. Restore every controller field and the
          // controls before the real physics step; this never drives either car.
          const d = teacher.driver, controller = d.controller, saved = { ...controller }, controls = car.controls;
          try {
            controller.kc = NaN;
            controller.step(car, d.path, d.course, d.observer, Math.max(1 / 120, Math.min(.1, dt)), {
              pit: saved.trace.pitCap ?? Infinity, time: context.time ?? 0,
              brakingTube: d.options.brakingTube && !d.state.formation && d.state.phase !== 'grid' && d.state.phase !== 'countdown'
            });
            current.teacherHistoryProbe = { withoutCurvatureMemory: { ...car.controls },
              continuousCurvature: saved.trace.k, instantaneousCurvature: controller.trace.k,
              measuredCurvature: car.ay / Math.max(.25, car.speed * car.speed) };
          } finally { Object.assign(controller, saved); car.controls = controls; }
        }
      }
      if (settings.holdExpert) {
        const elapsed = context.time - startAt;
        if (!current.expertQueued) {
          expertQueue.push({ due: elapsed + settings.heldExpertLagMs / 1000, controls: { ...current.teacherControls } });
          current.expertQueued = true;
        }
        while (expertQueue.length && expertQueue[0].due <= elapsed + 1e-9) expertHeld = expertQueue.shift().controls;
        car.controls = { ...expertHeld };
      }
      if (settings.mode === 'policy' || (settings.mode === 'dagger' && !current?.expertChosen)) {
        const proposed = planExecutor ? planExecutor.step(car, cars, dt, { time: context.time - startAt, state: context })
          : toControls(settings.fastMotor ? combinedAction() : mailbox.action);
        if (planExecutor && current) current.planTrace = { ...planExecutor.trace };
        if (settings.diagnosticExpertActuator === 'steer') proposed.steer = car.controls.steer;
        if (settings.diagnosticExpertActuator === 'longitudinal' || settings.trainingExpertActuator === 'longitudinal') { proposed.throttle = car.controls.throttle; proposed.brake = car.controls.brake; }
        const t = performance.now(), safe = supervise(toAction(proposed), race, car); supervisorMs.push(performance.now() - t);
        car.controls = safe.controls;
        if (current) for (const reason of safe.reasons) if (!current.safety.includes(reason)) current.safety.push(reason);
      }
      if (settings.disturbanceSteer || settings.disturbanceLongitudinal) {
        const elapsed = context.time - startAt, cycle = Math.floor((elapsed + 1e-9) / settings.disturbancePeriod);
        const within = elapsed - cycle * settings.disturbancePeriod;
        const active = cycle > 0 && within < settings.disturbanceDuration;
        // Seeded external control pulses make real speed/tyre/yaw transients. The
        // expert labels the resulting state before the pulse is applied; noisy
        // execution is never a cloning target or an autonomous driving result.
        const bits = Math.imul(cycle ^ settings.seed, 0x45d9f3b) >>> 0, sign = bits & 0x8000 ? 1 : -1;
        const envelope = active ? sign * Math.sin(Math.PI * within / settings.disturbanceDuration) : 0;
        const delta = settings.disturbanceSteer * envelope, longitudinalDelta = settings.disturbanceLongitudinal * envelope;
        const action = toAction(car.controls); action[0] += delta; action[1] += longitudinalDelta;
        car.controls = toControls(action);
        if (current) current.trainingDisturbance ??= { steerDelta: delta, longitudinalDelta, cycle, active };
      }
    };
    wrapped.reset = snapshot => { teacher.reset?.(snapshot); mailbox.reset(); planExecutor?.reset(); motorAction = [0, 0]; motorPending = null; trafficCorrection = [0, 0]; lastMotorRequestAt = 0; motorAcceptedAt = 0; };
    wrapped.dispose = () => teacher.dispose?.();
    return wrapped;
  };
  const track = new Track(settings.track);
  race = new EnduranceRace({ track, teams, makeBridge, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
    laps: 20, startCompound: 'soft', difficulty: 1, seed: settings.seed, weatherSeed: settings.seed,
    weather: settings.weather, startType: 'standing' });
  race.start();
  for (let i = 0; race.phase !== 'racing'; i++) {
    if (i > 2000) throw Error('Start did not reach racing phase');
    race.step(FIXED_DT);
  }
  let startAt = race.time;
  for (let i = 0; i < count; i++) {
    const c = race.cars[i], fuel = c.fuel;
    const f = fieldAt(i);
    const s = f ? settings.start + f.gap : (settings.warmupToStart ? 20 : settings.start) + (i ? settings.rivalGap + (i - 1) * settings.trainSpacing : 0)
      + (i === count - 1 && settings.fixture === 'train' ? settings.tailGapDelta : 0),
      lateral = f ? f.lateral : (settings.warmupToStart ? 0 : settings.lateral) + (i ? ((i % 2) ? .2 : -.2) + settings.rivalOffset : 0);
    const speed = f ? f.speed : i === count - 1 && settings.fixture === 'train' && settings.tailSpeed !== null ? settings.tailSpeed
      : i ? settings.rivalSpeed ?? (settings.fixture === 'train' ? 43 : settings.speed) : settings.speed;
    c.place(track, ((s % track.length) + track.length) % track.length, lateral, speed); c.fuel = fuel;
    if (i === 0 && settings.yawOffset && !settings.warmupToStart) { c.yaw += settings.yawOffset; c.vx = Math.sin(c.yaw) * speed; c.vz = Math.cos(c.yaw) * speed; }
    c.race = { ...c.race, progress: s, previousS: c.s, lap: 1, lapStart: startAt, finishTime: null };
    c.gear = c.classId === 'lmdh' ? 4 : 3;
    race.fitTyres(c, 'soft', true);
    race.entries[i].strategist.decide = () => null;
  }
  for (const e of race.entries) for (const bridge of e.bridges) bridge.reset?.({ cars: race.cars, track });
  let warmupSeconds = 0;
  if (settings.warmupToStart) {
    if (settings.start < 20 || settings.start >= track.length - 20 || Math.abs(settings.yawOffset) > .2 || Math.abs(settings.lateral) > 3)
      throw Error('Warm recovery target/perturbation out of bounds');
    // The expert actually drives to the sampling point. Tyres, yaw dynamics and
    // its controller memory come from executed motion, not a reset pose at speed.
    const c = race.cars[0];
    for (let n = 0; c.race.progress < settings.start; n++) {
      if (n > 20000 || race.phase !== 'racing') throw Error('Warm recovery did not reach its point');
      race.step(FIXED_DT);
      if (c.damage || !halfCarInside(Math.abs(c.lateral) - (c.spec?.track ?? 1.72) / 2, track.halfWidth + (track.curbWidth ?? 0)))
        throw Error('Warm expert approach was not clean');
    }
    warmupSeconds = race.time - startAt; startAt = race.time;
    const road = track.nearest(c.x, c.z), safeEdge = track.halfWidth + (track.curbWidth ?? 0) - (c.spec?.track ?? 1.72) / 2 - .3;
    const targetOffset = Math.max(-safeEdge, Math.min(safeEdge, road.lateral + settings.lateral));
    c.x += road.nx * (targetOffset - road.lateral); c.z += road.nz * (targetOffset - road.lateral);
    c.yaw += settings.yawOffset;
    const motionYaw = Math.atan2(c.vx, c.vz) + settings.velocityYawOffset, speed = Math.hypot(c.vx, c.vz);
    c.vx = Math.sin(motionYaw) * speed; c.vz = Math.cos(motionYaw) * speed;
    const at = track.nearest(c.x, c.z); c.s = at.s; c.lateral = at.lateral;
    previous = toAction(c.controls);
    events.push({ time: 0, type: 'training-state-perturbation', warmupSeconds, s: c.s,
      lateralDelta: targetOffset - road.lateral, yawDelta: settings.yawOffset, velocityYawDelta: settings.velocityYawOffset });
  }
  let stopHazard = null;
  if (settings.fixture === 'stopped' || settings.fixture === 'spun') {
    stopHazard = () => {
      const c = race.cars[1], fuel = c.fuel, state = c.race, damage = c.damage;
      c.place(track, settings.hazardAt === 0 ? settings.start + 90 : c.s, settings.hazardAt === 0 ? settings.lateral : c.lateral, 0);
      c.fuel = fuel; c.race = state; c.damage = damage;
      if (settings.fixture === 'spun') c.yaw += Math.PI * .55;
      race.entries[1].bridges[0].update = car => { car.controls = { throttle: 0, brake: 1, steer: 0 }; };
      events.push({ time: race.time - startAt, type: 'hazard-stop', id: c.id, s: c.s });
    };
    if (settings.hazardAt === 0) { stopHazard(); stopHazard = null; }
    const rescue = race.rescue.bind(race);
    race.rescue = (entry, dt) => { if (entry !== race.entries[1]) rescue(entry, dt); };
  }
  const fieldHazards = settings.fixture === 'field' ? settings.field.map((f, k) => f.hazard ? { ...f, i: k + 1, done: false } : null).filter(Boolean) : [];
  const fieldStop = h => {
    const c = race.cars[h.i], fuel = c.fuel, state = c.race, damage = c.damage;
    c.place(track, c.s, c.lateral, 0); c.fuel = fuel; c.race = state; c.damage = damage;
    if (h.hazard === 'spun') c.yaw += Math.PI * .55;
    race.entries[h.i].bridges[0].update = car => { car.controls = { throttle: 0, brake: 1, steer: 0 }; };
    events.push({ time: race.time - startAt, type: 'hazard-stop', id: c.id, s: c.s }); h.done = true;
  };
  for (const h of fieldHazards) if (h.stopAt === 0) fieldStop(h);
  if (fieldHazards.length) {
    const rescue = race.rescue.bind(race), held = new Set(fieldHazards.map(h => race.entries[h.i]));
    race.rescue = (entry, dt) => { if (!held.has(entry)) rescue(entry, dt); };
  }
  const self = race.cars[0], stride = Math.round(120 / settings.rate), iterations = Math.round(settings.seconds / FIXED_DT);
  const motorStride = Math.round(120 / settings.motorRate);
  const beforeFuel = self.fuel, beforeDamage = self.damage, startProgress = self.race.progress;
  let cumulativeDamage = 0, lastDamage = self.damage, tick = 0, interventionRows = 0, clippedRows = 0, missingRows = 0, simultaneous = 0;
  let minSpeed = self.speed, maxRoadOffset = Math.abs(self.lateral), offTrackSeconds = 0, trackLimitSeconds = 0, runoffSeconds = 0;
  let wasOff = false, wasLimit = false, wasStalled = false, lastDecisionAt = -stride * FIXED_DT;
  let spikeApplied = false;
  let expertRows = 0, expertBlock = -1, blockExpert = false, guardUntil = -1, mixSeed = (settings.seed ^ 0x50314) >>> 0;
  let previousLap = self.race.lap, crossings = 0;
  const fullLaps = [];
  const encounters = new Map(), seenContacts = new Map(), rivalStats = new Map();
  let selfSevere = 0;
  // Generated fields classify a rival as a hazard beyond the kerb's outer edge:
  // Harbor's hairpin racing line legally runs at +8.9 m on the kerb.
  const offRoad = settings.fixture === 'field' ? track.halfWidth + (track.curbWidth ?? 0) + .5 : track.halfWidth + .8;
  const preStepDamage = new Map();
  const originalStewards = race.stewards.step.bind(race.stewards);
  race.stewards.step = dt => {
    for (const pair of race.stewards.pairs) {
      const [a, b, closing] = pair, key = [a, b].sort().join(':');
      if (race.time - (seenContacts.get(key) ?? -99) > .2) events.push({ time: race.time - startAt, type: 'contact', a, b, closing });
      seenContacts.set(key, race.time);
      if ((a === self.id || b === self.id) && closing > 6) selfSevere++;
      if (current && (a === self.id || b === self.id)) {
        const other = race.cars.find(car => car.id === (a === self.id ? b : a));
        const otherEntry = race.entries.find(entry => entry.car.id === other.id);
        const dx = other.x - self.x, dz = other.z - self.z;
        (current.contactEvidence ??= []).push({ time: race.time - startAt, rival: other.id, closing,
          activeRival: !otherEntry.pit && !otherEntry.pitPlan && !otherEntry.retired && !other.ghost && other.race.finishTime === null,
          forward: dx * Math.sin(self.yaw) + dz * Math.cos(self.yaw), lateral: dx * Math.cos(self.yaw) - dz * Math.sin(self.yaw),
          yawDifference: angle(other.yaw - self.yaw), selfDamageAdded: Math.max(0, self.damage - preStepDamage.get(self.id)),
          rivalDamageAdded: Math.max(0, other.damage - preStepDamage.get(other.id)) });
      }
    }
    originalStewards(dt);
  };
  const initializationMs = performance.now() - initializationStart, wallStart = performance.now(); armed = true;
  if (settings.planFactory) planExecutor = settings.planFactory(track, self);
  for (tick = 0; tick < iterations && race.phase === 'racing'; tick++) {
    const time = race.time - startAt;
    const stalled = settings.mode !== 'teacher' && time + 1e-9 >= settings.stallAt && time + 1e-9 < settings.stallAt + settings.stallMs / 1000;
    const frameReply = seatTiming?.advance(tick, time, { blocked: stalled });
    if (frameReply) {
      const accepted = mailbox.accept(frameReply, time);
      if (accepted) { acceptedAt = time; if (settings.fastMotor) trafficCorrection = frameReply.correction; }
      events.push({ time, type: accepted ? 'reply-accepted' : 'reply-rejected', seq: frameReply.seq,
        base: frameReply.base, frame: seatTiming.frame, age: time - frameReply.at });
    }
    if (motorPending && motorPending.due <= time + 1e-9) { motorAction = motorPending.action; motorAcceptedAt = motorPending.at; motorPending = null; }
    if (stopHazard && time >= settings.hazardAt) { stopHazard(); stopHazard = null; }
    for (const h of fieldHazards) if (!h.done && time >= h.stopAt) fieldStop(h);
    for (let i = delayed.length - 1; i >= 0; i--) if (delayed[i].due <= time + 1e-9) {
      const packet = delayed.splice(i, 1)[0], accepted = mailbox.accept(packet.reply, time);
      if (accepted) { acceptedAt = time; if (settings.fastMotor) trafficCorrection = packet.reply.correction; }
      events.push({ time, type: accepted ? 'reply-accepted' : 'reply-rejected', seq: packet.reply.seq, age: time - packet.reply.at });
    }
    if (planExecutor) planExecutor.commit(mailbox.action, mailbox.accepted, mailbox.at);
    if (settings.fastMotor && tick % motorStride === 0) {
      const observation = observeAt(race, self, { dt: motorStride * FIXED_DT, previous,
        actionAge: Math.max(0, time - lastMotorRequestAt) });
      const t = performance.now(), action = settings.motor(observation.normalized);
      motorMs.push(performance.now() - t);
      if (action?.length !== 2 || !action.every(Number.isFinite)) throw Error('Invalid local learned-motor action');
      // Preserve the native actor's one-physics-tick delivery, independent of
      // traffic reply rate/delay. This is learned dense inference, not an
      // expert or geometric fallback. Actual browser scheduling is a later gate.
      motorPending = { due: time + FIXED_DT, at: time, action: [...action] }; lastMotorRequestAt = time;
    }
    if (seatTiming ? seatTiming.atFrameBoundary : tick % stride === 0) {
      if (stalled !== wasStalled) events.push({ time, type: stalled ? 'inference-stall' : 'inference-resumed', duration: settings.stallMs / 1000 });
      wasStalled = stalled;
      const decisionDt = time - lastDecisionAt;
      // Hidden state belongs to the last accepted observation, not the last
      // request. Overlapping delayed requests may have been rejected entirely.
      const recurrentDt = settings.mode === 'teacher' ? stride * FIXED_DT : Math.max(stride * FIXED_DT, time - mailbox.at);
      const t = performance.now();
      const observation = observeAt(race, self, { dt: seatTiming ? seatTiming.workerDt : recurrentDt,
        previous, actionAge: settings.mode === 'teacher' ? 0 : time - mailbox.at });
      encoderMs.push(performance.now() - t);
      current = { type: 'step', index: rows.length, time, reset: rows.length === 0, dt: seatTiming ? seatTiming.rowDuration : stride * FIXED_DT,
        legalTrackLimit: track.halfWidth + (track.curbWidth ?? 0) + (self.spec?.track ?? 1.72) / 2,
        observation, before: pose(self), cars: race.cars.map(pose), requested: null, teacherControls: null,
        executed: null, executedEnd: null, safety: [], substeps: [], actionAge: settings.mode === 'teacher' ? 0 : time - mailbox.at,
        hiddenNorm: Math.hypot(...mailbox.hidden), acceptedSequence: mailbox.accepted, decisionMs: 0, decisionDt, recurrentDt, inferenceStalled: stalled, post: null };
      if (seatTiming) Object.assign(current, { frame: seatTiming.frame, acceptedBefore: mailbox.accepted,
        workerDt: seatTiming.workerDt, inFlight: !!seatTiming.packet, request: null });
      if (settings.mode === 'dagger') {
        // Training-only expert bursts broaden the visited states. Policy evaluation
        // never reaches this branch and has no teacher steering fallback.
        const block = Math.floor((time + 1e-9) / (settings.expertBlockMs / 1000));
        if (block !== expertBlock) { expertBlock = block; mixSeed = (Math.imul(1664525, mixSeed) + 1013904223) >>> 0; blockExpert = mixSeed / 2 ** 32 < settings.expertMix; }
        const at = track.nearest(self.x, self.z), error = Math.abs(angle(self.yaw - at.heading));
        const sideSpeed = self.vx * at.nx + self.vz * at.nz;
        const outwardSpeed = Math.max(0, Math.sign(at.lateral) * sideSpeed);
        const wheelHalfTrack = (self.spec?.track ?? 1.72) / 2;
        // Legality permits one side of the car outside the kerb, where grip is
        // already much lower. Leave a footprint/response buffer for collection,
        // rather than waiting for the centre to break the official limit.
        const gripCenterLimit = track.halfWidth + (track.curbWidth ?? 0) - wheelHalfTrack;
        const edgeMargin = Math.max(2 * wheelHalfTrack + .3, wheelHalfTrack + .3 + outwardSpeed * .5);
        current.expertGuard = { legalTrackLimit: current.legalTrackLimit, gripCenterLimit, edgeMargin, outwardSpeed, headingError: error };
        // The fastest line legitimately uses the kerb. Intervening at asphalt
        // width minus 2 m makes the expert take over ordinary line-following,
        // and prevents learning the physically useful edge corrections.
        if (Math.abs(at.lateral) > current.legalTrackLimit - edgeMargin || error > .3 || self.damage > .02) guardUntil = time + .5;
        current.expertChosen = blockExpert || time < guardUntil;
        current.expertReason = time < guardUntil ? 'training-recovery' : blockExpert ? 'seeded-mixture' : null;
        if (current.expertChosen) expertRows++;
      }
      if (settings.policy && !stalled && (!seatTiming || seatTiming.canPost(time, stride * FIXED_DT))) {
        lastDecisionAt = time;
        const request = mailbox.request(time);
        planExecutor?.request(request.seq, time, self);
        const t = performance.now(), result = await settings.policy(observation.normalized, request.hidden,
          { time, dt: seatTiming ? seatTiming.workerDt : recurrentDt, seq: request.seq, base: request.base,
            progress: self.race.progress, speed: self.speed, x: self.x, z: self.z });
        current.decisionMs = performance.now() - t; inferenceMs.push(current.decisionMs);
        if (planExecutor) current.planProposal = result.action;
        else current.policyProposal = result.action;
        const reply = { ...request, action: result.action, hidden: result.hidden };
        if (settings.fastMotor) {
          const base = settings.motor(observation.normalized);
          const g = schema.groups.rivals, hasRival = Array.from({ length: g.count }, (_, i) => observation.normalized[g.offset + i * g.width]).some(Boolean);
          // Use the committed model's actual actuator delta. Clipped network
          // outputs stay clipped; empty traffic contributes exactly zero.
          reply.correction = hasRival ? result.action.map((value, i) => value - base[i]) : [0, 0];
        }
        const spike = seatTiming ? (!spikeApplied && time + 1e-9 >= settings.spikeAt ? settings.spikeMs : 0) :
          Math.abs(time - settings.spikeAt) < stride * FIXED_DT * .5 ? settings.spikeMs : 0;
        if (spike) spikeApplied = true;
        // Wall service time is included in this simulated arrival, not called zero latency.
        const delay = (settings.lagMs + spike + (seatTiming && settings.replyServiceMs !== null ? settings.replyServiceMs : current.decisionMs)) / 1000;
        if (seatTiming) {
          const sent = seatTiming.post(reply, time, delay);
          current.request = { epoch: request.epoch, seq: request.seq, base: request.base, at: time, ...sent };
          if (Math.abs(sent.dt - current.workerDt) > 1e-9) throw Error('Encoded and dispatched worker dt differ');
        } else delayed.push({ due: time + delay, reply });
        if (spike) events.push({ time, type: 'latency-spike', delay });
      }
      if (settings.mode === 'shadow') {
        const safe = supervise(current.policyProposal ?? mailbox.action, race, self); current.safety = safe.reasons; current.shadowSent = safe.controls;
      }
    }
    for (const car of race.cars) preStepDamage.set(car.id, car.damage);
    race.step(FIXED_DT);
    minSpeed = Math.min(minSpeed, self.speed); maxRoadOffset = Math.max(maxRoadOffset, Math.abs(self.lateral));
    const off = Math.abs(self.lateral) > track.halfWidth;
    if (off) offTrackSeconds += FIXED_DT;
    if (off !== wasOff) events.push({ time, type: off ? 'off-track' : 'rejoined', lateral: self.lateral, speed: self.speed });
    wasOff = off;
    const outsideLimits = !race.entries[0].pit && !halfCarInside(Math.abs(self.lateral) - (self.spec?.track ?? 1.72) / 2, track.halfWidth + (track.curbWidth ?? 0));
    if (outsideLimits) trackLimitSeconds += FIXED_DT;
    if (Math.abs(self.lateral) >= track.halfWidth + (track.curbWidth ?? 0)) runoffSeconds += FIXED_DT;
    if (outsideLimits !== wasLimit) events.push({ time, type: outsideLimits ? 'track-limit-violation' : 'inside-track-limits', lateral: self.lateral, speed: self.speed });
    wasLimit = outsideLimits;
    if (race.cars.some(c => c.fuel < .5)) throw Error('Fuel watchdog: no-pit episode exceeded its fuel window; result invalid');
    if (current) {
      const executed = { ...self.controls };
      current.executed ??= executed; current.executedEnd = executed; current.substeps.push({ dt: FIXED_DT, controls: executed });
      cumulativeDamage += Math.max(0, self.damage - lastDamage); lastDamage = self.damage;
      if (self.race.lap > previousLap) {
        const lap = { time: race.time - startAt, type: 'lap', lap: previousLap, seconds: self.race.lastLap,
          full: crossings > 0, valid: ['purple', 'green', 'yellow'].includes(self.race.lastState) };
        if (lap.full) fullLaps.push(lap);
        events.push(lap); crossings++; previousLap = self.race.lap;
      }
      const damageAdded = Math.max(0, self.damage - (current.substepDamage ?? current.before.damage));
      current.substepDamage = self.damage;
      if (damageAdded > .001) events.push({ time, type: 'damage', added: damageAdded, total: cumulativeDamage, speed: self.speed });
      for (let i = 1; i < count; i++) {
        const o = race.cars[i], r = rivalStats.get(i) ?? { id: o.id, maxLateral: 0, minSpeed: Infinity, departures: [], damage: 0 };
        rivalStats.set(i, r); r.maxLateral = Math.max(r.maxLateral, Math.abs(o.lateral)); r.damage = o.damage;
        if (time > 2) r.minSpeed = Math.min(r.minSpeed, o.speed);
        const out = o.speed < 7 || Math.abs(o.lateral) > offRoad;
        if (out && !r.out) r.departures.push({ time: Math.round(time * 10) / 10, s: Math.round(o.s), gapToSelf: Math.round(gap(o.s, self.s, track.length)) });
        r.out = out;
      }
      for (let i = 1; i < count; i++) {
        const other = race.cars[i], ds = gap(other.s, self.s, track.length);
        let e = encounters.get(i);
        const entry = race.entries[i], nonRacing = !!entry.pit || !!entry.pitPlan || !!entry.retired || other.ghost || other.race.finishTime !== null;
        const kind = other.speed < 7 || Math.abs(other.lateral) > offRoad ? 'hazard' :
          other.classId !== self.classId ? 'traffic' : Math.abs(other.race.progress - self.race.progress) > track.length * .5 ? 'lapping' : 'race';
        if (!e && !nonRacing && ds > 0 && ds < 120) { e = { id: other.id, kind, start: time, initialOffset: self.lateral, overlap: null, clear: null, retained: null, damage0: cumulativeDamage }; encounters.set(i, e); }
        if (!e || e.retained !== null) continue;
        if (nonRacing || e.invalidated || self.ghost) { e.invalidated = 'pit/finished/retired/rescue'; continue; }
        if (kind === 'hazard') e.kind = 'hazard';
        const extent = c => { const psi = c.yaw - track.at(c.s).heading; return Math.abs(Math.cos(psi)) * 2.28 + Math.abs(Math.sin(psi)) * .98; };
        const bodyLength = extent(self) + extent(other);
        if (Math.abs(ds) < 4.56 && e.overlap === null) {
          e.overlap = time; e.sideSeparation = Math.abs(other.lateral - self.lateral); e.offsetChange = self.lateral - e.initialOffset;
          events.push({ time, type: 'overlap', id: other.id, separation: e.sideSeparation });
        }
        if (ds < -bodyLength - .15) {
          e.clear ??= time;
          if (time - e.clear >= 1) { e.retained = time; e.speed = self.speed; e.damage = cumulativeDamage - e.damage0;
            events.push({ time, type: e.kind === 'hazard' ? 'hazard-cleared' : 'retained-pass', id: other.id, speed: self.speed, contactContaminated: e.damage > 1e-8,
              kind: e.kind, maneuverEvidence: { offsetChange: e.offsetChange ?? 0, separation: e.sideSeparation ?? 0 } }); }
        } else e.clear = null;
      }
      if ((seatTiming ? seatTiming.closesRow : (tick + 1) % stride === 0) || tick + 1 === iterations) {
        if (seatTiming) current.dt = current.substeps.length * FIXED_DT;
        const policyDriven = settings.mode === 'policy' || (settings.mode === 'dagger' && !current.expertChosen);
        current.requested = planExecutor ? toAction(current.executed)
          : policyDriven ? (settings.fastMotor ? combinedAction() : [...mailbox.action]) : toAction(current.teacherControls ?? current.executed);
        if (planExecutor) current.heldPlan = [...mailbox.action];
        if (settings.fastMotor) { current.localMotorAction = [...motorAction]; current.trafficCorrection = [...trafficCorrection]; current.localMotorAt = motorAcceptedAt; current.localMotorRequestedAt = lastMotorRequestAt; }
        current.target = toAction(current.executed);
        current.post = pose(self); current.progressDelta = self.race.progress - current.before.progress;
        current.damageAdded = Math.max(0, self.damage - current.before.damage);
        current.actionSource = settings.trainingExpertActuator ? 'training-pedal-curriculum' : settings.diagnosticExpertActuator ? 'diagnostic-assisted-policy' :
          planExecutor ? 'pulse-plan-policy' : policyDriven ? settings.fastMotor ? 'pulse-two-rate-policy' : 'pulse-policy' : settings.disturbanceSteer || settings.disturbanceLongitudinal ? 'training-disturbed-expert' : settings.mode === 'dagger' ? 'training-expert' : settings.expertDriver + '-teacher';
        current.acceptedSequence = mailbox.accepted; current.acceptedAt = acceptedAt;
        if (current.safety.length) interventionRows++;
        if (current.observation.clipped.length) clippedRows++;
        if (current.observation.missing.length) missingRows++;
        if (current.target[1] !== 0 && current.executed.throttle > .01 && current.executed.brake > .01) simultaneous++;
        settings.onRow?.(current);
        rows.push(current);
        previous = [...current.requested];
      }
    }
    if (![self.x, self.z, self.speed, self.yaw].every(Number.isFinite)) throw Error('Non-finite physics state');
  }
  const wallSeconds = (performance.now() - wallStart) / 1000;
  for (const e of race.entries) for (const bridge of e.bridges) if (bridge.errors) throw Error(`Teacher bridge error: ${bridge.lastError}`);
  const summary = { mode: settings.mode, fixture: settings.fixture, track: settings.track, classId: settings.classId,
    seed: settings.seed, seconds: tick * FIXED_DT, phase: race.phase, dq: !!self.race.dq, endedEarly: tick < iterations,
    wallSeconds, initializationMs, warmupSeconds, simSecondsPerWallSecond: tick * FIXED_DT / wallSeconds, minSpeed, maxRoadOffset,
    offTrackSeconds, asphaltEdgeSeconds: offTrackSeconds, trackLimitSeconds, runoffSeconds,
    trackLimitDefinition: 'Game halfCarInside wheel/kerb rule; offTrackSeconds is the legacy asphalt-centre edge diagnostic.',
    gameOfftrack: self.race.offtrack, incidents: race.stewards.of(race.entries[0]).inc,
    gameBestLapIncludingInitialPartial: self.race.bestLap, fullLaps,
    bestFullLap: fullLaps.filter(l => l.valid).reduce((best, l) => best === null ? l.seconds : Math.min(best, l.seconds), null),
    rows: rows.length, progress: self.race.progress - startProgress, minFuel: Math.min(...race.cars.map(c => c.fuel)), fuelUsed: beforeFuel - self.fuel,
    cumulativeDamage, endDamage: self.damage, initialDamage: beforeDamage, contacts: race.contacts, severe: race.collisionStats.severeContacts,
    retainedPasses: [...encounters.values()].filter(e => e.retained !== null && e.kind !== 'hazard').length,
    hazardsCleared: [...encounters.values()].filter(e => e.retained !== null && e.kind === 'hazard').length, encounters: [...encounters.values()],
    rivals: [...rivalStats.values()].map(({ out, ...r }) => r),
    // Slower-class cars still racing at the end and not behind PULSE by a car length.
    selfSevere, encountersCleared: [...encounters.values()].filter(e => e.retained !== null).length,
    unpassedTraffic: race.cars.slice(1).filter(o => o.classId !== self.classId && o.speed >= 7
      && Math.abs(o.lateral) <= offRoad && o.race.progress > self.race.progress - 5.5).length,
    interventionRows, expertRows, expertActuatorRows: settings.diagnosticExpertActuator || settings.trainingExpertActuator ? rows.length : 0,
    clippedRows, missingRows, simultaneousPedalRows: simultaneous, mailbox: mailbox.stats,
    ...(seatTiming ? { seatTiming: { ...seatTiming.stats, transport: settings.transport,
      frameSteps: settings.frameSteps, lagFrames: settings.lagFrames, lagJitter: settings.lagJitter, frameJitter: settings.frameJitter,
      scheduleSeed: settings.scheduleSeed, replyServiceMs: settings.replyServiceMs,
      inferenceService: settings.replyServiceMs === null ? 'Measured CPU inference time, delivered at a later frame boundary.' : 'Explicit simulated service time; measured CPU cost is reported separately.',
      requestIntervalsMs: timing(seatTiming.intervals.map(x => x * 1000)), replyAgesMs: timing(seatTiming.replyAges.map(x => x * 1000)),
      scope: 'Emulated single-in-flight frame transport. Neither a real browser Worker test nor a frame-overrun certification.' } } : {}),
    latencyMs: { observation: timing(encoderMs), teacher: timing(teacherMs), inference: timing(inferenceMs), safety: timing(supervisorMs) },
    localMotor: { enabled: settings.fastMotor, rate: settings.fastMotor ? settings.motorRate : null, latencyMs: timing(motorMs),
      scope: 'Optional synchronous learned motor; delayed traffic delta and hidden state commit together. Local physics cadence; browser scheduling remains unverified.' },
    ...(planExecutor ? { planExecution: { contract: PLAN_CONTRACT.version, compiles: planExecutor.compiles,
      compileLatencyMs: timing(planExecutor.compileMs), scope: 'NN lane/pace intentions with live geometric feedback at physics cadence; no expert combat planner. Browser execution unverified.' } } : {}),
    paceScope: 'Placed fixtures begin partway through a lap. The initial crossing is excluded from fullLaps and bestFullLap.',
    scope: settings.diagnosticExpertActuator ? `Diagnostic only: expert replaces ${settings.diagnosticExpertActuator}. This is assisted driving, never a PULSE gate.` :
      settings.trainingExpertActuator ? 'Training only: expert pedals with learned steering and bounded expert recovery. Autonomous gates must remove all assistance.' :
      settings.disturbanceSteer || settings.disturbanceLongitudinal ? 'Training only: perturbed expert execution; teacherControls label the disturbed physical states. No PULSE performance claim.' :
      settings.mode === 'dagger' ? 'Training only: seeded INTERCEPT/PULSE mixture with expert recovery. No independent PULSE performance claim.' :
      settings.mode === 'shadow' ? 'INTERCEPT drives. PULSE predictions are counterfactual, not racing results.' :
      settings.mode === 'policy' ? 'Experimental PULSE drives; INTERCEPT labels its states and supplies the unchanged strategy. Native CPU inference.' : settings.expertDriver + ' demonstration. No PULSE policy driving.' };
  const outline = Array.from({ length: 320 }, (_, i) => { const p = track.at(i / 320 * track.length); return { x: p.x, z: p.z, s: p.s }; });
  for (const e of race.entries) for (const bridge of e.bridges) bridge.dispose?.();
  return { summary, rows, events, track: { id: track.id, length: track.length, halfWidth: track.halfWidth, curbWidth: track.curbWidth, outline }, schema };
}
