// Node stand-in for the browser's module worker: runs the game's seat worker in a worker thread.
import { parentPort, workerData } from 'node:worker_threads';
const queued = []; let loaded = false;
globalThis.self = { postMessage: (value) => parentPort.postMessage(value) };
parentPort.on('message', (data) => (loaded ? self.onmessage({ data }) : queued.push(data)));
await import(workerData.target); loaded = true;
for (const data of queued) self.onmessage({ data });
