// Node adapter for exercising the game's actual browser worker module.
import { parentPort,workerData } from 'node:worker_threads';
const queued=[];let loaded=false;
globalThis.self={postMessage:value=>parentPort.postMessage(value)};
parentPort.on('message',data=>loaded?self.onmessage({data}):queued.push(data));
await import(workerData.target);loaded=true;
for(const data of queued)self.onmessage({data});
