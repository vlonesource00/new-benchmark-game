// Recording-based engine playback. No pipe resonators or oscillator engine core.
// Three overlapping RPM layers retain the irregular texture of the recordings;
// interpolation, smoothed load and a broad low-pass keep shifts and lifts continuous.
const clamp = (x, a, b) => Math.min(b, Math.max(a, Number.isFinite(x) ? x : a));
export const SAMPLE_PARAMS = { rpm: 900, throttle: 0, level: 0, doppler: 1, cut: 0, stutter: 0, boost: 0 };

export function recordingFor(id) {
  if (id === 'gt-v8-cross') return 'v8';
  if (id === 'gt-f6') return 'flat';
  if (id.includes('-tt')) return 'turbo';
  return 'race';
}

export class RecordedEngineDSP {
  constructor(sr, mode, seed, recordings) {
    this.sr = sr; this.mode = mode; this.recordings = recordings;
    this.positions = [(seed * 0.137) % 1, (seed * 0.271) % 1, (seed * 0.419) % 1];
    this.weights = [0, 0, 0]; this.rates = [0, 0, 0]; this.maps = [null, null, null]; this.nextMaps = [null, null, null]; this.mipMix = [0, 0, 0];
    this.level = 0; this.load = 0; this.rpm = 900; this.lp = 0; this.lp2 = 0; this.intake = 0; this.limiterPhase = 0;
  }
  setProfile(p, live = false) {
    const key = recordingFor(p.id);
    if (key !== this.key) { this.key = key; this.level = 0; this.lp = this.lp2 = this.intake = 0; }
    this.p = p; this.layers = this.recordings[key];
    if (!live) this.rpm = p.idle;
  }
  render(L, R, I, n, params) {
    const p = this.p, layers = this.layers;
    const target = clamp(params.level, 0, 4);
    if (!p || !layers || (target < 1e-6 && this.level < 1e-6)) {
      L.fill(0); R?.fill(0); I?.fill(0); this.level = 0; return;
    }
    const rpm = clamp(params.rpm, p.idle * 0.7, p.redline * 1.2), load = clamp(params.throttle, 0, 1);
    const fraction = clamp((rpm - p.idle) / (p.redline - p.idle), 0, 1);
    // Normalised triangular weights sum to one, including the end layers.
    let sum = 0;
    for (let k = 0; k < 3; k++) { this.weights[k] = Math.max(0, 1 - Math.abs(fraction - layers[k].fraction) / 0.5); sum += this.weights[k]; }
    const doppler = clamp(params.doppler, 0.5, 2);
    for (let k = 0; k < 3; k++) {
      this.weights[k] /= sum || 1;
      const playback = clamp((rpm * p.cyl / 120) / layers[k].firingHz * doppler, 0.125, 16);
      const nativeRate = playback * layers[k].sr / this.sr;
      const lod = Math.max(0, Math.log2(nativeRate)), mip = Math.min(layers[k].mips.length - 1, Math.floor(lod));
      this.maps[k] = layers[k].mips[mip];
      this.nextMaps[k] = layers[k].mips[Math.min(mip + 1, layers[k].mips.length - 1)];
      this.mipMix[k] = Math.min(1, lod - mip);
      this.rates[k] = nativeRate / layers[k].data.length;
    }
    // Broad absorption only: deliberately no high-Q exhaust/airbox combs.
    const brightness = clamp((p.exhLP ?? 6000) / 6000, 0.5, 1.6);
    const hz = Math.min(this.sr * 0.2 / Math.max(1, doppler), (1700 + load * 4700 + fraction * 900) * brightness);
    const filter = 1 - Math.exp(-2 * Math.PI * hz / this.sr);
    const smoothing = 1 - Math.exp(-1 / (0.012 * this.sr));
    const cut = 1 - clamp(params.cut, 0, 1) * 0.92;
    const gain = clamp(p.gain ?? 1, 0.1, 2) * (this.mode === 'field' ? 0.7 : 1);
    for (let i = 0; i < n; i++) {
      this.level += (target - this.level) * smoothing;
      this.load += (load - this.load) * smoothing;
      let x = 0;
      for (let k = 0; k < 3; k++) {
        const data = this.maps[k], len = data.length, pos = this.positions[k] * len;
        const a = Math.floor(pos), f = pos - a;
        const first = data[a] + (data[(a + 1) % len] - data[a]) * f;
        const next = this.nextMaps[k], secondPos = this.positions[k] * next.length, b = Math.floor(secondPos);
        const second = next[b] + (next[(b + 1) % next.length] - next[b]) * (secondPos - b);
        x += (first + (second - first) * this.mipMix[k]) * this.weights[k];
        this.positions[k] = (this.positions[k] + this.rates[k]) % 1;
      }
      this.lp += (x - this.lp) * filter; this.lp2 += (this.lp - this.lp2) * filter;
      this.limiterPhase = (this.limiterPhase + 24 / this.sr) % 1;
      const limiter = params.stutter > 0.5 ? (this.limiterPhase < 0.4 ? 0.18 : 1) : 1;
      const y = this.lp2 * this.level * gain * (0.38 + this.load * 0.62) * cut * limiter;
      L[i] = y; if (R) R[i] = y;
      this.intake += (this.lp2 - this.intake) * 0.045;
      if (I) I[i] = (this.lp2 - this.intake) * this.level * this.load * 0.12 * clamp(p.intake ?? 0.5, 0, 2);
    }
    this.rpm = rpm;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('recorded-engine', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return Object.entries(SAMPLE_PARAMS).map(([name, defaultValue]) => ({ name, defaultValue, minValue: 0, maxValue: name === 'rpm' ? 20000 : name === 'level' ? 4 : 2, automationRate: 'k-rate' }));
    }
    constructor(options) {
      super(); const o = options.processorOptions;
      this.dsp = new RecordedEngineDSP(sampleRate, o.mode, o.seed, o.recordings); this.dsp.setProfile(o.profile);
      this.params = { ...SAMPLE_PARAMS }; this.stopped = false;
      this.port.onmessage = ({ data }) => {
        if (data.dispose) this.stopped = true;
        else if (data.profile) this.dsp.setProfile(data.profile, data.live);
      };
    }
    process(_inputs, outputs, params) {
      if (this.stopped) return false;
      for (const k in this.params) this.params[k] = params[k][0];
      const out = outputs[0];
      this.dsp.render(out[0], out[1] ?? null, outputs[1]?.[0] ?? null, out[0].length, this.params);
      return true;
    }
  });
}
