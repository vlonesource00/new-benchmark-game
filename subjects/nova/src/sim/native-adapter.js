// Native host adapter
// Converts the Astra-derived plant into the DeepSeek observation shape and
// applies DeepSeek commands back to the vehicle. This is the only place where
// the AI touches the native sim objects; the shared benchmark will provide an
// equivalent adapter for its own host.

import { CAR_HALF_WIDTH, CAR_HALF_LENGTH } from '../core/rules.js';

// Causal state tracking across ticks for finite-difference fallbacks
const prevCarMotion = new Map();

function getTrackFrame(c, context) {
  // 1. Session nearest projection if available
  const proj = context?.projections?.get ? context.projections.get(c.id) : null;
  if (proj && Number.isFinite(proj.nx) && Number.isFinite(proj.nz) && Number.isFinite(proj.tx) && Number.isFinite(proj.tz)) {
    return { nx: proj.nx, nz: proj.nz, tx: proj.tx, tz: proj.tz };
  }

  // 2. TrackModel if available
  const tm = context?.trackModel ?? context?.model;
  if (tm && tm.nx && tm.nz && tm.tx && tm.tz) {
    const idx = typeof tm.index === 'function' ? tm.index(c.s ?? 0) : 0;
    return { nx: tm.nx[idx], nz: tm.nz[idx], tx: tm.tx[idx], tz: tm.tz[idx] };
  }

  // 3. Track.at() or Track.nearest()
  const track = context?.track ?? c?.track;
  if (track && typeof track.at === 'function') {
    const p = track.at(c.s ?? 0);
    if (p && Number.isFinite(p.nx)) {
      return { nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz };
    }
  }

  return null;
}

function computeVehicleMotion(c, context, dt) {
  const frame = getTrackFrame(c, context);
  let dq = 0;
  let ds_dt = Number.isFinite(c.speed) ? c.speed : 0;

  if (frame && Number.isFinite(c.vx) && Number.isFinite(c.vz)) {
    // dq = vx * nx + vz * nz (lateral velocity along track normal)
    dq = c.vx * frame.nx + c.vz * frame.nz;
    // ds_dt = vx * tx + vz * tz (longitudinal velocity along track tangent)
    ds_dt = c.vx * frame.tx + c.vz * frame.tz;
  } else if (Number.isFinite(c.dq) && c.dq !== 0) {
    dq = c.dq;
    ds_dt = Number.isFinite(c.dv) ? (c.speed + c.dv) : c.speed;
  } else {
    // Causal finite-difference fallback
    const prev = prevCarMotion.get(c.id);
    const currentTime = context?.time ?? 0;
    if (prev && dt > 1e-4 && currentTime > prev.time) {
      const dtEff = Math.max(1e-4, currentTime - prev.time);
      dq = ((c.lateral ?? c.q ?? 0) - prev.q) / dtEff;
      ds_dt = ((c.s ?? 0) - prev.s) / dtEff;
    }
  }

  prevCarMotion.set(c.id, {
    q: c.lateral ?? c.q ?? 0,
    s: c.s ?? 0,
    time: context?.time ?? 0
  });

  return { dq, ds_dt };
}

