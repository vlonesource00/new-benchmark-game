// Measurement adapter only. Runs the unchanged browser seat module in a real
// Node worker thread; no synchronous lockstep stand-in or simulated IPC time.
import { parentPort, workerData } from 'node:worker_threads';
import { CounterpointDriver } from '../src/driver.js';
const overrides = workerData?.options ?? {};
if (Object.keys(overrides).length) {
  const prepare = CounterpointDriver.prototype.prepare;
  CounterpointDriver.prototype.prepare = function(car) {
    if (!this.prepared || this.classId !== car.classId) this.settings = { ...this.settings, ...overrides };
    return prepare.call(this, car);
  };
}
let started = 0;
globalThis.self = {
  postMessage(data) { parentPort.postMessage({ ...data, measuredWorkerMs: performance.now() - started }); }
};
await import('../../../game/core/seat-worker.js');
parentPort.on('message', data => {
  started = performance.now();
  self.onmessage({ data });
});
