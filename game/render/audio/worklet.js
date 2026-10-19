// Race audio DSP: the engine voice and the master-bus dynamics.
//
// Runs as AudioWorklet processors. The same classes are imported on the main
// thread for the ScriptProcessor fallback (insecure origins have no
// AudioWorklet), for rendering one-shot assets and for offline tests, so this
// file stays self-contained: no imports, and registration is guarded.
//
// Engine model (per voice):
//   crank phase -> firing events in the profile's firing order (each tagged
//   with its cylinder bank) -> a smooth exhaust pressure pulse per event whose
//   width follows the crank angle (so the spectrum scales with rpm) and whose
//   height follows combustion (load, idle demand, fuel cut, ignition cut) ->
//   per-bank waveguides: a header pipe and a tailpipe (fractional delay lines
//   with lossy, inverting open-end reflections; gas temperature, and so the
//   pipe resonances, rise with load and rpm) -> soft saturation, muffler body
//   and a load-dependent tone filter.
// A second path sums intake suction pulses through the airbox formants, plus
// turbo whistle and valvetrain orders. Everything is pulse-driven, so there is
// no free-running noise: a silent engine outputs exact zeros.

const SHAPE_N = 1024;
const RING = 4096, RING_MASK = RING - 1;

export function rng(seed = 1) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Asymmetric raised-cosine pulse: quick rise, slower fall, C1-smooth so it stays band-limited. */
function shapeTable(attack) {
  const t = new Float32Array(SHAPE_N + 2);
  for (let i = 0; i < t.length; i++) {
    const x = Math.min(1, i / SHAPE_N);
    t[i] = x < attack ? 0.5 - 0.5 * Math.cos(Math.PI * x / attack) : 0.5 + 0.5 * Math.cos(Math.PI * (x - attack) / (1 - attack));
  }
  return t;
}
const BLOW = shapeTable(0.1), SUCK = shapeTable(0.5);
/** Afterfire shock front (N-wave): snap to +1, straight fall through zero to -0.6, recover. */
const NWAVE = (() => {
  const t = new Float32Array(SHAPE_N + 2);
  for (let i = 0; i < t.length; i++) { const u = Math.min(1, i / SHAPE_N) * 1.2; t[i] = u < 0.06 ? Math.sin(Math.PI * 0.5 * u / 0.06) : u < 0.5 ? 1 - 1.6 * (u - 0.06) / 0.44 : -0.6 * (0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, (u - 0.5) / 0.7))); }
  return t;
})();

/** RBJ biquad, transposed direct form II. */
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, freq, q, sr, gainDb = 0) {
    const w = 2 * Math.PI * Math.min(freq, sr * 0.45) / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; } // peaking
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  clear() { this.z1 = this.z2 = 0; }
}

/** A pipe: fractional delay line with a lossy (low-passed) reflection fed back into it. */
export class Tube {
  constructor() { this.buf = new Float32Array(RING); this.w = 0; this.lp = 0; }
  run(x, delay, refl, damp) {
    const p = this.w - delay, i = Math.floor(p), f = p - i, b = this.buf;
    const back = b[i & RING_MASK] * (1 - f) + b[(i + 1) & RING_MASK] * f;
    this.lp += (back - this.lp) * damp;
    const y = x + refl * this.lp;
    b[this.w] = y; this.w = (this.w + 1) & RING_MASK;
    return y;
  }
  clear() { this.buf.fill(0); this.lp = 0; }
}

