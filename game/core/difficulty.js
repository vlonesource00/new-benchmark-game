// AI difficulty. The controllers themselves are never modified: a governor sits
// between a rival's controls and its car and holds it under a fraction of a
// reference speed profile (the fastest AI's clean lap, recorded per track by
// `node scripts/sim-endurance.mjs --profile`). Scaling the whole profile by k
// scales cornering and braking g by k², which reads as a less brave driver on a
// greasier track rather than a car that is suddenly down on power.
import { PACE_PROFILES } from './pace-profiles.js';

export const DIFFICULTIES = Object.freeze([
  { id: 'rookie',  label: 'ROOKIE',  k: 0.78, blurb: 'Rivals brake early and carry little speed.' },
  { id: 'amateur', label: 'AMATEUR', k: 0.85, blurb: 'Club pace. Clean laps win races.' },
  { id: 'pro',     label: 'PRO',     k: 0.91, blurb: 'Quick rivals. Small mistakes cost places.' },
  { id: 'expert',  label: 'EXPERT',  k: 0.96, blurb: 'Near the limit, most of the lap.' },
  { id: 'alien',   label: 'ALIEN',   k: 1,    blurb: 'Unrestricted AI. Good luck.' }
]);
export const difficultyById = (id) => DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[1];

export class PaceGovernor {
  /** `profile` = { bin, v: [m/s per bin] } or null (governor idle). */
  constructor(track, k, profile = PACE_PROFILES[track.id ?? track.name] ?? null) {
    this.k = k; this.L = track.length;
    this.profile = k < 0.999 && profile && profile.v.length ? profile : null;
  }
  get active() { return Boolean(this.profile); }
  ref(s) {
    const { bin, v } = this.profile, n = v.length;
    const x = (((s % this.L) + this.L) % this.L) / bin, i = Math.floor(x) % n, t = x - Math.floor(x);
    return v[i] + (v[(i + 1) % n] - v[i]) * t;
  }
  /** Speed the car may carry at `s`, looking a short distance ahead so the brake lands before the corner. */
  cap(s, speed) {
    let r = this.ref(s);
    for (const a of [0.15, 0.3, 0.45]) r = Math.min(r, this.ref(s + speed * a) + 4 * a);
    return r * this.k;
  }
  apply(car, s) {
    if (!this.profile) return;
    const over = car.speed - this.cap(s, car.speed), c = car.controls;
    if (over <= -1.5) return;
    const throttle = over <= 0 ? c.throttle * Math.min(1, -over / 1.5) : 0;
    // Extra brake eases off with steering lock: braking hard mid-corner spins the car.
    const lock = Math.min(1, Math.abs(c.steer ?? 0) * 2.5);
    const brake = over > 1 ? Math.max(c.brake, Math.min(0.85, (over - 1) / 5) * (1 - 0.8 * lock)) : c.brake;
    car.controls = { ...c, throttle: Math.min(c.throttle, throttle), brake };
  }
}
