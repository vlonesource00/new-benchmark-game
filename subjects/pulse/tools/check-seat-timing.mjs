import assert from 'node:assert/strict';
import { SeatTiming, seatTimingOptions } from '../src/seat-timing.mjs';
import { ActionMailbox } from '../src/runtime.mjs';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { runScenario } from './scenario.mjs';

const checks = [];
const check = async (name, run) => { await run(); checks.push(name); };
const reply = (seq, at) => ({ seq, base: seq - 1, epoch: 1, at, action: [seq / 100, .5], hidden: new Array(128).fill(seq / 100) });
const random = seed => { let s = seed >>> 0; return n => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return Math.floor(s / 2 ** 32 * (n + 1)); }; };

await check('Only one request can be in flight; no reply inside a frame', () => {
  const timing = new SeatTiming();
  timing.advance(0, 0); assert.equal(timing.post(reply(1, 0), 0).dt, 1 / 120);
  assert.throws(() => timing.post(reply(2, 0), 0));
  assert.equal(timing.advance(1, 1 / 120), null); assert.equal(timing.canPost(1 / 120), false);
  assert.equal(timing.advance(2, 2 / 120).seq, 1); assert.equal(timing.canPost(2 / 120), true);
  assert.equal(timing.post(reply(2, 2 / 120), 2 / 120).dt, 2 / 120);
});
await check('Reply service time rounds up to the next available frame', () => {
  const timing = new SeatTiming(); timing.advance(0, 0); timing.post(reply(1, 0), 0, .02);
  for (let i = 1; i < 4; i++) assert.equal(timing.advance(i, i / 120), null);
  assert.equal(timing.advance(4, 4 / 120).seq, 1);
});
await check('Busy time accumulates; worker dt is clipped at 100 ms', () => {
  const timing = new SeatTiming(); timing.advance(0, 0); timing.post(reply(1, 0), 0, .2);
  for (let i = 1; i < 24; i++) timing.advance(i, i / 120);
  assert.equal(timing.advance(24, .2).seq, 1);
  assert.equal(timing.post(reply(2, .2), .2).dt, .1); assert.equal(timing.stats.clippedDt, 1);
});
await check('A stalled reply does not commit action or memory', () => {
  const timing = new SeatTiming(), mailbox = new ActionMailbox();
  timing.advance(0, 0); const request = mailbox.request(0);
  timing.post({ ...request, action: [.1, 1], hidden: new Array(128).fill(1) }, 0);
  for (let i = 1; i < 24; i++) assert.equal(timing.advance(i, i / 120, { blocked: true }), null);
  const late = timing.advance(24, .2); assert.equal(mailbox.accept(late, .2), false);
  assert.equal(mailbox.accepted, 0); assert.deepEqual(mailbox.action, [0, 0]); assert.equal(Math.hypot(...mailbox.hidden), 0);
  const next = mailbox.request(.2); assert.equal(next.base, 0); assert.deepEqual(next.hidden, mailbox.hidden);
  assert.equal(timing.post({ ...next, action: [.1, 1], hidden: new Array(128).fill(2) }, .2).dt, .1);
});
await check('Explicit rate limit and reset remain deterministic under jitter', () => {
  const timing = new SeatTiming({ frameSteps: 1, frameJitter: 3, lagJitter: 2, scheduleSeed: 13 });
  const run = () => { const posts = []; let seq = 0; for (let tick = 0; tick < 100; tick++) {
    const time = tick / 120; timing.advance(tick, time);
    if (timing.canPost(time, 1 / 30)) { const sent = timing.post(reply(++seq, time), time); posts.push([time, sent.dt, sent.earliestReplyFrame]); }
  } return posts; };
  const a = run(); timing.reset(); assert.deepEqual(run(), a);
  assert(a.slice(1).every((p, i) => p[0] - a[i][0] >= 1 / 30 - 1e-9));
});
await check('Bad timing options fail before running a race', () => {
  for (const options of [{ frameSteps: 0 }, { frameSteps: 1.5 }, { lagFrames: -1 }, { lagJitter: NaN }, { frameJitter: 13 }, { scheduleSeed: -1 }])
    assert.throws(() => new SeatTiming(options));
  assert.throws(() => seatTimingOptions(['--frame-steps', '4']));
  assert.equal(seatTimingOptions(['--transport', 'seat-frame', '--frame-steps', '4']).frameSteps, 4);
});

