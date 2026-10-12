export const TIMING_PROFILES = Object.freeze({
  native: { transport: 'native', rate: 60 },
  'frame-120': { transport: 'seat-frame', rate: 60, frameSteps: 1, replyServiceMs: 0 },
  'frame-60': { transport: 'seat-frame', rate: 60, frameSteps: 2, replyServiceMs: 0 },
  'frame-30': { transport: 'seat-frame', rate: 60, frameSteps: 4, replyServiceMs: 0 },
  'lag-1': { transport: 'seat-frame', rate: 60, frameSteps: 2, lagFrames: 1, replyServiceMs: 0 },
  'lag-2': { transport: 'seat-frame', rate: 60, frameSteps: 2, lagFrames: 2, replyServiceMs: 0 },
  jitter: { transport: 'seat-frame', rate: 60, frameSteps: 2, frameJitter: 2, lagJitter: 2, replyServiceMs: 0 },
  'spike-500': { transport: 'seat-frame', rate: 60, frameSteps: 2, spikeAt: 10, spikeMs: 500, replyServiceMs: 0 },
  measured: { transport: 'seat-frame', rate: 60, frameSteps: 2, replyServiceMs: null }
});

export function timingProfile(name) {
  if (!Object.hasOwn(TIMING_PROFILES, name)) throw Error('Unknown timing profile: ' + name);
  return { lagMs: 0, lagFrames: 0, lagJitter: 0, frameJitter: 0, spikeMs: 0, stallMs: 0, frameSteps: 2, ...TIMING_PROFILES[name] };
}
