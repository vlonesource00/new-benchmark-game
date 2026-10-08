import { clamp, random } from '../engine/sim/math.js';

// Race weather. Each preset is a band: inside it the cloud cover drifts on a
// slow seeded random walk and rain falls when the cover thickens, so a seed
// always replays the same afternoon. The physics stays deliberately mild:
//  - rain wets the track (the sim's existing wet-grip model) and sun and warm
//    air dry it again over a few minutes;
//  - track temperature is air plus solar heating under a clear sky minus wet
//    cooling, and is worth a few % of grip either side of a 35 °C optimum;
//  - air temperature is the floor the tyres cool towards.
// Changeable runs weather fronts instead of the drift: dry spells, cloud
// building in, showers of varying strength and clearing skies, a few minutes
// each, so a 12-lap race sees two or three real changes. Its start phase is
// random too, so it is not always the same overcast-then-rain afternoon.
export const WEATHER = {
  clear: { label: 'Clear', air: 24, cloud: [0, .25], rain: 0 },
  hot: { label: 'Hot', air: 33, cloud: [0, .1], rain: 0 },
  overcast: { label: 'Overcast', air: 17, cloud: [.65, .95], rain: 0 },
  rain: { label: 'Rain', air: 14, cloud: [.85, 1], rain: .55 },
  changeable: { label: 'Changeable', air: 19, cloud: [.1, 1], rain: .5 }
};

// Grip multiplier for a track temperature: -4.5% at the worst, 10 °C or 60 °C.
export const tempGrip = (t) => 1 - .045 * Math.min(1, ((t - 35) / 25) ** 2);

// Rain rate (mm/h) of a full-intensity downpour; light drizzle is a few mm/h.
export const RAIN_MM_H = 24;

