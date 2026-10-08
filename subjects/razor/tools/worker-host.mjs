// Node transport for the actual game seat-worker. The paired control changes
// only the focal RAZOR's attack option; its driving and traffic logic still run.
import { parentPort, workerData } from 'node:worker_threads';
import { RazorDriver } from '../src/driver.js';

// Test-only overrides, applied after class/track calibration. Production
// seat-workers never receive these options.
if (workerData.options) {
  const prepare = RazorDriver.prototype.prepare;
  RazorDriver.prototype.prepare = function (...args) {
    prepare.apply(this, args);
    Object.assign(this.options, workerData.options);
  };
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
