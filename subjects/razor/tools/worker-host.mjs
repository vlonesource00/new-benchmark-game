// Node transport for the actual game seat-worker. The paired control changes
// only the focal RAZOR's attack option; its driving and traffic logic still run.
import { parentPort, workerData } from 'node:worker_threads';
import { RazorDriver } from '../src/driver.js';
import { heldControlPose } from '../src/predict.js';

// Test-only overrides, applied after class/track calibration. Production
// seat-workers never receive these options.
if (workerData.options) {
  const prepare = RazorDriver.prototype.prepare;
  RazorDriver.prototype.prepare = function (...args) {
    prepare.apply(this, args);
    Object.assign(this.options, workerData.options);
  };
}

// Compare a consistent forecast across cadence transitions without changing
// the production driver's activation threshold.
if (workerData.options?.physicalAllCadences) {
  const predict = RazorDriver.prototype.predict;
  RazorDriver.prototype.predict = function (car, dt) {
    if (this.classId !== 'gt' || !(this.controlDelay > 0)) return predict.call(this, car, dt);
    this.delay = Math.max(0.008, Math.min(0.06, this.controlDelay + dt * 0.5));
    this.posePrediction = 'held controls'; this.lastR = car.yawRate; this.lastDt = dt;
    return this.controlPose = heldControlPose(car, this.track, this.delay);
  };
}

if (workerData.options?.geometryTrace) {
  const debug = RazorDriver.prototype.debug;
  RazorDriver.prototype.debug = function (...args) {
    const out = debug.apply(this, args), car = this.lastCar, path = this.path ?? this.line;
    if (!car || !path) return out;
    const q = path.closest(car.x, car.z, this.cursor);
    const x = path.sample(path.px, q.i, q.f), z = path.sample(path.pz, q.i, q.f);
    out.pathGeometry = { i: q.i, observedE: q.e, pathLat: this.track.nearest(x, z).lateral,
      observedLat: car.lateral, yaw: car.yaw, pathHeading: path.heading(q.i, q.f),
      curvature: path.sample(path.ks, q.i, q.f), profile: path.sample(path.vbrk, q.i, q.f),
      age: this.controlDelay, prediction: this.delay, grip: this.model.grip };
    return out;
  };
}

if (workerData.options?.departureDelay > 0 || workerData.options?.projectedGuard || workerData.options?.retainClearance || workerData.options?.timedGuard) {
  const { installDepartureExperiment } = await import('./departure-experiment.mjs');
  installDepartureExperiment();
}
if (workerData.attacks === false) {
  const update = RazorDriver.prototype.update;
  RazorDriver.prototype.update = function (...args) {
    this.options.attacks = false;
    return update.apply(this, args);
  };
}
const queued = [];
let loaded = false;
globalThis.self = { postMessage: value => parentPort.postMessage(value) };
parentPort.on('message', data => loaded ? self.onmessage({ data }) : queued.push(data));
await import(workerData.target);
loaded = true;
for (const data of queued) self.onmessage({ data });