/** Padé tanh: smooth saturation without the cost of Math.tanh. */
const soft = (x) => { if (x > 3) return 1; if (x < -3) return -1; const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const MAX_PULSES = 48;

/**
 * One engine. `mode`: 'focus' (stereo exhaust + separate intake/mechanical
 * output), 'rival' (mono, everything mixed, no valvetrain/turbo detail) or
 * 'field' (mono, the distant pack: banks summed, softer).
 */
export class EngineDSP {
  constructor(sampleRate, mode = 'focus', seed = 1) {
    this.sr = sampleRate; this.mode = mode; this.rand = rng(seed); this.seed = seed;
    this.pt = new Float64Array(MAX_PULSES); this.pw = new Float64Array(MAX_PULSES); this.pa = new Float64Array(MAX_PULSES);
    this.pb = new Int8Array(MAX_PULSES); this.pk = new Int8Array(MAX_PULSES); this.np = 0;
    this.head = [new Tube(), new Tube()]; this.tail = [new Tube(), new Tube()];
    this.muff = [new Biquad(), new Biquad()]; this.tone = [new Biquad(), new Biquad()]; this.tone2 = [new Biquad(), new Biquad()];
    this.popBoom = [new Biquad(), new Biquad()]; this.popLp = [new Biquad(), new Biquad()];
    this.dc = [0, 0, 0]; this.dcx = [0, 0, 0];
    this.f1 = new Biquad(); this.f2 = new Biquad(); this.ilp = new Biquad(); this.tw = new Biquad(); this.twHz = 0;
    this.phase = 0; this.ei = 0; this.noiseState = (seed * 747796405) >>> 0 || 7;
    this.rpm = 900; this.lvl = 0; this.load = 0; this.thr = 0; this.temp = 0.4; this.boost = 0; this.dop = 1;
    this.stut = 0; this.cutNow = 0; this.whPh = 0; this.mechPh = [0, 0, 0]; this.silent = true;
    this.setProfile(null);
  }

  noise() { let x = this.noiseState; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.noiseState = x >>> 0; return (this.noiseState / 2147483648) - 1; }

  /** `live`: a retune of the same engine, so the crank keeps turning instead of restarting. */
  setProfile(p, live = false) {
    p = p ?? DEFAULT_PROFILE;
    const keep = live && this.p && this.p.firing.length === p.firing.length;
    this.p = p;
    const r = rng(this.seed * 31 + 7);
    const n = p.firing.length;
    // Events sorted by cycle position; each cylinder keeps a fixed small strength offset (the real
    // cylinder-to-cylinder spread that puts the half orders into an engine note).
    this.evOff = new Float64Array(n); this.evBank = new Int8Array(n); this.evGain = new Float64Array(n);
    p.firing.map((deg, i) => ({ off: (deg % 720) / 720, bank: p.banks > 1 ? p.bankOf[i] : 0, g: 1 + p.cylVar * (r() * 2 - 1) }))
      .sort((a, b) => a.off - b.off)
      .forEach((e, i) => { this.evOff[i] = e.off; this.evBank[i] = e.bank; this.evGain[i] = e.g; });
    this.nEv = n; if (!keep) { this.ei = 0; this.phase = 0; }
    for (let b = 0; b < 2; b++) {
      this.muff[b].set('peaking', p.muffHz, p.muffQ ?? 1.1, this.sr, p.muffDb ?? 4);
      this.tone2[b].set('lowpass', p.exhLP * 1.6, 0.6, this.sr);
      // Afterfire boom: the tailpipe volume's lowest mode, heavily damped (one mode, not the pipe comb).
      this.popBoom[b].set('bandpass', clamp(343 / (p.tail[0] + p.tail[1]), 80, 160), 1.8, this.sr); this.popLp[b].set('lowpass', 6000, 0.7, this.sr);
    }
    this.f1.set('bandpass', p.intakeHz, 2.2, this.sr); this.f2.set('bandpass', p.intake2Hz, 3.2, this.sr);
    this.ilp.set('lowpass', 2600, 0.7, this.sr);
    this.toneHz = 0;
  }

  reset() {
    this.np = 0; this.head.forEach((t) => t.clear()); this.tail.forEach((t) => t.clear());
    [...this.muff, ...this.tone, ...this.tone2, ...this.popBoom, ...this.popLp, this.f1, this.f2, this.ilp, this.tw].forEach((b) => b.clear());
    this.dc = [0, 0, 0]; this.dcx = [0, 0, 0]; this.silent = true;
  }

  addPulse(t, w, a, bank, kind) {
    if (this.np >= MAX_PULSES) return;
    const k = this.np++; this.pt[k] = t; this.pw[k] = w; this.pa[k] = a; this.pb[k] = bank; this.pk[k] = kind;
  }

  fire(k, frac) {
    const p = this.p, R = this.rand, rf = this.rf, load = this.load;
    // Near idle the engine has to fire to keep turning; off throttle above that the ECU cuts fuel.
    const idleNeed = clamp(1 - rf / 0.16, 0, 1);
    let combust = Math.max(load, idleNeed * 0.3);
    if (load < 0.04 && rf > 0.2) combust = 0;
    let cut = false;
    if (this.cutNow > 0 && R() < this.cutNow) { cut = true; combust = 0; }
    const jitter = 1 + p.rough * (R() * 2 - 1) * (1 + 1.5 * idleNeed);
    // Long low-rpm pulses carry more energy each; scale them down so idle sits well under full song.
    const amp = (0.14 + 0.86 * combust) * (0.45 + 0.55 * clamp(rf * 1.8, 0, 1)) * this.evGain[k] * jitter;
    const period = this.sr * 120 / Math.max(300, this.rpm) / this.dop;
    const w = Math.max(10, p.blow / 720 * period * (1.25 - 0.45 * combust) * (1 + 0.1 * (R() - 0.5)));
    const bank = this.evBank[k];
    this.addPulse(frac, w, amp, bank, 0);
    if (combust > 0 && p.crack > 0) this.addPulse(frac, Math.max(5, w * 0.13), amp * p.crack * combust * (0.3 + 0.7 * rf), bank, 1);
    if (this.mode !== 'field') this.addPulse(frac, w * 2.4, -p.intake * (0.1 + 0.9 * this.thr) * (0.2 + 0.8 * rf) * jitter, 2, 0);
    // Unburnt fuel lighting in the hot pipe: on an ignition cut, and now and then on a high-rpm overrun.
    // Afterfires are explosions at the pipe exit (kind 2): they skip the pipe comb and get one damped boom instead.
    // A flame front fills the pipe, so the pulse lasts a few ms; a sub-ms one is a firecracker.
    const pop = cut ? 0.09 * p.pops * (0.3 + rf) : (combust === 0 && rf > 0.42 ? p.pops * 0.05 * (rf - 0.42) * 2 : 0);
    if (pop > 0 && R() < pop) this.addPulse(frac, this.sr * (0.0026 + R() * 0.0018), (0.3 + R() * 0.4) * (0.6 + 0.4 * rf), bank, 2);
  }

  /** Renders n samples. outR / outI may be null (mono modes). Params are block targets. */
  render(outL, outR, outI, n, prm) {
    const p = this.p, sr = this.sr;
    const lvlEnd = prm.level, rpmEnd = clamp(prm.rpm, 300, 20000);
    if (lvlEnd <= 1e-5 && this.lvl <= 1e-5) {
      if (!this.silent) this.reset();
      outL.fill(0); outR?.fill(0); outI?.fill(0);
      this.lvl = 0; this.rpm = rpmEnd; return false;
    }
    this.silent = false;
    const rpm0 = this.rpm, lvl0 = this.lvl, dRpm = (rpmEnd - rpm0) / n, dLvl = (lvlEnd - lvl0) / n;
    this.dop += (clamp(prm.doppler, 0.5, 2) - this.dop) * 0.5;
    const dop = this.dop, span = Math.max(1, p.redline - p.idle);
    const thrK = 1 - Math.exp(-1 / (0.025 * sr)), loadTarget = clamp(prm.throttle, 0, 1);
    // Exhaust gas temperature: hotter gas is faster gas, so the pipe resonances climb with load.
    const rfEnd = clamp((rpmEnd - p.idle) / span, 0, 1.1);
    this.temp += (0.25 + 0.45 * loadTarget + 0.3 * rfEnd - this.temp) * (n / sr / 1.4);
    const c = 380 + 300 * this.temp;
    const boostEnd = clamp(prm.boost ?? 0, 0, 1);
    const stutter = prm.stutter > 0.5, cutP = clamp(prm.cut, 0, 1);
    const banks = p.banks > 1 ? 2 : 1;
    const dH = [0, 0], dT = [0, 0];
    for (let b = 0; b < banks; b++) {
      dH[b] = clamp(2 * p.header[b] / c * sr / dop, 1.5, RING - 4);
      dT[b] = clamp(2 * p.tail[b] / c * sr / dop, 1.5, RING - 4);
    }
    // Tone opens with load (and with the crack of a hot, loaded exhaust).
    const toneHz = p.exhLP * (0.45 + 0.4 * this.load + 0.15 * rfEnd);
    if (Math.abs(toneHz - this.toneHz) > 15) { this.toneHz = toneHz; this.tone[0].set('lowpass', toneHz, 0.71, sr); this.tone[1].set('lowpass', toneHz, 0.71, sr); }
    const drive = p.drive * (0.55 + 0.6 * this.load), norm = 1 / (0.6 + 0.4 * drive);
    const hR = p.hRefl, tR = p.tRefl, hD = p.hDamp, tD = p.tDamp;
    const focus = this.mode === 'focus', field = this.mode === 'field';
    const spread = p.spread ?? 0.5, dcK = 1 - 2 * Math.PI * 22 / sr;
    const turbo = focus ? (p.turbo ?? 0) : 0;
    const mech = focus ? (p.mech ?? 0) : 0, orders = p.orders ?? [];
    let boost = this.boost;
    // Compressor: a narrow band of rushing air whose centre climbs with shaft speed, a faint
    // whistle riding on it. Kept in the 1.5-5 kHz band: a pure high sine reads as a fault, not a turbo.
    const twHz = turbo > 0 ? p.turboHz[0] + (p.turboHz[1] - p.turboHz[0]) * Math.max(boost, boostEnd) : 0;
    if (turbo > 0 && Math.abs(twHz - this.twHz) > 20) { this.twHz = twHz; this.tw.set('bandpass', twHz, 7, sr); }
    const gain = (p.gain ?? 1);
    let peak = 0;

    for (let i = 0; i < n; i++) {
      const rpm = this.rpm = rpm0 + dRpm * (i + 1);
      const lvl = lvl0 + dLvl * (i + 1);
      this.thr += (loadTarget - this.thr) * thrK;
      this.load = this.thr;
      this.rf = clamp((rpm - p.idle) / span, 0, 1.1);
      boost += (boostEnd - boost) * 0.0004;
      // Ignition cut: a fixed probability, or the limiter's on/off stutter.
      if (stutter) { this.stut += 13 / sr; if (this.stut >= 1) this.stut -= 1; this.cutNow = this.stut < 0.55 ? 0.92 : 0.05; }
      else this.cutNow = cutP;

      // Crank: fire every event the phase passed this sample, at its sub-sample position.
      const inc = rpm / 120 / sr * dop;
      let ph = this.phase + inc;
      while (this.ei < this.nEv && this.evOff[this.ei] <= ph) { this.fire(this.ei, (ph - this.evOff[this.ei]) / inc); this.ei++; }
      if (ph >= 1) {
        ph -= 1; this.ei = 0;
        while (this.ei < this.nEv && this.evOff[this.ei] <= ph) { this.fire(this.ei, (ph - this.evOff[this.ei]) / inc); this.ei++; }
      }
      this.phase = ph;

      // Pulses.
      let b0 = 0, b1 = 0, ia = 0, q0 = 0, q1 = 0;
      for (let j = 0; j < this.np;) {
        const t = this.pt[j], x = t / this.pw[j];
        if (x >= 1) {
          const last = --this.np;
          this.pt[j] = this.pt[last]; this.pw[j] = this.pw[last]; this.pa[j] = this.pa[last]; this.pb[j] = this.pb[last]; this.pk[j] = this.pk[last];
          continue;
        }
        const kind = this.pk[j], tab = kind === 2 ? NWAVE : this.pb[j] === 2 ? SUCK : BLOW, fi = x * SHAPE_N, ii = fi | 0;
        let v = (tab[ii] + (tab[ii + 1] - tab[ii]) * (fi - ii)) * this.pa[j];
        const bk = this.pb[j];
        if (kind === 2) { v += this.noise() * this.pa[j] * 0.25 * (1 - x); if (bk === 0) q0 += v; else q1 += v; }
        else {
          if (kind) v *= this.noise();
          if (bk === 0) b0 += v; else if (bk === 1) b1 += v; else ia += v;
        }
        this.pt[j] = t + 1; j++;
      }

      // Pipes per bank, then saturation, muffler body and tone.
      let e0 = this.tail[0].run(this.head[0].run(b0, dH[0], hR, hD), dT[0], tR, tD);
      e0 = this.tone2[0].run(this.tone[0].run(this.muff[0].run(soft(e0 * drive) * norm))) + this.popLp[0].run(q0 + this.popBoom[0].run(q0) * 1.8);
      let e1 = e0;
      if (banks > 1) {
        e1 = this.tail[1].run(this.head[1].run(b1, dH[1], hR, hD), dT[1], tR, tD);
        e1 = this.tone2[1].run(this.tone[1].run(this.muff[1].run(soft(e1 * drive) * norm))) + this.popLp[1].run(q1 + this.popBoom[1].run(q1) * 1.8);
      }
      // DC blockers.
      let x = e0; e0 = x - this.dcx[0] + dcK * this.dc[0]; this.dcx[0] = x; this.dc[0] = e0;
      if (banks > 1) { x = e1; e1 = x - this.dcx[1] + dcK * this.dc[1]; this.dcx[1] = x; this.dc[1] = e1; } else e1 = e0;

      // Intake: suction pulses through the airbox formants; turbo engines hear the compressor instead.
      let it = 0;
      if (!field) {
        const inT = ia * (turbo > 0 ? 0.35 : 1);
        it = this.ilp.run(this.f1.run(inT) * 1.2 + this.f2.run(inT) * 0.55);
        if (turbo > 0 && boost > 0.02) {
          this.whPh += this.twHz / sr; if (this.whPh >= 1) this.whPh -= 1;
          const k = turbo * boost * boost * (0.004 + 0.003 * this.load);
          it += k * (this.tw.run(this.noise()) * 2.2 + 0.25 * Math.sin(2 * Math.PI * this.whPh));
        }
        if (mech > 0) {
          const crank = rpm / 60 / sr * dop, rf2 = this.rf * this.rf;
          for (let o = 0; o < orders.length; o++) {
            let mp = this.mechPh[o] + crank * orders[o]; if (mp >= 1) mp -= 1; this.mechPh[o] = mp;
            it += Math.sin(2 * Math.PI * mp) * mech * rf2 * 0.006 / (o + 1);
          }
        }
        x = it; it = x - this.dcx[2] + dcK * this.dc[2]; this.dcx[2] = x; this.dc[2] = it;
      }

      const g = lvl * gain;
      if (focus) {
        const l = (e0 + spread * e1) * g, r = (e1 + spread * e0) * g;
        outL[i] = l; outR[i] = r; outI[i] = it * g;
        const a = l > 0 ? l : -l; if (a > peak) peak = a;
      } else {
        const m = ((e0 + e1) * 0.5 + it * 0.45) * g;
        outL[i] = m; if (outR) outR[i] = m; if (outI) outI[i] = 0;
      }
    }
    this.boost = boost; this.lvl = lvlEnd; this.peak = peak;
    return true;
  }
}

// A neutral V8 used until the main thread sends the car's profile.
const DEFAULT_PROFILE = {
  id: 'default', cyl: 8, idle: 1000, redline: 7600, banks: 2,
  firing: [0, 90, 180, 270, 360, 450, 540, 630], bankOf: [0, 1, 0, 1, 1, 0, 1, 0],
  header: [0.7, 0.72], tail: [1.8, 1.9], hRefl: 0.4, tRefl: -0.6, hDamp: 0.5, tDamp: 0.32,
  blow: 64, crack: 0.2, rough: 0.05, cylVar: 0.08, drive: 1.3, exhLP: 5200, muffHz: 110, muffDb: 4,
  intakeHz: 280, intake2Hz: 820, intake: 0.5, pops: 0.6, gain: 1
};

/**
 * Master bus: an RMS glue compressor and a lookahead peak limiter. Unlike the
 * built-in DynamicsCompressorNode it applies no automatic makeup gain, so
 * quiet passages (and the silence between sounds) are never lifted.
 */
export class MasterDSP {
  constructor(sr) {
    this.sr = sr; this.env = 0; this.gr = 1; this.lim = 1;
    this.look = Math.round(sr * 0.004); this.dl = [new Float32Array(this.look + 1), new Float32Array(this.look + 1)]; this.w = 0;
    this.rmsK = 1 - Math.exp(-1 / (0.03 * sr));
    this.atk = 1 - Math.exp(-1 / (0.008 * sr)); this.rel = 1 - Math.exp(-1 / (0.2 * sr));
    this.limAtk = 1 - Math.exp(-1 / (0.0012 * sr)); this.limRel = 1 - Math.exp(-1 / (0.09 * sr));
    this.threshold = Math.pow(10, -16 / 20); this.ratio = 2.2; this.ceiling = Math.pow(10, -1 / 20);
    this.peak = 0; this.sum = 0; this.count = 0; this.maxGr = 0;
  }
  process(L, R, oL, oR, n) {
    const th = this.threshold, inv = 1 - 1 / this.ratio, ce = this.ceiling, look = this.look;
    for (let i = 0; i < n; i++) {
      const l = L ? L[i] : 0, r = R ? R[i] : l;
      // Glue: RMS detector, gain computed in the log domain.
      this.env += (Math.max(l * l, r * r) - this.env) * this.rmsK;
      const rms = Math.sqrt(this.env);
      const want = rms > th ? Math.pow(th / rms, inv) : 1;
      this.gr += (want - this.gr) * (want < this.gr ? this.atk : this.rel);
      const gl = l * this.gr, gr = r * this.gr;
      // Limiter: gain from the incoming sample, applied to the delayed one.
      const a = Math.max(Math.abs(gl), Math.abs(gr)), need = a > ce ? ce / a : 1;
      this.lim += (need - this.lim) * (need < this.lim ? this.limAtk : this.limRel);
      const w = this.w, rd = (w + 1) % (look + 1);
      this.dl[0][w] = gl; this.dl[1][w] = gr; this.w = rd;
      let ol = this.dl[0][rd] * this.lim, or = this.dl[1][rd] * this.lim;
      // Safety: nothing past the ceiling, ever.
      if (ol > ce || ol < -ce) ol = ce * soft(ol / ce * 1.2) / soft(1.2);
      if (or > ce || or < -ce) or = ce * soft(or / ce * 1.2) / soft(1.2);
      oL[i] = ol; oR[i] = or;
      const pk = Math.max(Math.abs(ol), Math.abs(or)); if (pk > this.peak) this.peak = pk;
      this.sum += ol * ol + or * or; this.count += 2;
      const g = this.gr * this.lim; if (1 - g > this.maxGr) this.maxGr = 1 - g;
    }
  }
  meters() {
    const m = { peak: this.peak, rms: Math.sqrt(this.sum / Math.max(1, this.count)), reduction: this.maxGr };
    this.peak = 0; this.sum = 0; this.count = 0; this.maxGr = 0;
    return m;
  }
}

if (typeof registerProcessor === 'function') {
  const PARAMS = [
    ['rpm', 900, 0, 20000], ['throttle', 0, 0, 1], ['level', 0, 0, 4], ['doppler', 1, 0.5, 2],
    ['cut', 0, 0, 1], ['stutter', 0, 0, 1], ['boost', 0, 0, 1]
  ].map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'k-rate' }));

  registerProcessor('engine-voice', class extends AudioWorkletProcessor {
    static get parameterDescriptors() { return PARAMS; }
    constructor(options) {
      super();
      const o = options.processorOptions ?? {};
      this.dsp = new EngineDSP(sampleRate, o.mode ?? 'focus', o.seed ?? 1);
      if (o.profile) this.dsp.setProfile(o.profile);
      this.prm = { rpm: 900, throttle: 0, level: 0, doppler: 1, cut: 0, stutter: 0, boost: 0 };
      this.port.onmessage = (e) => { if (e.data?.dispose) this.stopped = true; else if (e.data?.profile) { this.dsp.setProfile(e.data.profile, e.data.live); if (!e.data.live) this.dsp.reset(); } };
    }
    process(inputs, outputs, params) {
      if (this.stopped) return false;
      const out = outputs[0], prm = this.prm;
      for (const k in prm) prm[k] = params[k][0];
      const L = out[0], R = out[1] ?? null, I = outputs[1]?.[0] ?? null;
      this.dsp.render(L, R, I, L.length, prm);
      return true;
    }
  });

  registerProcessor('master-dynamics', class extends AudioWorkletProcessor {
    constructor() { super(); this.dsp = new MasterDSP(sampleRate); this.frames = 0; }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0], n = out[0].length;
      this.dsp.process(inp[0] ?? null, inp[1] ?? inp[0] ?? null, out[0], out[1] ?? out[0], n);
      this.frames += n;
      if (this.frames >= sampleRate * 0.1) { this.frames = 0; this.port.postMessage(this.dsp.meters()); }
      return true;
    }
  });
}
