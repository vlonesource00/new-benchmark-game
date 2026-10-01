// DeepSeek Brake Intent
// Braking is a spatial, planned event rather than a speed-error correction.
// Every event carries a start station, peak deceleration, trail phase, release
// projection, minimum speed and throttle pickup station. The controller may
// only brake inside a planned event or under an explicit traffic/safety cause.

import { wrap } from '../../sim/math.js';

export const BRAKE_CAUSES = Object.freeze({
  PLANNED: 'PLANNED_BRAKING_ZONE',
  TRAFFIC: 'TRAFFIC_CONFLICT',
  CONTACT: 'CONTACT_AVOIDANCE',
  EDGE: 'TRACK_EDGE',
  RECOVERY: 'RECOVERY',
});

// Group the profile's deceleration demand into physical braking events.
export function extractBrakeEvents(model, path, profile, { threshold = 0.55, mergeGap = 12 } = {}) {
  const n = model.n;
  const raw = [];
  let current = null;
  for (let i = 0; i < n; i++) {
    const decel = -profile.aLong[i];
    if (decel > threshold) {
      const s = i * model.ds;
      if (!current) current = { startS: s, endS: s, peakDecel: decel, peakS: s, minSpeed: profile.v[i], minSpeedS: s, samples: 1 };
      else {
        current.endS = s; current.samples++;
        if (decel > current.peakDecel) { current.peakDecel = decel; current.peakS = s; }
        if (profile.v[i] < current.minSpeed) { current.minSpeed = profile.v[i]; current.minSpeedS = s; }
      }
    } else if (current) {
      raw.push(current); current = null;
    }
  }
  if (current) raw.push(current);
  // Merge events split by short releases, then project trail and pickup points.
  const merged = [];
  for (const ev of raw) {
    const last = merged.at(-1);
    if (last && wrap(ev.startS - last.endS, model.length) < mergeGap) {
      last.endS = ev.endS;
      if (ev.peakDecel > last.peakDecel) { last.peakDecel = ev.peakDecel; last.peakS = ev.peakS; }
      if (ev.minSpeed < last.minSpeed) { last.minSpeed = ev.minSpeed; last.minSpeedS = ev.minSpeedS; }
    } else merged.push({ ...ev });
  }
  for (const ev of merged) {
    let trailS = ev.peakS;
    let pickupS = ev.endS;
    for (let d = 0; d < 140; d += model.ds) {
      const i = model.index(ev.peakS + d);
      if (-profile.aLong[i] < ev.peakDecel * 0.55) { trailS = i * model.ds; break; }
    }
    for (let d = 0; d < 160; d += model.ds) {
      const i = model.index(ev.endS + d);
      if (profile.aLong[i] > 0.35) { pickupS = i * model.ds; break; }
    }
    ev.trailS = trailS;
    ev.pickupS = pickupS;
    ev.span = wrap(ev.endS - ev.startS, model.length);
  }
  return merged;
}

// Find the planned event covering a station (with a small entry margin).
export function eventAt(events, model, s, margin = 2) {
  for (const ev of events) {
    const into = wrap(s - ev.startS, model.length);
    if (into <= ev.span + margin) return ev;
  }
  return null;
}

export function nextEvent(events, model, s) {
  let best = null, bestGap = Infinity;
  for (const ev of events) {
    const gap = wrap(ev.startS - s, model.length);
    if (gap < bestGap) { bestGap = gap; best = ev; }
  }
  return best ? { event: best, gap: bestGap } : null;
}
