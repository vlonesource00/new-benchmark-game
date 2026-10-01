/**
 * Shared host-state boundary for the GPT Racing and Gemini Gauntlet stacks.
 *
 * Those two projects share a common `Circuit`/`Vehicle` lineage, so one adapter
 * serves both. It is pure ES module code with no renderer dependency, which
 * lets the browser sandbox and the headless Node race share it verbatim.
 *
 * ── Conventions ────────────────────────────────────────────────────────────
 * Astra host (source of truth)        GPT / Gemini shadow (what the AI expects)
 *   world X/Z, Y up                     world X/Z, Y up              (same)
 *   yaw = atan2(fwdX, fwdZ)             yaw = atan2(fwdX, fwdZ)      (same)
 *   body u = forward, v = right         localVelocity.z = forward
 *                                       localVelocity.x = right      (same sign)
 *   track normal = RIGHT                track normal = LEFT
 *   lateral > 0  = right of racing dir  lateral > 0  = left of racing dir
 *
 * Therefore every lateral offset crossing this boundary is negated. Getting the
 * sign wrong is silent: the AI simply attacks into the car it meant to avoid.
 */

const TAU = Math.PI * 2;

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
export const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
export const wrapAngle = (value) => {
  let wrapped = value % TAU;
  if (wrapped > Math.PI) wrapped -= TAU;
  if (wrapped < -Math.PI) wrapped += TAU;
  return wrapped;
};

const ZONE_MAP = Object.freeze({ asphalt: 'road', kerb: 'curb', gravel: 'runoff', grass: 'grass' });

/**
 * Wraps an Astra `Track` in the `Circuit` API that the GPT and Gemini stacks
 * both call. Every returned frame carries the field names and sign conventions
 * those projects' own track produces.
 */
export function createShadowTrack(hostTrack, { id = 'harbor-ring', sampleSpacing = 5 } = {}) {
  // Precomputed station table: the AI calls atDistance/scalarAtDistance
  // hundreds of times per decision, so avoid re-running the host binary search
  // with fresh object churn where a cached row will do.
  const stations = [];
  for (let s = 0; s < hostTrack.length; s += sampleSpacing) {
    const p = hostTrack.at(s);
    const tangent = { x: p.tx, z: p.tz };
    stations.push({
      s,
      x: p.x,
      y: 0,
      z: p.z,
      tangent,
      // Left of travel: the host normal is right-positive, so negate it.
      normal: { x: -tangent.z, z: tangent.x },
      curvature: p.curvature,
      index: p.index
    });
  }

  const halfWidth = hostTrack.halfWidth;
  const curbWidth = hostTrack.curbWidth ?? 1.25;

  const frameAt = (s) => {
    const p = hostTrack.at(s);
    const tangent = { x: p.tx, z: p.tz };
    const normal = { x: -p.tz, z: p.tx }; // left of travel
    const curvature = finite(p.curvature);
    return {
      x: p.x,
      y: 0,
      z: p.z,
      tangent,
      normal,
      normal3: { x: normal.x, y: 0, z: normal.z },
      grade: 0,
      bank: 0,
      curvature: Math.abs(curvature),
      turnSign: Math.sign(-curvature), // host: +curvature = right turn; shadow: +1 = left
      curbSide: 0,
      turnStrength: clamp(Math.abs(curvature) * 120, 0, 1),
      rubber: hostTrack.rubber[p.index * 13 + hostTrack.laneAt(0)] ?? 0,
      s: p.s,
      index: p.index,
      heading: p.heading,
      halfWidth,
      curbWidth
    };
  };

  const surfaceAt = (x, z) => {
    const surface = hostTrack.surface(x, z);
    const frame = frameAt(surface.s);
    return {
      ...frame,
      distance2: 0,
      lateral: -finite(surface.lateral), // host right-positive -> shadow left-positive
      t: 0,
      zone: ZONE_MAP[surface.zone] ?? 'road',
      grip: finite(surface.grip, 1),
      rubber: finite(surface.rubber, 0),
      height: 0,
      curbHeight: surface.zone === 'kerb' ? 0.045 : 0,
      roughness: surface.zone === 'kerb' ? 0.5 : 0,
      barrierDepth: 0,
      roadEdge: halfWidth,
      curbEdge: halfWidth + curbWidth,
      barrierEdge: hostTrack.barrierOffset ?? halfWidth + curbWidth + 13
    };
  };

  const planningLateralLimit = (_distance = 0, _side = 0, options = {}) => {
    const halfWidthM = finite(options.halfWidthM, 1.02);
    const safetyM = finite(options.safetyM, 0.16);
    return Math.max(0, halfWidth - halfWidthM - safetyM);
  };

  return {
    id,
    name: hostTrack.name,
    length: hostTrack.length,
    roadHalfWidth: halfWidth,
    curbWidth,
    runoffWidth: hostTrack.runoffWidth ?? 13,
    revision: 1,
    samples: stations.map((station) => ({
      s: station.s,
      curvature: Math.abs(station.curvature),
      turnSign: Math.sign(-station.curvature),
      x: station.x,
      z: station.z,
      index: station.index
    })),

    atDistance: (distance) => frameAt(distance),
    scalarAtDistance: (distance) => {
      const frame = frameAt(distance);
      return {
        s: frame.s,
        index: frame.index,
        t: 0,
        curvature: frame.curvature,
        turnSign: frame.turnSign,
        curbSide: frame.curbSide,
        turnStrength: frame.turnStrength,
        grade: 0,
        bank: 0
      };
    },
    closest: (x, z) => surfaceAt(x, z),
    surfaceAt,
    lateralPoint: (point, lateral = 0, lift = 0) => {
      const frame = frameAt(point?.s ?? hostTrack.nearest(point.x, point.z).s);
      return {
        x: frame.x + frame.normal.x * lateral,
        y: 0 + lift,
        z: frame.z + frame.normal.z * lateral
      };
    },
    planningLateralLimit,
    planningLateralLimitAtPoint: (_point, side = 0, options = {}) => planningLateralLimit(0, side, options),
    wrap: (distance) => ((distance % hostTrack.length) + hostTrack.length) % hostTrack.length,
    wrapS: (distance) => ((distance % hostTrack.length) + hostTrack.length) % hostTrack.length
  };
}

