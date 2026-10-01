import { clamp } from '../engine/sim/math.js';

// Procedural racing audio: a V8-style engine built from firing-order harmonic
// tables (exhaust + intake + mechanical layers through a soft-clip shaper),
// turbo spool / blow-off, tonal tyre squeal, road and wind beds, a generated
// convolution reverb, harbour/crowd ambience and Doppler-shifted rivals.
const RPM_MIN = 1100, RPM_MAX = 8300;

function wave(c, amps, phaseJitter = 0) {
  const real = new Float32Array(amps.length + 1), imag = new Float32Array(amps.length + 1);
  amps.forEach((a, i) => { const p = phaseJitter * Math.sin(i * 2.3); real[i + 1] = a * Math.sin(p); imag[i + 1] = a * Math.cos(p); });
  return c.createPeriodicWave(real, imag);
}
function shaper(c, drive) {
  const n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(x * drive) / Math.tanh(drive); }
  const s = c.createWaveShaper(); s.curve = curve; s.oversample = '2x'; return s;
}
function impulse(c, seconds, decay) {
  const length = Math.floor(c.sampleRate * seconds), buffer = c.createBuffer(2, length, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch); let lp = 0;
    for (let i = 0; i < length; i++) { const t = i / length; lp += (Math.random() * 2 - 1 - lp) * (.55 - t * .4); d[i] = lp * Math.pow(1 - t, decay) * (i < c.sampleRate * .012 ? i / (c.sampleRate * .012) : 1); }
  }
  return buffer;
}

export class AudioEngine {
  constructor() { this.volume = .4; this.enabled = true; }

  async unlock() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const c = this.ctx = new C();
    this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 3.5; comp.attack.value = .003; comp.release.value = .2;
    const limiter = c.createDynamicsCompressor(); limiter.threshold.value = -2; limiter.ratio.value = 20; limiter.attack.value = .001; limiter.release.value = .08;
    this.master.connect(comp); comp.connect(limiter); limiter.connect(c.destination);
    this.dry = c.createGain(); this.dry.connect(this.master);
    this.reverb = c.createConvolver(); this.reverb.buffer = impulse(c, 2.2, 3.2);
    this.wet = c.createGain(); this.wet.gain.value = .16; this.reverb.connect(this.wet); this.wet.connect(this.master);
    this.send = c.createGain(); this.send.connect(this.reverb);

