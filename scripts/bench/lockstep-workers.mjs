// Node stand-in for the browser's module Worker, for benches that drive the race through the game's real seat path
// (game/core/async-seats.js posting to game/core/seat-worker.js, both unmodified). Each worker is its own instance of
// the seat-worker module; messages are structured-cloned both ways like postMessage. The worker computes as soon as a
// message is posted (it only ever sees what was posted), and its reply is held to a frame boundary: the browser hands
// a reply to the page between frames, never in the middle of one. Deterministic: latency is counted in frames, not
// measured on the wall clock.
//   frameSteps  physics steps per rendered frame (2: FIXED_DT 1/120 s at 60 fps)
//   lagFrames   whole frames a reply waits beyond the next boundary (a planner slower than one frame)
//   lagJitter   up to this many more frames per reply, drawn per reply (a planner whose time varies)
//   frameJitter chance that a frame runs one physics step longer (a late or dropped frame)
// The draws come from a seeded generator, so a run is still repeatable.
export function installWorkerShim({ frameSteps = 2, lagFrames = 0, lagJitter = 0, frameJitter = 0, seed = 1 } = {}) {
  const queue = [], workers = [];
  let frame = 0, steps = 0, chain = Promise.resolve(), n = 0, len = frameSteps, rs = seed >>> 0;
  const rnd = () => { rs = (rs + 0x6d2b79f5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const extra = () => (lagJitter > 0 ? Math.floor(rnd() * (lagJitter + 1)) : 0);
  const run = (w, data) => { const prev = globalThis.self; globalThis.self = w.scope; try { w.scope.onmessage?.({ data: structuredClone(data) }); } finally { globalThis.self = prev; } };
  class ShimWorker {
    constructor(url) {
      this.scope = { postMessage: (data) => queue.push({ to: this, data: structuredClone(data), due: frame + 1 + lagFrames + extra() }) };
      this.pending = []; this.loaded = false; workers.push(this);
      // one import at a time: the module binds `self.onmessage` while it evaluates
      chain = chain.then(async () => {
        globalThis.self = this.scope;
        await import(`${url.href}${url.href.includes('?') ? '&' : '?'}seat=${++n}`);
        this.loaded = true;
        for (const d of this.pending.splice(0)) run(this, d);
      });
    }
    postMessage(data) { if (this.loaded) run(this, data); else this.pending.push(structuredClone(data)); }
    terminate() { this.scope.onmessage = null; }
  }
  globalThis.Worker = ShimWorker;
  const deliver = () => {
    for (let q = 0; q < queue.length;) {
      if (queue[q].due > frame) { q++; continue; }
      const m = queue.splice(q, 1)[0]; m.to.onmessage?.({ data: m.data });
    }
  };
  return {
    workers,
    /** Call after every race.step: closes the frame every `frameSteps` steps and hands out the replies due. */
    step() { if (++steps >= len) { steps = 0; len = frameSteps + (frameJitter > 0 && rnd() < frameJitter ? 1 : 0); frame++; deliver(); } },
    /** Before the race runs: finish loading the workers and deliver everything they answered. */
    async settle() { await chain; frame += 1 + lagFrames; deliver(); },
    frameSteps, lagFrames, lagJitter, frameJitter
  };
}