// The fake worker supplies numbered controls only. Actual AsyncSeats handles
// dispatch, elapsed dt, sequence matching and held pedals without modification.
// This checks protocol parity, not NN driving or actual browser message timing.
for (const options of [
  { frameSteps: 1 }, { frameSteps: 2 }, { frameSteps: 4 },
  { frameSteps: 2, lagFrames: 1 }, { frameSteps: 2, lagFrames: 2 },
  { frameSteps: 2, frameJitter: 3, lagJitter: 2, scheduleSeed: 31 },
  { frameSteps: 2, serviceMs: 27 }, { frameSteps: 2, serviceMs: 175 }
]) await check('Unmodified game seat protocol parity: ' + JSON.stringify(options), () => {
  const WorkerBefore = globalThis.Worker, instances = [], sent = [], expected = [];
  const config = { frameSteps: 2, frameJitter: 0, lagFrames: 0, lagJitter: 0, scheduleSeed: 7, serviceMs: 0, ...options };
  const frames = random(config.scheduleSeed ^ 0x5046524d), lags = random(config.scheduleSeed ^ 0x5052504c);
  let frame = -1, nextTick = 0, now = 0, lastControls = { steer: 0, throttle: 0, brake: 0 };
  class ProbeWorker {
    constructor() { instances.push(this); this.pending = null; }
    postMessage(data) {
      if (data.type !== 'step') return;
      assert.equal(this.pending, null, 'game sent an overlapping request');
      sent.push({ time: data.time, dt: data.dt, seq: data.seq });
      this.pending = { seq: data.seq, frame: frame + 1 + config.lagFrames + lags(config.lagJitter), due: now + config.serviceMs / 1000 };
    }
    deliver() {
      if (!this.pending || frame < this.pending.frame || now + 1e-9 < this.pending.due) return;
      const { seq } = this.pending; this.pending = null;
      this.onmessage({ data: { type: 'controls', seq, errors: 0, controls: { steer: seq / 100, throttle: .5, brake: 0 } } });
    }
    terminate() {}
  }
  globalThis.Worker = ProbeWorker;
  try {
    const driver = { id: 'pulse-protocol-probe', kind: 'ai' }, car = { id: 'probe', controls: { ...lastControls } };
    const race = { time: 0, teams: [{ drivers: [driver] }], cars: [car], track: { wetness: 0, tempGrip: 1, rubber: [] } };
    const seats = new AsyncSeats('harbor-ring'), seat = seats.seat(driver, 0, race), timing = new SeatTiming(config);
    let seq = 0;
    for (let tick = 0; tick < 160; tick++) {
      now = tick / 120; race.time = now;
      if (tick === nextTick) { frame++; nextTick = tick + config.frameSteps + frames(config.frameJitter); instances[0].deliver(); }
      const received = timing.advance(tick, now);
      if (received) lastControls = { steer: received.seq / 100, throttle: .5, brake: 0 };
      if (timing.canPost(now)) { const sent = timing.post(reply(++seq, now), now, config.serviceMs / 1000); expected.push({ time: now, dt: sent.dt, seq }); }
      seat.update(car, race.cars, 1 / 120, { time: now, totalLaps: 5 });
      assert.deepEqual(car.controls, lastControls, 'controls changed before a received reply');
    }
    assert.deepEqual(sent, expected); assert.equal(timing.stats.maxInFlight, 1);
  } finally { globalThis.Worker = WorkerBefore; }
});

await check('Physical harness rows preserve request ancestry and frame duration', async () => {
  const result = await runScenario({ seconds: .6, transport: 'seat-frame', frameSteps: 2, lagFrames: 1, replyServiceMs: 0,
    mode: 'policy', policy: async (_x, hidden) => ({ action: [0, .2], hidden: hidden.map(x => x + .01) }) });
  const { rows, summary } = result; assert.equal(rows.length, 36);
  assert.equal(summary.seatTiming.maxInFlight, 1); assert.equal(summary.seatTiming.posted, 18);
  assert.equal(summary.mailbox.obsolete, 0); assert.equal(summary.mailbox.invalid, 0);
  let previousRequest = 0;
  for (const row of rows) {
    assert.equal(row.substeps.length, 2); assert.equal(row.dt, 1 / 60);
    if (row.request) {
      assert.equal(row.request.base, row.acceptedBefore); assert.equal(row.request.base, previousRequest);
      assert.equal(row.request.dt, row.workerDt); previousRequest = row.request.seq;
    } else assert.equal(row.policyProposal, undefined);
  }
});
console.log(JSON.stringify({ passed: checks.length, checks,
  scope: 'Transport parity uses actual AsyncSeats with a numbered fake worker. Actual browser Workers and model performance remain separate gates.' }));