export function observeVehicle(car, cars, context, dt) {
  const rivals = [];
  for (const c of cars) {
    if (c === car) continue;
    const motion = computeVehicleMotion(c, context, dt);
    rivals.push({
      id: c.id, name: c.name,
      x: c.x, z: c.z, yaw: c.yaw,
      vx: c.vx, vz: c.vz, speed: c.speed,
      longitudinalVelocity: motion.ds_dt,
      lateralVelocity: motion.dq,
      dq: motion.dq,
      dv: motion.ds_dt - (c.speed ?? 0),
      qDot: motion.dq,
      sDot: motion.ds_dt,
      s: c.s, q: c.lateral ?? c.q ?? 0,
      halfWidth: CAR_HALF_WIDTH, halfLength: CAR_HALF_LENGTH,
      progress: c.race?.progress ?? 0,
      lap: c.race?.lap ?? 1,
      finished: c.race?.finishTime !== null,
      finishTime: c.race?.finishTime ?? null,
      raceActive: c.race?.finishTime === null,
      offtrack: c.offtrack ?? c.race?.offtrack ?? 0,
    });
  }

  const egoMotion = computeVehicleMotion(car, context, dt);

  return {
    time: context?.time ?? 0,
    dt,
    ego: {
      id: car.id,
      x: car.x, z: car.z, yaw: car.yaw,
      vx: car.vx, vz: car.vz, speed: car.speed,
      longitudinalVelocity: egoMotion.ds_dt,
      lateralVelocity: egoMotion.dq,
      dq: egoMotion.dq,
      qDot: egoMotion.dq,
      sDot: egoMotion.ds_dt,
      u: car.u, v: car.v,
      s: car.s, q: car.lateral ?? car.q ?? 0, zone: car.zone,
      yawRate: car.yawRate, steer: car.steering,
      ax: car.ax, ay: car.ay,
      gear: car.gear, rpm: car.rpm,
      throttle: car.controls.throttle, brake: car.controls.brake,
      wheels: car.wheels.map((w) => {
        const t = w.tyre;
        const tyreObj = {
          core: t?.core ?? 68,
          surface: t?.surface ?? 68,
          wear: t?.wear ?? 0,
          pressure: t?.pressure ?? 2.0,
          kappa: t?.kappa ?? 0,
          slipRatio: t?.kappa ?? 0,
          alpha: t?.alpha ?? 0,
          slipAngle: t?.alpha ?? 0,
          fx: t?.fx ?? 0,
          Fx: t?.fx ?? 0,
          fy: t?.fy ?? 0,
          Fy: t?.fy ?? 0,
          slipPower: t?.slipPower ?? 0,
          load: w?.load ?? 0,
        };
        return {
          ...tyreObj,
          tyre: tyreObj,
        };
      }),
      tyres: car.wheels.map((w) => {
        const t = w.tyre;
        return {
          core: t?.core ?? 68,
          surface: t?.surface ?? 68,
          wear: t?.wear ?? 0,
          pressure: t?.pressure ?? 2.0,
          kappa: t?.kappa ?? 0,
          slipRatio: t?.kappa ?? 0,
          alpha: t?.alpha ?? 0,
          slipAngle: t?.alpha ?? 0,
          fx: t?.fx ?? 0,
          Fx: t?.fx ?? 0,
          fy: t?.fy ?? 0,
          Fy: t?.fy ?? 0,
          slipPower: t?.slipPower ?? 0,
          load: w?.load ?? 0,
        };
      }),
      spec: car.spec,
    },
    rivals,
    race: {
      lap: car.race?.lap ?? 1,
      laps: context?.totalLaps ?? 1,
      position: context?.position ?? 1,
      mode: context?.mode ?? 'race',
      paceObjective: context?.paceObjective ?? 'race',
    },
  };
}

export class NativeDriver {
  constructor(ai) {
    this.ai = ai;
    this.state = ai.state;
    // The shared lap-recorder schema expects an Astra-style driver surface
    // (a planner exposing the planned offset by station, plus targetSpeed and
    // safety). Present that surface here rather than change the trace format:
    // the recorder is a shared reference tool and its schema is fixed.
    this.planner = { plan: { at: (s) => ({ offset: ai.line.q[ai.model.index(s)] }) } };
  }
  get targetSpeed() { return this.ai.state.targetSpeed ?? null; }
  get safety() {
    return {
      reason: this.ai.state.supervisor ?? null,
      interventions: this.ai.supervisor?.interventions ?? null,
    };
  }
  reset() { this.ai.reset(); }
  update(car, cars, dt, context) {
    const ctx = context ? { ...context, trackModel: context.trackModel ?? this.ai?.model } : { trackModel: this.ai?.model };
    const obs = observeVehicle(car, cars, ctx, dt);
    const command = this.ai.step(obs);
    car.controls = {
      steer: command.steer,
      throttle: command.throttle,
      brake: command.brake,
      reverse: Boolean(command.reverse),
    };
    this.state = this.ai.state;
  }
}
