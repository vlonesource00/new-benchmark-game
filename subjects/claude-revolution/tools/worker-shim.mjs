// Gives Node a browser-like `Worker` so AsyncSeats runs every AI in its own thread, as the game does.
import { Worker as Thread } from 'node:worker_threads';
globalThis.Worker = class {
  constructor(target) {
    this.thread = new Thread(new URL('./seat-host.mjs', import.meta.url), { workerData: { target: target.href } });
    this.thread.on('message', (data) => { if (!this.closed) this.onmessage?.({ data }); });
    this.thread.on('error', (e) => this.onerror?.({ message: String(e), preventDefault() {} }));
  }
  postMessage(d) { this.thread.postMessage(d); }
  terminate() { this.closed = true; return this.thread.terminate(); }
};