/**
 * Builds the mutable per-tick mirror of one Astra car in the shape the GPT and
 * Gemini stacks expect. `sync(hostCar, hostTrack, projection)` refreshes it in
 * place so no allocation churn happens at 120 Hz.
 */
export function createShadowVehicle(hostCar, hostTrack, id, { classKey = 'gt', spec = null, name = 'SHADOW' } = {}) {
  const shadow = {
    id,
    name,
    classKey,
    spec,
    player: false,
    finished: false,
    despawned: false,
    trafficGhost: false,
    cooldownTime: 0,
    distance: 0,
    speed: 0,
    yaw: 0,
    yawRate: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    localVelocity: { x: 0, z: 0 },
    localAcceleration: { x: 0, z: 0 },
    acceleration: { x: 0, z: 0 },
    surface: { lateral: 0, zone: 'road', grip: 1, s: 0, index: 0 },
    aero: { wakeStrength: 0, dragReduction: 0, frontDownforceLoss: 0, rearDownforceLoss: 0, wake: 0 },
    wheels: Array.from({ length: 4 }, () => ({ slipRatio: 0, slipAngle: 0, wear: 0, tyre: { wear: 0, core: 68 } })),
    collisionHalfLength: 2.3,
    collisionHalfWidth: 0.99,
    controls: { throttle: 0, brake: 0, steer: 0, handbrake: 0 },
    aiTarget: { x: 0, z: 0, lateral: 0 },
    aiTactical: null,
    // Optional hooks the controllers may call; no-ops keep the harness safe.
    marshalRecoverTo: () => {},
    setERSMode: () => {}
  };

  shadow.sync = (projection, wake = 0) => {
    const car = hostCar;
    const p = projection ?? hostTrack.nearest(car.x, car.z);
    shadow.position.x = car.x;
    shadow.position.y = 0;
    shadow.position.z = car.z;
    shadow.velocity.x = car.vx;
    shadow.velocity.z = car.vz;
    shadow.localVelocity.x = finite(car.v); // astra v = right-positive
    shadow.localVelocity.z = finite(car.u); // astra u = forward
    shadow.speed = Math.max(0, finite(car.speed));
    shadow.yaw = finite(car.yaw);
    shadow.yawRate = finite(car.yawRate);
    shadow.forward = { x: Math.sin(shadow.yaw), z: Math.cos(shadow.yaw) };
    shadow.right = { x: Math.cos(shadow.yaw), z: -Math.sin(shadow.yaw) };

    const aForward = finite(car.ax);
    const aRight = finite(car.ay);

    shadow.localAcceleration.x = aRight;
    shadow.localAcceleration.z = aForward;

    shadow.acceleration.x =
      shadow.right.x * aRight +
      shadow.forward.x * aForward;

    shadow.acceleration.z =
      shadow.right.z * aRight +
      shadow.forward.z * aForward;
    shadow.distance = finite(p.s);
    shadow.surface.lateral = -finite(p.lateral); // host right-positive -> shadow left-positive
    shadow.surface.zone = ZONE_MAP[p.zone ?? 'asphalt'] ?? 'road';
    shadow.surface.s = finite(p.s);
    shadow.surface.index = finite(p.index);
    shadow.surface.grip = 1;
    shadow.aero.wake = finite(wake);
    shadow.aero.wakeStrength = finite(wake);
    shadow.aero.dragReduction = finite(wake) * 0.38;
    shadow.aero.frontDownforceLoss = finite(wake) * 0.32;
    shadow.aero.rearDownforceLoss = finite(wake) * 0.24;
    shadow.finished = car.race?.finishTime != null;
    for (let i = 0; i < 4; i += 1) {
      const wheel = car.wheels[i];
      const tyre = wheel?.tyre;
      const target = shadow.wheels[i];
      const kappa = finite(tyre?.kappa ?? wheel?.slipRatio);
      const alpha = finite(tyre?.alpha ?? wheel?.slipAngle);
      const wear = finite(tyre?.wear);
      const core = finite(tyre?.core, 68);
      const surface = finite(tyre?.surface, 68);
      const pressure = finite(tyre?.pressure, 2.0);
      const load = finite(wheel?.load, 0);
      const fx = finite(tyre?.fx, 0);
      const fy = finite(tyre?.fy, 0);
      const slipPower = finite(tyre?.slipPower, 0);

      target.slipRatio = kappa;
      target.kappa = kappa;
      target.slipAngle = alpha;
      target.alpha = alpha;
      target.wear = wear;
      target.core = core;
      target.surface = surface;
      target.pressure = pressure;
      target.load = load;
      target.fx = fx;
      target.Fx = fx;
      target.fy = fy;
      target.Fy = fy;
      target.slipPower = slipPower;

      if (!target.tyre) target.tyre = {};
      target.tyre.wear = wear;
      target.tyre.core = core;
      target.tyre.surface = surface;
      target.tyre.pressure = pressure;
      target.tyre.kappa = kappa;
      target.tyre.slipRatio = kappa;
      target.tyre.alpha = alpha;
      target.tyre.slipAngle = alpha;
      target.tyre.fx = fx;
      target.tyre.Fx = fx;
      target.tyre.fy = fy;
      target.tyre.Fy = fy;
      target.tyre.slipPower = slipPower;
      target.tyre.load = load;
    }
    return shadow;
  };

  /**
   * Copies the controller's decision back onto the Astra host car. Both stacks
   * write a fresh `{throttle, brake, steer}` object with the same conventions
   * as Astra: +steer turns right, pedals in 0..1.
   */
  shadow.applyToHost = () => {
    const controls = shadow.controls ?? {};
    hostCar.controls = {
      throttle: clamp(finite(controls.throttle), 0, 1),
      brake: clamp(finite(controls.brake), 0, 1),
      steer: clamp(finite(controls.steer), -1, 1),
      reverse: Boolean(controls.reverse)
    };
  };

  return shadow;
}

/** Shared race object: both stacks only ever read `phase`. */
export const shadowRace = Object.freeze({ phase: 'racing', raceTime: 0, laps: 4, entries: new Map() });
