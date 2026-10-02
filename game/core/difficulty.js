// AI difficulty. The controllers themselves are never modified: a governor sits
// between a rival's controls and its car and holds it under a fraction of a
// reference speed profile (the fastest AI's clean lap, recorded per track by
// `node scripts/sim-endurance.mjs --profile`). Scaling the whole profile by k
// scales cornering and braking g by kÂ², which reads as a less brave driver on a
// greasier track rather than a car that is suddenly down on power.
import { PACE_PROFILES } from './pace-profiles.js';

export const DIFFICULTIES = Object.freeze([
  { id: 'rookie',  label: 'ROOKIE',  k: 0.87, blurb: 'Rivals brake early and carry little speed.' },
  { id: 'amateur', label: 'AMATEUR', k: 0.92, blurb: 'Club pace. Clean laps win races.' },
  { id: 'pro',     label: 'PRO',     k: 0.955, blurb: 'Quick rivals. Small mistakes cost places.' },
  { id: 'expert',  label: 'EXPERT',  k: 0.98, blurb: 'Near the limit, most of the lap.' },
  { id: 'alien',   label: 'ALIEN',   k: 1,    blurb: 'Unrestricted AI. Good luck.' }
]);
export const difficultyById = (id) => DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[2];

export class PaceGovernor {
  /** `profile` = { bin, v: [m/s per bin] } or null (governor idle). */
  constructor(track, k, profile = PACE_PROFILES[track.id ?? track.name] ?? null) {
    this.base = k; this.L = track.length; this.track = track;
    // Race management, on top of difficulty: `manage` backs the pace off while
    // the tyres run hot, `grip` scales the dry reference down on a wet track.
    this.manage = 1; this.grip = 1; this.hot = 0; this.push = false;
    this.profile = profile && profile.v.length ? profile : null;
  }
  get k() { return Math.min(this.base, this.manage) * this.grip; }
  get active() { return Boolean(this.profile) && this.k < 0.999; }
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
  /**
   * Tyre and weather management. Core temperature is the slow variable
   * (minutes) that decides the grip of the whole stint, so the pace target
   * comes off it: flat out up to MANAGE_OVER past the compound's window, then 0.4% per °C over.
   * Corner speed scales slip power roughly with k³, so a few percent is
   * enough to hold the tyres at their window instead of cooking them.
   */
  manageStep(car, dt) {
    let core = 0, over = -Infinity, surface = 0;
    for (const w of car.wheels) { core = Math.max(core, w.tyre.core); over = Math.max(over, w.tyre.core - (w.tyre.optimum ?? 85)); surface = Math.max(surface, w.tyre.surface); }
    this.hot = core;
    const target = this.push ? 1 : Math.max(MANAGE_FLOOR, Math.min(1, 1 - MANAGE_GAIN * (over - MANAGE_OVER) - 0.0015 * Math.max(0, surface - 125)));
    this.manage += (target - this.manage) * Math.min(1, dt / 3);
    const wet = this.track.wetness ?? 0;
    this.grip = Math.sqrt(Math.max(0.5, 1 - wet * 0.36));
  }
  apply(car, s) {
    // Traction: wheelspin past the force peak only heats the driven tyres.
    const c0 = car.controls, d = car.spec.drive === 'front' ? 0 : 2;
    const spin = Math.max(car.wheels[d].tyre.kappa, car.wheels[d + 1].tyre.kappa);
    if (spin > SPIN_LIMIT && c0.throttle > 0) car.controls = { ...c0, throttle: c0.throttle * Math.max(0.35, 1 - (spin - SPIN_LIMIT) * 9) };
    if (!this.active) return;
    const over = car.speed - this.cap(s, car.speed), c = car.controls;
    if (over <= -1.5) return;
    const throttle = over <= 0 ? c.throttle * Math.min(1, -over / 1.5) : 0;
    // Extra brake eases off with steering lock: braking hard mid-corner spins the car.
    const lock = Math.min(1, Math.abs(c.steer ?? 0) * 2.5);
    const brake = over > 1 ? Math.max(c.brake, Math.min(0.85, (over - 1) / 5) * (1 - 0.8 * lock)) : c.brake;
    car.controls = { ...c, throttle: Math.min(c.throttle, throttle), brake };
  }
}

// Degrees over the compound's optimum the AIs run flat out up to, and the slowest they back off to.
const env = globalThis.process?.env ?? {};
export const MANAGE_OVER = Number(env.MANAGE_OVER ?? 14);
export const MANAGE_FLOOR = Number(env.MANAGE_FLOOR ?? 0.92);
const MANAGE_GAIN = Number(env.MANAGE_GAIN ?? 0.004);
// The game tyre's drive force peaks near 0.23 slip ratio; 0.09 gave only 77 % of it and
// held every AI's throttle at ~0.65 on corner exits. 0.18 is 99 % of the peak.
const SPIN_LIMIT = Number(env.SPIN_LIMIT ?? 0.18);