export class Weather {
  constructor(id = 'clear', seed = 7) {
    this.preset = WEATHER[id] ?? WEATHER.clear; this.id = WEATHER[id] ? id : 'clear';
    this.rng = random(seed);
    // Wind carries the rain across the circuit: a front's edge sweeps over one end of the lap before the other,
    // and steady rain arrives in heavier and lighter bands. Direction and strength are seeded.
    const a = this.rng() * Math.PI * 2; this.wind = { dx: Math.sin(a), dz: Math.cos(a), speed: 4 + 8 * this.rng() };
    this.edge = 0; this.tail = -Infinity; this.clock = 0; this.centre = { x: 0, z: 0 }; this.extent = 600;
    const [lo, hi] = this.preset.cloud;
    this.cloud = (lo + hi) / 2;
    this.target = this.cloud; this.retarget = 0;
    this.intensity = this.preset.rain;
    if (this.id === 'changeable') this.startFront();
    this.sun = .6;   // sun height 0..1, fed by the race clock
    this.wet = this.rainFor(this.cloud);
    this.air = this.airFor(); this.trackTemp = this.trackTarget();
  }
  rainFor(cloud) { return this.intensity * clamp((cloud - .72) / .2, 0, 1); }
  // ---- changeable fronts ----
  startFront() {
    const r = this.rng(), phase = r < .4 ? 'dry' : r < .65 ? 'building' : r < .85 ? 'shower' : 'clearing';
    this.intensity = .3 + .7 * this.rng() ** .8;
    this.enterPhase(phase);
    this.phaseLeft *= .3 + .7 * this.rng(); // join the phase part-way through
    this.cloud = phase === 'dry' ? this.target : phase === 'building' ? .45 + .3 * this.rng() : phase === 'shower' ? this.target : .7 + .2 * this.rng();
  }
  enterPhase(phase) {
    const r = () => this.rng();
    this.phase = phase;
    // A shower's leading edge starts upwind of the circuit and crosses it; clearing drags the trailing edge across.
    if (phase === 'shower') { this.edge = -this.extent - 200; this.tail = -Infinity; }
    if (phase === 'clearing') this.tail = -this.extent - 200;
    if (phase === 'dry' || phase === 'building') { this.edge = -this.extent - 200; this.tail = -Infinity; }
    if (phase === 'dry') { this.phaseLeft = 150 + 170 * r(); this.target = .05 + .45 * r(); }
    if (phase === 'building') { this.phaseLeft = 40 + 50 * r(); this.target = .88 + .12 * r(); this.intensity = .3 + .7 * r() ** .8; }
    if (phase === 'shower') { this.phaseLeft = 60 + 150 * r(); this.target = .95 + .05 * r(); }
    if (phase === 'clearing') { this.phaseLeft = 35 + 45 * r(); this.target = .25 + .35 * r(); }
  }
  stepFront(dt) {
    if ((this.phaseLeft -= dt) <= 0) this.enterPhase({ dry: 'building', building: 'shower', shower: 'clearing', clearing: this.rng() < .2 ? 'building' : 'dry' }[this.phase]);
    // Fronts move in fast: cloud closes in or breaks up over half a minute or so.
    this.cloud += clamp(this.target - this.cloud, -.022 * dt, .022 * dt);
  }
  airFor() { return this.preset.air + 3 * (this.sun - .5); }
  trackTarget() { return this.air + 22 * Math.max(0, this.sun) * (1 - .8 * this.cloud) - 10 * this.wet; }
  get rain() { return this.rainFor(this.cloud); }
  /** Centre the rain geometry on a circuit (called once the race knows its track). */
  bind(track) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of track.nodes) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    this.centre = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }; this.extent = Math.hypot(x1 - x0, z1 - z0) / 2;
    if (this.phase === 'shower') this.edge = this.extent + 400; // joined mid-shower: already over the whole lap
    if (this.phase === 'clearing') { this.edge = this.extent + 400; this.tail = -this.extent * (0.3 + 0.6 * this.rng()); }
  }
  /** Rain rate in mm/h at a point: the sky's intensity times how much of the front is overhead there. */
  rainAt(x, z) {
    const rain = this.rain; if (rain <= 0) return 0;
    const along = (x - this.centre.x) * this.wind.dx + (z - this.centre.z) * this.wind.dz, edge = (e, w) => Math.min(1, Math.max(0, (e + w) / (2 * w)));
    let cover = 1;
    if (this.phase) cover = edge(this.edge - along, 160) * edge(along - this.tail, 220);
    // Bands: heavier and lighter rain a few hundred metres apart, drifting downwind.
    const band = 0.78 + 0.22 * Math.sin((along - this.clock * this.wind.speed) / 260);
    return RAIN_MM_H * rain * cover * band;
  }
  /** Evaporation from the road (mm/s): warm tarmac, sun and wind dry it; puddles also drain slowly. */
  evaporation() { return (0.00015 + 0.00003 * Math.max(0, this.trackTemp - 8)) * (1 + this.wind.speed / 20) * (1 - 0.5 * this.cloud); }
  step(dt) {
    this.clock += dt;
    if (this.phase) { this.edge += this.wind.speed * dt * 1.6; if (Number.isFinite(this.tail)) this.tail += this.wind.speed * dt * 1.6; }
    const [lo, hi] = this.preset.cloud;
    if (this.phase) this.stepFront(dt);
    else {
      if ((this.retarget -= dt) <= 0) { this.target = lo + this.rng() * (hi - lo); this.retarget = 60 + this.rng() * 90; }
      this.cloud += clamp(this.target - this.cloud, -.006 * dt, .006 * dt);
    }
    const rain = this.rain;
    // With a water field the race sets this.wet from the road itself; the old scalar model stays for bare tracks.
    if (this.waterDriven) { /* wet comes from the road */ }
    // Soaks in within a minute of rain; dries in a few minutes, faster when hot.
    else if (this.wet < rain) this.wet = Math.min(rain, this.wet + (rain - this.wet) * dt / 50 + .002 * dt);
    // Between changeable's showers the wind and the racing line dry it faster, so the dry spells count.
    else this.wet = Math.max(rain, this.wet - (.0012 + Math.max(0, this.trackTemp) * .00004) * (this.phase ? 2.2 : 1) * dt);
    this.air = this.airFor();
    this.trackTemp += (this.trackTarget() - this.trackTemp) * Math.min(1, dt / 180);
  }
  /** Push the current state into the sim's track. */
  apply(track) { if (!track.water?.live) track.wetness = this.wet; track.tempGrip = tempGrip(this.trackTemp); track.ambient = this.air; }
  snapshot() {
    const local = this.rainAt(this.centre.x, this.centre.z) / RAIN_MM_H;
    return { id: this.id, label: this.preset.label, air: this.air, track: this.trackTemp, wet: this.wet, rain: this.rain, rainHere: local, mmh: local * RAIN_MM_H, cloud: this.cloud, phase: this.phase ?? null,
      wind: { dx: this.wind.dx, dz: this.wind.dz, speed: this.wind.speed }, edge: this.edge, tail: Number.isFinite(this.tail) ? this.tail : null, centre: this.centre }; }
}
