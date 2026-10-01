import { clamp, random } from '../engine/sim/math.js';

// Race weather. Each preset is a band: inside it the cloud cover drifts on a
// slow seeded random walk and rain falls when the cover thickens, so a seed
// always replays the same afternoon. The physics stays deliberately mild:
//  - rain wets the track (the sim's existing wet-grip model) and sun and warm
//    air dry it again over a few minutes;
//  - track temperature is air plus solar heating under a clear sky minus wet
//    cooling, and is worth a few % of grip either side of a 35 °C optimum;
//  - air temperature is the floor the tyres cool towards.
export const WEATHER = {
  clear: { label: 'Clear', air: 24, cloud: [0, .25], rain: 0 },
  hot: { label: 'Hot', air: 33, cloud: [0, .1], rain: 0 },
  overcast: { label: 'Overcast', air: 17, cloud: [.65, .95], rain: 0 },
  rain: { label: 'Rain', air: 14, cloud: [.85, 1], rain: .55 },
  changeable: { label: 'Changeable', air: 19, cloud: [.1, 1], rain: .5 }
};

// Grip multiplier for a track temperature: -4.5% at the worst, 10 °C or 60 °C.
export const tempGrip = (t) => 1 - .045 * Math.min(1, ((t - 35) / 25) ** 2);

export class Weather {
  constructor(id = 'clear', seed = 7) {
    this.preset = WEATHER[id] ?? WEATHER.clear; this.id = WEATHER[id] ? id : 'clear';
    this.rng = random(seed);
    const [lo, hi] = this.preset.cloud;
    this.cloud = this.id === 'changeable' ? lo + this.rng() * (hi - lo) * .7 : (lo + hi) / 2;
    this.target = this.cloud; this.retarget = 0;
    this.sun = .6;   // sun height 0..1, fed by the race clock
    this.wet = this.rainFor(this.cloud);
    this.air = this.airFor(); this.trackTemp = this.trackTarget();
  }
  rainFor(cloud) { return this.preset.rain * clamp((cloud - .72) / .2, 0, 1); }
  airFor() { return this.preset.air + 3 * (this.sun - .5); }
  trackTarget() { return this.air + 22 * Math.max(0, this.sun) * (1 - .8 * this.cloud) - 10 * this.wet; }
  get rain() { return this.rainFor(this.cloud); }
  step(dt) {
    const [lo, hi] = this.preset.cloud;
    if ((this.retarget -= dt) <= 0) { this.target = lo + this.rng() * (hi - lo); this.retarget = 60 + this.rng() * 90; }
    this.cloud += clamp(this.target - this.cloud, -.006 * dt, .006 * dt);
    const rain = this.rain;
    // Soaks in within a minute of rain; dries in a few minutes, faster when hot.
    if (this.wet < rain) this.wet = Math.min(rain, this.wet + (rain - this.wet) * dt / 50 + .002 * dt);
    else this.wet = Math.max(rain, this.wet - (.0012 + Math.max(0, this.trackTemp) * .00004) * dt);
    this.air = this.airFor();
    this.trackTemp += (this.trackTarget() - this.trackTemp) * Math.min(1, dt / 180);
  }
  /** Push the current state into the sim's track. */
  apply(track) { track.wetness = this.wet; track.tempGrip = tempGrip(this.trackTemp); track.ambient = this.air; }
  snapshot() { return { id: this.id, label: this.preset.label, air: this.air, track: this.trackTemp, wet: this.wet, rain: this.rain, cloud: this.cloud }; }
}
