// Deterministic emulation of the game's single-in-flight seat transport.
// Physics can make several steps inside a rendered frame; worker messages
// become visible only between frames. This is not a browser Worker test.
const randomStream = seed => {
  let state = seed >>> 0;
  return maximum => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 2 ** 32 * (maximum + 1));
  };
};

export class SeatTiming {
  constructor({ step = 1 / 120, frameSteps = 2, lagFrames = 0, lagJitter = 0, frameJitter = 0, scheduleSeed = 7 } = {}) {
    if (!(Number.isFinite(step) && step > 0 && step <= .1)) throw Error('Invalid physics step');
    for (const [key, value, minimum] of [['frameSteps', frameSteps, 1], ['lagFrames', lagFrames, 0],
      ['lagJitter', lagJitter, 0], ['frameJitter', frameJitter, 0]])
      if (!Number.isInteger(value) || value < minimum || value > 12) throw Error('Invalid seat timing ' + key);
    if (!Number.isInteger(scheduleSeed) || scheduleSeed < 0 || scheduleSeed > 0xffffffff) throw Error('Invalid schedule seed');
    Object.assign(this, { step, frameSteps, lagFrames, lagJitter, frameJitter, scheduleSeed });
    this.reset();
  }

  reset() {
    this.frameRandom = randomStream(this.scheduleSeed ^ 0x5046524d);
    this.replyRandom = randomStream(this.scheduleSeed ^ 0x5052504c);
    this.tick = -1; this.frame = -1; this.nextTick = 0; this.frameLength = 0;
    this.atFrameBoundary = false; this.pendingDt = 0; this.packet = null;
    this.lastPostAt = -Infinity; this.intervals = []; this.replyAges = [];
    this.stats = { frames: 0, posted: 0, received: 0, maxInFlight: 0, clippedDt: 0, blockedFrames: 0 };
  }

  advance(tick, time, { blocked = false } = {}) {
    if (tick !== this.tick + 1 || !Number.isFinite(time)) throw Error('Seat timing must advance one physics step at a time');
    this.tick = tick; this.pendingDt += this.step;
    this.atFrameBoundary = tick === this.nextTick;
    if (!this.atFrameBoundary) return null;
    this.frame++; this.stats.frames++;
    this.frameLength = this.frameSteps + this.frameRandom(this.frameJitter);
    this.nextTick = tick + this.frameLength;
    if (blocked) { this.stats.blockedFrames++; return null; }
    if (!this.packet || this.frame < this.packet.frame || time + 1e-9 < this.packet.due) return null;
    const packet = this.packet; this.packet = null; this.stats.received++;
    this.replyAges.push(time - packet.reply.at);
    return packet.reply;
  }

  canPost(time, period = 0) {
    return this.atFrameBoundary && !this.packet && time + 1e-9 >= this.lastPostAt + period;
  }

  post(reply, time, delaySeconds = 0) {
    if (!this.canPost(time) || !Number.isFinite(delaySeconds) || delaySeconds < 0
      || Math.abs(reply.at - time) > 1e-9) throw Error('Invalid or overlapping seat dispatch');
    const dt = Math.min(.1, this.pendingDt);
    if (this.pendingDt > .1 + 1e-9) this.stats.clippedDt++;
    if (Number.isFinite(this.lastPostAt)) this.intervals.push(time - this.lastPostAt);
    this.lastPostAt = time; this.pendingDt = 0;
    this.packet = { reply, due: time + delaySeconds,
      frame: this.frame + 1 + this.lagFrames + this.replyRandom(this.lagJitter) };
    this.stats.posted++; this.stats.maxInFlight = 1;
    return { dt, frame: this.frame, earliestReplyFrame: this.packet.frame, due: this.packet.due };
  }

  get workerDt() { return Math.min(.1, this.pendingDt); }
  get rowDuration() { return this.frameLength * this.step; }
  get closesRow() { return this.tick + 1 === this.nextTick; }
}

export function seatTimingOptions(args) {
  const arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
  const transport = arg('transport', 'native');
  const flags = ['frame-steps', 'lag-frames', 'lag-jitter', 'frame-jitter', 'schedule-seed', 'reply-service-ms'];
  if (transport === 'native' && flags.some(key => args.includes('--' + key)))
    throw Error('Frame timing flags require --transport seat-frame');
  return { transport, frameSteps: +arg('frame-steps', 2), lagFrames: +arg('lag-frames', 0),
    lagJitter: +arg('lag-jitter', 0), frameJitter: +arg('frame-jitter', 0), scheduleSeed: +arg('schedule-seed', 7),
    replyServiceMs: args.includes('--reply-service-ms') ? +arg('reply-service-ms') : null };
}