    const noise = c.createBuffer(1, c.sampleRate * 3, c.sampleRate), d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const brown = c.createBuffer(1, c.sampleRate * 3, c.sampleRate), b = brown.getChannelData(0); let last = 0;
    for (let i = 0; i < b.length; i++) { last = (last + .02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    this.noiseBuffer = noise; this.brownBuffer = brown;

    // Engine: exhaust (firing order fundamental + half orders), intake roar, mechanical top end.
    this.engineBus = c.createGain(); this.engineBus.gain.value = 0;
    this.engineShape = shaper(c, 2.2);
    this.engineTone = c.createBiquadFilter(); this.engineTone.type = 'lowpass'; this.engineTone.Q.value = .9;
    this.engineBody = c.createBiquadFilter(); this.engineBody.type = 'peaking'; this.engineBody.frequency.value = 180; this.engineBody.gain.value = 5; this.engineBody.Q.value = .8;
    this.engineBus.connect(this.engineShape); this.engineShape.connect(this.engineBody); this.engineBody.connect(this.engineTone);
    this.engineTone.connect(this.dry); this.engineTone.connect(this.send);
    const exhaustWave = wave(c, [.55, 1, .35, .72, .18, .4, .1, .26, .06, .14, .04, .08, .03, .05], .8);
    const intakeWave = wave(c, [.2, .5, .6, .9, .5, .6, .4, .45, .3, .35, .25, .28, .2, .2, .15, .16]);
    this.engine = [
      { type: exhaustWave, mult: 1, gain: .34, detune: 0 },
      { type: exhaustWave, mult: 1, gain: .22, detune: 7 },
      { type: intakeWave, mult: 2, gain: .1, detune: -4 },
      { type: 'sine', mult: .5, gain: .22, detune: 0 },
    ].map(v => {
      const o = c.createOscillator(); if (typeof v.type === 'string') o.type = v.type; else o.setPeriodicWave(v.type);
      o.detune.value = v.detune; const g = c.createGain(); g.gain.value = v.gain; o.connect(g); g.connect(this.engineBus); o.start(); return { o, g, ...v };
    });
    // Combustion rasp: noise amplitude-modulated at firing frequency, only on load.
    this.rasp = this.noiseLayer('bandpass', 2400, .9, this.engineBus);
    this.raspMod = c.createOscillator(); this.raspMod.type = 'square'; const raspDepth = c.createGain(); raspDepth.gain.value = .5;
    this.raspMod.connect(raspDepth); raspDepth.connect(this.rasp.gain.gain); this.raspMod.start();
    // Intake induction roar straight to the dry bus.
    this.intake = this.noiseLayer('bandpass', 700, 1.4, this.dry);
    // Mechanical whine: straight-cut gears.
    this.gearOsc = c.createOscillator(); this.gearOsc.type = 'triangle'; this.gearGain = c.createGain(); this.gearGain.gain.value = 0;
    this.gearOsc.connect(this.gearGain); this.gearGain.connect(this.dry); this.gearOsc.start();
    // Turbo whistle and wastegate chatter.
    this.turbo = c.createOscillator(); this.turbo.type = 'sine'; this.turboGain = c.createGain(); this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain); this.turboGain.connect(this.dry); this.turboGain.connect(this.send); this.turbo.start();
    this.boost = 0;

    // Tyres: two resonant bands give a tonal squeal instead of hiss.
    this.squealA = this.noiseLayer('bandpass', 950, 14, this.dry);
    this.squealB = this.noiseLayer('bandpass', 1900, 10, this.dry);
    this.scrub = this.noiseLayer('bandpass', 600, 1.2, this.dry);
    this.wind = this.noiseLayer('lowpass', 500, .6, this.dry, true);
    this.road = this.noiseLayer('lowpass', 160, 1.1, this.dry, true);
    this.kerb = c.createOscillator(); this.kerb.type = 'square'; this.kerbGain = c.createGain(); this.kerbGain.gain.value = 0;
    const kerbLp = c.createBiquadFilter(); kerbLp.type = 'lowpass'; kerbLp.frequency.value = 260;
    this.kerb.connect(kerbLp); kerbLp.connect(this.kerbGain); this.kerbGain.connect(this.dry); this.kerb.start();
    this.gravel = this.noiseLayer('highpass', 900, .7, this.dry);

    // Ambience bed: distant crowd murmur, harbour wash and wind in rigging.
    this.ambience = c.createGain(); this.ambience.gain.value = .0; this.ambience.connect(this.dry); this.ambience.connect(this.send);
    this.crowd = this.noiseLayer('bandpass', 520, .6, this.ambience, true); this.crowd.gain.gain.value = .5;
    const swell = c.createOscillator(); swell.frequency.value = .07; const swellDepth = c.createGain(); swellDepth.gain.value = .2;
    swell.connect(swellDepth); swellDepth.connect(this.crowd.gain.gain); swell.start();
    this.sea = this.noiseLayer('lowpass', 380, .4, this.ambience, true); this.sea.gain.gain.value = .45;
    const tide = c.createOscillator(); tide.frequency.value = .11; const tideDepth = c.createGain(); tideDepth.gain.value = .3;
    tide.connect(tideDepth); tideDepth.connect(this.sea.gain.gain); tide.start();

    this.rivals = Array.from({ length: 4 }, () => {
      const o = c.createOscillator(), sub = c.createOscillator(), gain = c.createGain(), pan = c.createStereoPanner(), filter = c.createBiquadFilter(), sh = shaper(c, 1.8);
      o.setPeriodicWave(exhaustWave); sub.type = 'sine'; const subGain = c.createGain(); subGain.gain.value = .4;
      filter.type = 'lowpass'; filter.frequency.value = 700; gain.gain.value = 0;
      o.connect(sh); sub.connect(subGain); subGain.connect(sh); sh.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.dry); gain.connect(this.send);
      o.start(); sub.start(); return { o, sub, gain, pan, filter, id: null };
    });
    this.lastGear = null; this.lastImpact = 0; this.lastThrottle = 0; this.lastPop = -1; this.wasRunning = false;
    this.nextGull = c.currentTime + 3; this.nextHorn = c.currentTime + 14; this.lastZone = 'asphalt';
    await c.resume();
  }

  noiseLayer(type, frequency, q, dest, brown = false) {
    const c = this.ctx, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = brown ? this.brownBuffer : this.noiseBuffer; source.loop = true; source.loopStart = Math.random();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.value = 0;
    source.connect(filter); filter.connect(gain); gain.connect(dest); source.start(0, Math.random() * 2); return { gain, filter };
  }
  burst(type, from, to, strength, duration, q = 1, dest = this.dry, brown = false) {
    const c = this.ctx, t = c.currentTime, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = brown ? this.brownBuffer : this.noiseBuffer; filter.type = type; filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t); filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    gain.gain.setValueAtTime(.0001, t); gain.gain.linearRampToValueAtTime(Math.max(.001, strength), t + .004); gain.gain.exponentialRampToValueAtTime(.0005, t + duration);
    source.connect(filter); filter.connect(gain); gain.connect(dest); gain.connect(this.send);
    source.start(t, Math.random() * 2); source.stop(t + duration + .02);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }
  tone(freqs, strength, attack, duration, type = 'sine', glide = 1, dest = this.dry, pan = 0) {
    const c = this.ctx, t = c.currentTime, g = c.createGain(), p = c.createStereoPanner(); p.pan.value = pan;
    g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(strength, t + attack); g.gain.setValueAtTime(strength, t + duration * .7); g.gain.exponentialRampToValueAtTime(.0001, t + duration);
    g.connect(p); p.connect(dest); p.connect(this.send);
    for (const f of freqs) { const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * glide, t + duration); o.connect(g); o.start(t); o.stop(t + duration + .02); o.onended = () => o.disconnect(); }
    setTimeout(() => { g.disconnect(); p.disconnect(); }, (duration + .2) * 1000);
  }
  bang(strength) {
    this.burst('lowpass', 900, 120, strength, .11, .7, this.dry, true);
    this.burst('bandpass', 2400, 600, strength * .5, .06, 1.2);
  }
  /**
   * Exhaust backfire. `distance` 0 is the focus car; rivals fade with range and
   * are panned. Layers: sub thump, low body, crack, and a high-frequency snap.
   */
  backfire(strength, kind, distance = 0, pan = 0) {
    if (!this.ctx || !this.enabled) return;
    const k = strength / (1 + distance * .06);
    if (k < .012) return;
    const c = this.ctx, t = c.currentTime, out = c.createStereoPanner(); out.pan.value = pan; out.connect(this.dry);
    const big = kind === 'bang';
    // Sub thump: a pitch-dropping sine you feel more than hear.
    const o = c.createOscillator(), g = c.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(big ? 95 : 130, t); o.frequency.exponentialRampToValueAtTime(big ? 34 : 60, t + (big ? .16 : .07));
    g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(k * (big ? .7 : .35), t + .003); g.gain.exponentialRampToValueAtTime(.0005, t + (big ? .2 : .09));
    o.connect(g); g.connect(out); o.start(t); o.stop(t + .25);
    o.onended = () => { o.disconnect(); g.disconnect(); setTimeout(() => out.disconnect(), 800); };
    const burstTo = (type, from, to, gain, dur, q, brown) => {
      const src = c.createBufferSource(), f = c.createBiquadFilter(), gg = c.createGain();
      src.buffer = brown ? this.brownBuffer : this.noiseBuffer; f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
      gg.gain.setValueAtTime(.0001, t); gg.gain.linearRampToValueAtTime(Math.max(.001, gain), t + .002); gg.gain.exponentialRampToValueAtTime(.0005, t + dur);
      src.connect(f); f.connect(gg); gg.connect(out); if (distance < 40) gg.connect(this.send);
      src.start(t, Math.random() * 2); src.stop(t + dur + .02); src.onended = () => { src.disconnect(); f.disconnect(); gg.disconnect(); };
    };
    burstTo('lowpass', big ? 1400 : 1000, 120, k * (big ? .55 : .3), big ? .16 : .08, .7, true);           // body
    burstTo('bandpass', big ? 2600 : 3200, 700, k * (big ? .38 : .26), big ? .08 : .045, 1.3, false);     // crack
    burstTo('highpass', 5200, 3000, k * (distance > 30 ? .05 : .16), .025, .7, false);                     // snap
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(this.enabled ? v : 0, this.ctx.currentTime, .08); }
  toggle() { this.enabled = !this.enabled; this.setVolume(this.volume); return this.enabled; }

  update(car, running, cars = []) {
    if (!this.ctx || !car) return;
    const c = this.ctx, t = c.currentTime, thr = car.controls.throttle, rpm = clamp(car.rpm, RPM_MIN, RPM_MAX), load = running ? thr : 0;
    const norm = (rpm - RPM_MIN) / (RPM_MAX - RPM_MIN), fire = rpm / 60 * 4; // V8: four firing events per crank revolution
    this.ambience.gain.setTargetAtTime(.05, t, .5);

    const idle = running ? 1 : .55;
    this.engineBus.gain.setTargetAtTime((.16 + load * .5 + norm * .12) * idle, t, .03);
    for (const v of this.engine) v.o.frequency.setTargetAtTime(fire / 4 * v.mult * 2, t, .02);
    this.engineTone.frequency.setTargetAtTime(380 + norm * 2600 + load * 2400, t, .03);
    this.engineBody.gain.setTargetAtTime(3 + (1 - norm) * 5, t, .1);
    this.rasp.gain.gain.setTargetAtTime(load * (.05 + norm * .1), t, .03);
    this.rasp.filter.frequency.setTargetAtTime(1600 + norm * 2400, t, .05);
    this.raspMod.frequency.setTargetAtTime(fire, t, .02);
    this.intake.gain.gain.setTargetAtTime(load * norm * .12, t, .04);
    this.intake.filter.frequency.setTargetAtTime(450 + norm * 1100, t, .05);

    const speed = clamp(car.speed / 75, 0, 1), on = running ? 1 : 0;
    this.gearGain.gain.setTargetAtTime(on * speed * .018 * (1.2 - thr * .6), t, .05);
    this.gearOsc.frequency.setTargetAtTime(160 + car.speed * 21, t, .04);
    const targetBoost = on * thr * clamp((rpm - 2800) / 3500, 0, 1);
    this.boost += (targetBoost - this.boost) * (targetBoost > this.boost ? .04 : .15);
    this.turbo.frequency.setTargetAtTime(1800 + this.boost * 4200 + norm * 800, t, .05);
    this.turboGain.gain.setTargetAtTime(this.boost * .018, t, .05);

    const slip = !car.wheels?.length ? 0 : Math.max(...car.wheels.map(w => Math.abs(w.tyre.alpha) + Math.abs(w.tyre.kappa) * .35));
    const squeal = on * clamp((slip - .09) * 1.3, 0, .32) * clamp(car.speed / 12, 0, 1) * (car.zone === 'asphalt' || car.zone === 'kerb' ? 1 : .15);
    this.squealA.gain.gain.setTargetAtTime(squeal * .5, t, .04); this.squealB.gain.gain.setTargetAtTime(squeal * .22, t, .04);
    this.squealA.filter.frequency.setTargetAtTime(760 + clamp(slip, 0, 1) * 500 + car.speed * 2, t, .1);
    this.squealB.filter.frequency.setTargetAtTime(1600 + clamp(slip, 0, 1) * 900, t, .1);
    this.scrub.gain.gain.setTargetAtTime(squeal * .3, t, .05);
    this.wind.gain.gain.setTargetAtTime(on * speed * speed * .45, t, .15);
    this.wind.filter.frequency.setTargetAtTime(300 + car.speed * 14, t, .2);
    this.road.gain.gain.setTargetAtTime(on * .25 * speed, t, .05);
    const kerb = car.zone === 'kerb' && running;
    this.kerbGain.gain.setTargetAtTime(kerb ? .12 * speed + .02 : 0, t, .02);
    this.kerb.frequency.setTargetAtTime(Math.max(8, car.speed / 1.25 * 2), t, .03);
    this.gravel.gain.gain.setTargetAtTime(on && car.zone !== 'asphalt' && car.zone !== 'kerb' ? speed * .32 + .03 : 0, t, .05);

    if (running && this.wasRunning) {
      if (car.gear !== this.lastGear && car.speed > 5) {
        if (car.gear > this.lastGear) {
          this.engineBus.gain.setValueAtTime(this.engineBus.gain.value * .35, t); this.engineBus.gain.setTargetAtTime(.16 + load * .5, t + .06, .03);
          this.burst('bandpass', 180, 90, .12, .07, 2);
        } else this.burst('bandpass', 340, 200, .08, .06, 2);
      }
      if (car.impact > this.lastImpact + .015) {
        const k = clamp(car.impact * .8, .1, .6);
        this.burst('lowpass', 1400, 90, k, .35, .8, this.dry, true); this.burst('highpass', 3500, 1800, k * .4, .5, .6);
      }
      // Blow-off valve; the pops themselves come from backfire() (render/exhaust.js).
      if (this.lastThrottle > .65 && thr < .2 && rpm > 4800 && this.boost > .25) this.burst('bandpass', 3800, 1400, .1 * this.boost + .03, .45, 2.5);
    }
    if (kerb && this.lastZone !== 'kerb') this.burst('lowpass', 500, 120, .1 * speed + .02, .12, 1, this.dry, true);
    this.lastZone = car.zone; this.lastGear = car.gear; this.lastImpact = car.impact; this.lastThrottle = thr; this.wasRunning = running;

    // Ambient events.
    if (t > this.nextGull) {
      const n = 1 + Math.floor(Math.random() * 3), p = Math.random() * 1.6 - .8;
      for (let i = 0; i < n; i++) setTimeout(() => this.ctx && this.tone([2100 + Math.random() * 500, 2900], .006, .02, .28, 'triangle', .62, this.ambience, p), i * 230);
      this.nextGull = t + 5 + Math.random() * 9;
    }
    if (t > this.nextHorn) { this.tone([92, 138.5], .05, .6, 3.2, 'sawtooth', .995, this.ambience, -.5); this.nextHorn = t + 50 + Math.random() * 60; }

    const nearby = cars.filter(o => o !== car).map(o => ({ car: o, distance: Math.hypot(o.x - car.x, o.z - car.z) })).filter(o => o.distance < 140).sort((a, b) => a.distance - b.distance).slice(0, this.rivals.length);
    for (const v of this.rivals) if (!nearby.some(n => n.car.id === v.id)) v.id = null;
    for (const n of nearby) if (!this.rivals.some(v => v.id === n.car.id)) { const free = this.rivals.find(v => v.id === null); if (free) free.id = n.car.id; }
    for (const v of this.rivals) {
      const n = nearby.find(n => n.car.id === v.id);
      v.gain.gain.setTargetAtTime(running && n && n.car.speed > 1 ? (.05 + n.car.controls.throttle * .07) / (1 + n.distance * .06) : 0, t, .08);
      if (!n) continue;
      const dx = n.car.x - car.x, dz = n.car.z - car.z, dist = Math.max(1, n.distance);
      const closing = ((car.vx - n.car.vx) * dx + (car.vz - n.car.vz) * dz) / dist, doppler = clamp(343 / (343 - closing), .78, 1.28);
      const f = clamp(n.car.rpm, RPM_MIN, RPM_MAX) / 60 * 2 * doppler;
      v.o.frequency.setTargetAtTime(f, t, .04); v.sub.frequency.setTargetAtTime(f / 2, t, .04);
      v.filter.frequency.setTargetAtTime(300 + (900 + n.car.controls.throttle * 1800) / (1 + dist * .05), t, .1);
      v.pan.pan.setTargetAtTime(clamp((-dx * Math.cos(car.yaw) + dz * Math.sin(car.yaw)) / dist, -1, 1), t, .08);
    }
  }
}
