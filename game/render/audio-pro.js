import { clamp } from '../engine/sim/math.js';

// Procedural racing audio: a V8-style engine built from firing-order harmonic
// tables (exhaust + intake + mechanical layers through a soft-clip shaper),
// turbo spool / blow-off, tonal tyre squeal, road and wind beds, a generated
// convolution reverb, per-circuit ambience and Doppler-shifted rivals.
//
// Mix: focus car (engine + tyres/road) -> carMix -> air filter -> dry, with its
// own reverb send; rivals, ambience and broadcast UI each have a bus. The car's
// level, air absorption and reverb follow the camera distance, so onboard is
// close and dry while a TV replay camera hears the car far off and roomy.
// Rivals and ambience duck under the focus engine at full load.
const RPM_MIN = 1100, RPM_MAX = 8300;
const AMBIENCE = {
  'harbor-ring': { crowd: .5, sea: .45, seaHz: 380, gulls: true, horn: true },
  solenne: { crowd: .75, sea: 0, seaHz: 380, gulls: false, horn: false },
  alpine: { crowd: .32, sea: .28, seaHz: 900, gulls: false, horn: false },
  desert: { crowd: .4, sea: .22, seaHz: 650, gulls: false, horn: false },
};

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
  constructor() { this.volume = .4; this.enabled = true; this.trackId = 'harbor-ring'; this.camDistance = 6; this.nextBeep = 0; }

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
    // Buses.
    this.carMix = c.createGain();
    this.carAir = c.createBiquadFilter(); this.carAir.type = 'lowpass'; this.carAir.frequency.value = 16000; this.carAir.Q.value = .5;
    this.carSend = c.createGain(); this.carSend.gain.value = 0;
    this.carMix.connect(this.carAir); this.carAir.connect(this.dry); this.carAir.connect(this.carSend); this.carSend.connect(this.send);
    this.rivalBus = c.createGain(); this.rivalBus.connect(this.dry);
    this.uiBus = c.createGain(); this.uiBus.gain.value = .8; this.uiBus.connect(this.master);

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
    this.engineCut = c.createGain(); this.engineTone.connect(this.engineCut);
    this.engineCut.connect(this.carMix); this.engineCut.connect(this.send);
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
    this.intake = this.noiseLayer('bandpass', 700, 1.4, this.carMix);
    // Mechanical whine: straight-cut gears.
    this.gearOsc = c.createOscillator(); this.gearOsc.type = 'triangle'; this.gearGain = c.createGain(); this.gearGain.gain.value = 0;
    this.gearOsc.connect(this.gearGain); this.gearGain.connect(this.carMix); this.gearOsc.start();
    this.gearOsc2 = c.createOscillator(); this.gearOsc2.type = 'sine'; const g2 = c.createGain(); g2.gain.value = .45;
    this.gearOsc2.connect(g2); g2.connect(this.gearGain); this.gearOsc2.start();
    // Turbo whistle and wastegate chatter.
    this.turbo = c.createOscillator(); this.turbo.type = 'sine'; this.turboGain = c.createGain(); this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain); this.turboGain.connect(this.carMix); this.turboGain.connect(this.send); this.turbo.start();
    this.boost = 0;

    // Tyres: two resonant bands give a tonal squeal instead of hiss.
    this.squealA = this.noiseLayer('bandpass', 950, 14, this.carMix);
    this.squealB = this.noiseLayer('bandpass', 1900, 10, this.carMix);
    this.scrub = this.noiseLayer('bandpass', 600, 1.2, this.carMix);
    this.wind = this.noiseLayer('lowpass', 500, .6, this.carMix, true);
    this.road = this.noiseLayer('lowpass', 160, 1.1, this.carMix, true);
    // Kerb rumble strip: each ridge is a thud (brown noise + a resonant body
    // note) with a plastic/metal rattle on top, gated by an LFO at the ridge rate.
    this.kerbGain = c.createGain(); this.kerbGain.gain.value = 0; this.kerbGain.connect(this.carMix);
    this.kerbAm = c.createGain(); this.kerbAm.gain.value = .5; this.kerbAm.connect(this.kerbGain);
    this.kerb = c.createOscillator(); this.kerb.type = 'sawtooth';
    const kerbDepth = c.createGain(); kerbDepth.gain.value = -.5; this.kerb.connect(kerbDepth); kerbDepth.connect(this.kerbAm.gain); this.kerb.start();
    const body = this.noiseLayer('lowpass', 320, 1.6, this.kerbAm, true); body.gain.gain.value = 1.6;
    this.kerbRattle = this.noiseLayer('bandpass', 1300, 2.2, this.kerbAm); this.kerbRattle.gain.gain.value = .35;
    this.kerbNote = c.createOscillator(); this.kerbNote.type = 'triangle'; this.kerbNote.frequency.value = 88;
    const noteGain = c.createGain(); noteGain.gain.value = .5; this.kerbNote.connect(noteGain); noteGain.connect(this.kerbAm); this.kerbNote.start();
    this.gravel = this.noiseLayer('highpass', 900, .7, this.carMix);

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
      o.connect(sh); sub.connect(subGain); subGain.connect(sh); sh.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.rivalBus); gain.connect(this.send);
      o.start(); sub.start(); return { o, sub, gain, pan, filter, id: null };
    });
    this.lastGear = null; this.lastImpact = 0; this.lastThrottle = 0; this.lastPop = -1; this.wasRunning = false; this.cutUntil = 0;
    this.nextGull = c.currentTime + 3; this.nextHorn = c.currentTime + 14; this.nextPa = c.currentTime + 40; this.lastZone = 'asphalt';
    this.setTrack(this.trackId);
    await c.resume();
  }

  noiseLayer(type, frequency, q, dest, brown = false) {
    const c = this.ctx, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = brown ? this.brownBuffer : this.noiseBuffer; source.loop = true; source.loopStart = Math.random();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.value = 0;
    source.connect(filter); filter.connect(gain); gain.connect(dest); source.start(0, Math.random() * 2); return { gain, filter };
  }
  burst(type, from, to, strength, duration, q = 1, dest = this.carMix, brown = false) {
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
  /** Gearbox clunk: a dog-ring thud with a metallic click; onboard adds the paddle tick. */
  clunk(at, strength, onboard) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(95, at); o.frequency.exponentialRampToValueAtTime(48, at + .07);
    g.gain.setValueAtTime(.0001, at); g.gain.linearRampToValueAtTime(strength * (onboard ? 1.4 : .9), at + .003); g.gain.exponentialRampToValueAtTime(.0005, at + .09);
    o.connect(g); g.connect(this.carMix); o.start(at); o.stop(at + .11); o.onended = () => { o.disconnect(); g.disconnect(); };
    setTimeout(() => {
      if (!this.ctx) return;
      this.burst('bandpass', 2600, 1800, strength * (onboard ? .55 : .3), .04, 6);
      this.burst('lowpass', 600, 150, strength * .6, .06, 1, this.carMix, true);
      if (onboard) this.tone([3200], .03, .001, .02, 'square', .7, this.carMix);
    }, Math.max(0, (at - c.currentTime) * 1000));
  }
  bang(strength) {
    this.burst('lowpass', 900, 120, strength, .11, .7, this.carMix, true);
    this.burst('bandpass', 2400, 600, strength * .5, .06, 1.2);
  }
  /**
   * Exhaust backfire. `distance` 0 is the focus car; rivals fade with range and
   * are panned. Kinds: 'bang' (lift-off: boom, crack and a wall slap), 'shift'
   * (sharp upshift crack) and 'crackle' (overrun: a rapid volley of 2-4 pops).
   */
  backfire(strength, kind, distance = 0, pan = 0) {
    if (!this.ctx || !this.enabled) return;
    const k = strength / (1 + distance * .06);
    if (k < .012) return;
    const c = this.ctx, now = c.currentTime, out = c.createStereoPanner(), drive = shaper(c, 3.2), trim = c.createGain();
    out.pan.value = pan; trim.gain.value = .9;
    drive.connect(trim); trim.connect(out); out.connect(distance > 0 ? this.rivalBus : this.carMix);
    if (distance < 40) trim.connect(this.send);
    const big = kind === 'bang', shift = kind === 'shift';
    const nodes = [drive, trim, out];
    const thump = (t, from, to, gain, dur, dest = drive) => {
      const o = c.createOscillator(), g = c.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + dur * .8);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(gain, t + .002); g.gain.exponentialRampToValueAtTime(.0005, t + dur);
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + .02); o.onended = () => { o.disconnect(); g.disconnect(); };
    };
    const noise = (t, type, from, to, gain, dur, q, brown, dest = drive) => {
      const src = c.createBufferSource(), f = c.createBiquadFilter(), gg = c.createGain();
      src.buffer = brown ? this.brownBuffer : this.noiseBuffer; f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
      gg.gain.setValueAtTime(.0001, t); gg.gain.linearRampToValueAtTime(Math.max(.001, gain), t + .0015); gg.gain.exponentialRampToValueAtTime(.0005, t + dur);
      src.connect(f); f.connect(gg); gg.connect(dest);
      src.start(t, Math.random() * 2); src.stop(t + dur + .02); src.onended = () => { src.disconnect(); f.disconnect(); gg.disconnect(); };
    };
    const pop = (t, g, size) => {
      thump(t, 120 + Math.random() * 40, 55, g * .6 * size, .08 * size);
      noise(t, 'lowpass', 1300, 140, g * .5, .07 + .05 * size, .8, true);
      noise(t, 'bandpass', 2600 + Math.random() * 1400, 800, g * .42, .045, 1.4, false);
      noise(t, 'highpass', 5600, 3200, g * (distance > 30 ? .06 : .2), .022, .7, false);
    };
    let tail = .35;
    if (big) {
      // Boom: deep pitch-dropping sub plus a heavy body, then the crack.
      thump(now, 82, 30, k * 1.1, .32);
      noise(now, 'lowpass', 1800, 90, k * .8, .26, .7, true);
      noise(now, 'bandpass', 2400, 600, k * .55, .1, 1.2, false);
      noise(now, 'highpass', 5200, 2600, k * (distance > 30 ? .08 : .25), .035, .7, false);
      // Wall slap: a darker, delayed copy of the crack off the barriers/grandstand.
      if (distance < 60) {
        const slap = c.createBiquadFilter(); slap.type = 'lowpass'; slap.frequency.value = 2200; slap.connect(out); nodes.push(slap);
        const at = now + .06 + Math.random() * .035;
        noise(at, 'bandpass', 1800, 500, k * .28, .12, 1, false, slap);
        noise(at, 'lowpass', 900, 120, k * .25, .14, .7, true, slap);
      }
      // Secondary pops right behind the main bang.
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) pop(now + .07 + i * (.035 + Math.random() * .05), k * (.45 - i * .08), .8);
      tail = .6;
    } else if (shift) {
      // Upshift crack: short, sharp and bright.
      thump(now, 160, 70, k * .55, .06);
      noise(now, 'bandpass', 3400, 900, k * .55, .05, 1.6, false);
      noise(now, 'highpass', 6000, 3600, k * (distance > 30 ? .07 : .26), .02, .7, false);
      noise(now, 'lowpass', 1100, 160, k * .35, .07, .8, true);
    } else {
      // Overrun crackle: a volley of 2-4 pops 15-50 ms apart, the first the loudest.
      const n = 2 + Math.floor(Math.random() * 3);
      let at = now;
      for (let i = 0; i < n; i++) { pop(at, k * (1 - i * .18), 1 - i * .15); at += .015 + Math.random() * .035; }
      tail = .4;
    }
    setTimeout(() => nodes.forEach((x) => x.disconnect()), (tail + .6) * 1000);
  }

  /** Swaps the ambience bed for the circuit: harbour sea and gulls, grandstands, alpine or desert wind. */
  setTrack(id) {
    this.trackId = AMBIENCE[id] ? id : 'harbor-ring';
    if (!this.ctx) return;
    const a = AMBIENCE[this.trackId], t = this.ctx.currentTime;
    this.crowd.gain.gain.setTargetAtTime(a.crowd, t, .5);
    this.sea.gain.gain.setTargetAtTime(a.sea, t, .5);
    this.sea.filter.frequency.setTargetAtTime(a.seaHz, t, .5);
  }

  /** A slow noise swell: crowd roar, cheers. */
  swell(freq, q, strength, attack, duration, dest = this.ambience) {
    const c = this.ctx, t = c.currentTime, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noiseBuffer; src.loop = true; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(strength, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + duration);
    src.connect(f); f.connect(g); g.connect(dest); src.start(t, Math.random() * 2); src.stop(t + duration + .05);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
  }

  /** Broadcast and race-control cues: start lights, flag, graphics stings, menu clicks. */
  cue(name) {
    if (!this.ctx || !this.enabled) return;
    const ui = this.uiBus;
    if (name === 'light') this.tone([880], .07, .005, .2, 'square', 1, ui);
    else if (name === 'go') { this.tone([1760], .08, .005, .55, 'square', 1, ui); this.swell(900, .7, .5, 1.2, 4.5); }
    else if (name === 'final') { this.tone([1318, 2637], .05, .002, 1.6, 'sine', 1, ui); setTimeout(() => this.ctx && this.tone([1318, 2637], .04, .002, 1.4, 'sine', 1, ui), 420); }
    else if (name === 'flag') { this.swell(850, .6, .9, 1.5, 7); this.swell(2200, 1.2, .25, .6, 5); this.tone([233, 294], .05, .05, 1.6, 'sawtooth', 1, this.ambience); }
    else if (name === 'fastest') { this.tone([1046.5], .035, .004, .35, 'sine', 1, ui); setTimeout(() => this.ctx && this.tone([1568], .035, .004, .5, 'sine', 1, ui), 120); }
    else if (name === 'sting') this.burst('highpass', 900, 5200, .025, .32, .7, ui);
    else if (name === 'click') this.tone([2400], .025, .001, .035, 'triangle', .6, ui);
    else if (name === 'wipe') this.burst('bandpass', 400, 4800, .08, .5, .9, ui);
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(this.enabled ? v : 0, this.ctx.currentTime, .08); }
  toggle() { this.enabled = !this.enabled; this.setVolume(this.volume); return this.enabled; }

  /**
   * `view.distance` is the camera's distance to the focus car in metres (0 =
   * onboard); `view.pitLane` sounds the pit-limiter beep.
   */
  update(car, running, cars = [], view = {}) {
    if (!this.ctx || !car) return;
    const c = this.ctx, t = c.currentTime, thr = car.controls.throttle, rpm = clamp(car.rpm, RPM_MIN, RPM_MAX), load = running ? thr : 0;
    const norm = (rpm - RPM_MIN) / (RPM_MAX - RPM_MIN), fire = rpm / 60 * 4; // V8: four firing events per crank revolution
    // Camera-aware mix: level, air absorption and room follow the camera distance.
    const d = this.camDistance += ((view.distance ?? 6) - this.camDistance) * .2, inside = d < 2.5;
    this.carMix.gain.setTargetAtTime(clamp(1.12 / (1 + Math.max(0, d - 3) * .018), .22, 1.12), t, .05);
    this.carAir.frequency.setTargetAtTime(inside ? 7000 : 1800 + 15000 / (1 + Math.max(0, d - 4) * .05), t, .08);
    this.carSend.gain.setTargetAtTime(clamp((d - 4) / 90, 0, .55), t, .1);
    // Ducking: ambience and rivals sit under the focus engine at load.
    const duck = load * (.4 + norm * .6);
    this.ambience.gain.setTargetAtTime((inside ? .035 : .05 + clamp(d / 160, 0, .09)) * (1 - duck * .45), t, .25);
    this.rivalBus.gain.setTargetAtTime((inside ? .75 : 1) * (1 - duck * .3), t, .1);
    if (running && view.pitLane && t > this.nextBeep) { this.tone([1480], .02, .003, .07, 'square', 1, this.uiBus); this.nextBeep = t + .5; }

    const idle = running ? 1 : .55;
    this.engineBus.gain.setTargetAtTime((.16 + load * .5 + norm * .12) * idle, t, .03);
    // Rev limiter: the ignition cuts in and out at ~18 Hz while the driver holds it flat on the limiter.
    const limiting = running && car.rpm > 8050 && thr > .8;
    if (limiting && t > this.cutUntil) {
      const g = this.engineCut.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      for (let i = 0; i < 3; i++) { const a = t + i / 18; g.linearRampToValueAtTime(.28, a + .006); g.linearRampToValueAtTime(1, a + .03); }
      if (Math.random() < .35) this.backfire(.18 + Math.random() * .12, 'crackle');
      this.cutUntil = t + 3 / 18;
    }
    for (const v of this.engine) v.o.frequency.setTargetAtTime(fire / 4 * v.mult * 2, t, .02);
    this.engineTone.frequency.setTargetAtTime(380 + norm * 2600 + load * 2400, t, .03);
    this.engineBody.gain.setTargetAtTime(3 + (1 - norm) * 5, t, .1);
    this.rasp.gain.gain.setTargetAtTime(load * (.05 + norm * .1), t, .03);
    this.rasp.filter.frequency.setTargetAtTime(1600 + norm * 2400, t, .05);
    this.raspMod.frequency.setTargetAtTime(fire, t, .02);
    this.intake.gain.gain.setTargetAtTime(load * norm * .12, t, .04);
    this.intake.filter.frequency.setTargetAtTime(450 + norm * 1100, t, .05);

    const speed = clamp(car.speed / 75, 0, 1), on = running ? 1 : 0;
    this.gearGain.gain.setTargetAtTime(on * speed * .032 * (1.25 - thr * .55), t, .05);
    this.gearOsc.frequency.setTargetAtTime(160 + car.speed * 21, t, .04);
    this.gearOsc2.frequency.setTargetAtTime((160 + car.speed * 21) * 2.02, t, .04);
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
    this.wind.gain.gain.setTargetAtTime(on * speed * speed * (inside ? .6 : .45), t, .15);
    this.wind.filter.frequency.setTargetAtTime(300 + car.speed * 14, t, .2);
    this.road.gain.gain.setTargetAtTime(on * .25 * speed, t, .05);
    const kerb = car.zone === 'kerb' && running;
    this.kerbGain.gain.setTargetAtTime(kerb ? .34 * speed + .06 : 0, t, .015);
    const ridge = clamp(car.speed / .5, 6, 85);
    this.kerb.frequency.setTargetAtTime(ridge, t, .03);
    this.kerbNote.frequency.setTargetAtTime(70 + speed * 45, t, .05);
    this.kerbRattle.filter.frequency.setTargetAtTime(1000 + speed * 900, t, .05);
    this.kerbRattle.gain.gain.setTargetAtTime(.25 + speed * .35, t, .05);
    this.gravel.gain.gain.setTargetAtTime(on && car.zone !== 'asphalt' && car.zone !== 'kerb' ? speed * .32 + .03 : 0, t, .05);

    if (running && this.wasRunning) {
      if (car.gear !== this.lastGear && car.speed > 5) {
        const g = this.engineCut.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
        if (car.gear > this.lastGear) {
          // Upshift: ignition cut, then the dog ring slams home.
          g.linearRampToValueAtTime(.1, t + .008); g.setValueAtTime(.1, t + .055); g.linearRampToValueAtTime(1, t + .085);
          this.clunk(t + .05, .2, inside);
        } else {
          // Downshift: auto-blip flares the revs, clunk as the lower gear engages.
          g.linearRampToValueAtTime(1.7, t + .02); g.setTargetAtTime(1, t + .09, .04);
          this.engineTone.frequency.setValueAtTime(this.engineTone.frequency.value, t);
          this.engineTone.frequency.linearRampToValueAtTime(5200, t + .03); this.engineTone.frequency.setTargetAtTime(380 + norm * 2600, t + .1, .05);
          this.burst('bandpass', 2600, 1500, .05, .08, 1.2, this.carMix);
          this.clunk(t + .04, .15, inside);
        }
        this.cutUntil = t + .12;
      }
      if (car.impact > this.lastImpact + .015) {
        const k = clamp(car.impact * .8, .1, .6);
        this.burst('lowpass', 1400, 90, k, .35, .8, this.dry, true); this.burst('highpass', 3500, 1800, k * .4, .5, .6);
      }
      // Blow-off valve; the pops themselves come from backfire() (render/exhaust.js).
      if (this.lastThrottle > .65 && thr < .2 && rpm > 4800 && this.boost > .25) this.burst('bandpass', 3800, 1400, .1 * this.boost + .03, .45, 2.5);
    }
    if (kerb && this.lastZone !== 'kerb') { this.burst('lowpass', 700, 70, .32 * speed + .08, .2, 1.2, this.carMix, true); this.burst('bandpass', 1400, 500, .1 * speed + .03, .1, 1.5); }
    if (!kerb && this.lastZone === 'kerb' && running) this.burst('lowpass', 500, 90, .16 * speed + .04, .12, 1, this.carMix, true);
    this.lastZone = car.zone; this.lastGear = car.gear; this.lastImpact = car.impact; this.lastThrottle = thr; this.wasRunning = running;

    // Ambient events.
    const amb = AMBIENCE[this.trackId];
    if (amb.gulls && t > this.nextGull) {
      const n = 1 + Math.floor(Math.random() * 3), p = Math.random() * 1.6 - .8;
      for (let i = 0; i < n; i++) setTimeout(() => this.ctx && this.tone([2100 + Math.random() * 500, 2900], .006, .02, .28, 'triangle', .62, this.ambience, p), i * 230);
      this.nextGull = t + 5 + Math.random() * 9;
    }
    if (amb.horn && t > this.nextHorn) { this.tone([92, 138.5], .05, .6, 3.2, 'sawtooth', .995, this.ambience, -.5); this.nextHorn = t + 50 + Math.random() * 60; }

    // Circuit PA chime.
    if (running && t > this.nextPa) { [659, 523, 784].forEach((f, i) => setTimeout(() => this.ctx && this.tone([f], .018, .02, .9, 'sine', 1, this.ambience, .4), i * 340)); this.nextPa = t + 70 + Math.random() * 70; }

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
