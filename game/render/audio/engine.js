import { clamp } from '../../engine/sim/math.js';
import { ENGINE_PROFILES, profileIdFor, engineRpm, SIM_IDLE, SIM_MAX } from './profiles.js';
import * as A from './buffers.js';
import { EngineDSP } from './worklet.js';

// Race audio pipeline.
//
//   engine voices (AudioWorklet, worklet.js) ─┐
//   tyres · surfaces · wind · contacts ───────┤ focus bus ─ air filter ─ pan ─┐
//   rival voices ─ air ─ gain ─ HRTF panner ──┤ rival bus ────────────────────┤
//   distant field voice ──────────────────────┤ field bus ────────────────────┤
//   crowd · nature · weather beds + events ───┤ ambience / weather buses ─────┼─ mix ─ master dynamics ─ volume ─ out
//   pops · impacts · pit tools ───────────────┤ fx bus ───────────────────────┤        (RMS glue + lookahead
//   broadcast/menu cues ──────────────────────┘ ui bus ───────────────────────┘         limiter, no makeup gain)
//   every bus but ui also feeds one convolution reverb built for the circuit.
//
// The listener is the camera: rivals are placed in camera space for the HRTF
// panners, Doppler comes from the source and camera velocities, distance sets
// level, air absorption and reverb. The focus car is mixed for the camera too:
// onboard hears intake, gearbox and a muffled exhaust; chase hears the
// exhaust; a TV camera hears the car far off, roomy and Doppler-shifted.
//
// Silence is silence: the context starts with the master at zero and fades in;
// engines output exact zeros when idle; every bed fades from zero; nothing
// broadband runs unless its cause (speed, slip, rain, gravel) is present.
//
// Tuning lives in three places: the engine profiles (profiles.js), LEVELS
// below (bus and layer gains), and TRACKS (per-circuit ambience and room).

const WORKLET_URL = new URL('./worklet.js', import.meta.url);
const RIVAL_VOICES = 6, MAX_ONESHOTS = 28, SOUND_SPEED = 343;

export const LEVELS = {
  engine: 0.5, intakeOnboard: 1.35, intakeOutside: 0.35, exhaustOnboard: 0.55,
  rival: 0.5, field: 0.45, tyres: 0.5, wind: 0.07, road: 0.05, surface: 0.4,
  whine: 0.009, mgu: 0.005, ambience: 0.55, ambienceMenu: 0.42, rain: 0.35,
  fx: 0.55, ui: 0.22, reverb: 0.5
};

const TRACKS = {
  'harbor-ring': { room: 'harbor', crowd: 0.55, sea: 0.55, leaves: 0, cicadas: 0, wind: 0.15, events: [['gull', 5, 14], ['horn', 55, 120], ['song', 14, 32]] },
  solenne: { room: 'stands', crowd: 0.85, sea: 0, leaves: 0.12, cicadas: 0.3, wind: 0.1, events: [['song', 8, 20], ['blackbird', 15, 35]] },
  alpine: { room: 'valley', crowd: 0.35, sea: 0, leaves: 0.3, cicadas: 0, wind: 0.32, events: [['cowbell', 14, 32], ['song', 7, 16], ['blackbird', 18, 40]] },
  desert: { room: 'open', crowd: 0.4, sea: 0, leaves: 0, cicadas: 0.12, wind: 0.45, events: [['hawk', 28, 70]] },
  nurburgring: { room: 'forest', crowd: 0.45, sea: 0, leaves: 0.45, cicadas: 0, wind: 0.2, events: [['song', 5, 12], ['blackbird', 10, 24], ['cuckoo', 25, 60]] }
};

const fin = (x, d = 0) => (Number.isFinite(x) ? x : d);
const rand = (a, b) => a + Math.random() * (b - a);
/** Level of a source `d` metres from the listener (slightly gentler than 1/d so the pack stays audible). */
const distGain = (d) => Math.pow(6 / Math.max(6, d), 0.85);
const airCutoff = (d) => clamp(20000 / (1 + Math.max(0, d - 4) / 45), 900, 20000);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/**
 * How hard a car's tyres are sliding, from the sim's combined slip (tyre.js: s = |kappa*10.5, tan(alpha)*8.6|,
 * force peaks near s 2.3). `scrub`: at and just past the limit, a low roar. `squeal`: well past it (slides,
 * lock-ups, wheelspin), the stick-slip screech. Averaged over the two worst wheels so one light wheel cannot trip it.
 */
function slideOf(car) {
  const s = [];
  for (const w of car.wheels ?? []) s.push(Math.hypot(fin(w.tyre?.kappa) * 10.5, Math.tan(clamp(fin(w.tyre?.alpha), -1.2, 1.2)) * 8.6));
  if (!s.length) return { scrub: 0, squeal: 0, s: 0 };
  s.sort((a, b) => b - a);
  const top = s.length > 1 ? (s[0] + s[1]) / 2 : s[0];
  return { scrub: smooth(1.9, 3.4, top), squeal: smooth(3, 6.5, top), s: top };
}

/** Main-thread stand-in for an AudioParam (ScriptProcessor fallback). */
class HostParam {
  constructor(v) { this.v = v; this.target = v; this.tau = 0; this.q = []; }
  get value() { return this.v; }
  setTargetAtTime(v, t, tau) { this.q.push({ t, v, tau: Math.max(1e-4, tau) }); return this; }
  setValueAtTime(v, t) { this.q.push({ t, v, tau: 0 }); return this; }
  cancelScheduledValues() { this.q.length = 0; return this; }
  read(now, dt) {
    if (this.q.length > 1) this.q.sort((a, b) => a.t - b.t);
    while (this.q.length && this.q[0].t <= now) { const e = this.q.shift(); if (e.tau === 0) { this.v = this.target = e.v; this.tau = 0; } else { this.target = e.v; this.tau = e.tau; } }
    if (this.tau > 0) this.v += (this.target - this.v) * (1 - Math.exp(-dt / this.tau));
    return this.v;
  }
}
const PARAM_DEFAULTS = { rpm: 900, throttle: 0, level: 0, doppler: 1, cut: 0, stutter: 0, boost: 0 };

export class AudioEngine {
  constructor() {
    this.volume = 0.4; this.enabled = true; this.trackId = 'harbor-ring'; this.ctx = null; this.ready = false;
    this.meters = { peak: 0, rms: 0, reduction: 0 }; this.buffers = {}; this.oneShots = 0;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) globalThis.__audio = this;
  }

  // ---------- setup ----------
  async unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return this.building; }
    // A failed build tears down so the next gesture can retry from scratch.
    this.building = this.build().catch((e) => { console.error('Audio pipeline failed to start', e); this.ctx?.close().catch(() => {}); this.ctx = null; this.ready = false; throw e; });
    return this.building;
  }

  async build() {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const c = this.ctx = new C({ latencyHint: 'interactive' });
    this.master = c.createGain(); this.master.gain.value = 0; this.master.connect(c.destination);
    this.mix = c.createGain();
    try { await c.audioWorklet.addModule(WORKLET_URL); this.worklet = true; } catch (e) { this.worklet = false; console.warn('AudioWorklet unavailable, engine runs on the main thread.', e?.message ?? e); }
    if (this.worklet) {
      this.dyn = new AudioWorkletNode(c, 'master-dynamics', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      this.dyn.port.onmessage = (e) => { this.meters = e.data; };
      this.mix.connect(this.dyn); this.dyn.connect(this.master);
    } else {
      // Built-in compressor as a limiter; trim off its automatic makeup gain (~+1.1 dB at these settings).
      const lim = c.createDynamicsCompressor(); lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
      const trim = c.createGain(); trim.gain.value = 0.877;
      this.mix.connect(lim); lim.connect(trim); trim.connect(this.master);
    }
    // Reverb.
    this.revIn = c.createGain(); this.reverb = c.createConvolver(); this.revOut = c.createGain(); this.revOut.gain.value = LEVELS.reverb;
    this.revIn.connect(this.reverb); this.reverb.connect(this.revOut); this.revOut.connect(this.mix);
    const bus = (v, dest = this.mix) => { const g = c.createGain(); g.gain.value = v; g.connect(dest); return g; };
    this.focusBus = c.createGain();
    this.carAir = c.createBiquadFilter(); this.carAir.type = 'lowpass'; this.carAir.frequency.value = 20000; this.carAir.Q.value = 0.5;
    this.carPan = c.createStereoPanner(); this.carSend = c.createGain(); this.carSend.gain.value = 0.04;
    this.focusBus.connect(this.carAir); this.carAir.connect(this.carPan); this.carPan.connect(this.mix); this.carAir.connect(this.carSend); this.carSend.connect(this.revIn);
    this.rivalBus = bus(1); this.fieldBus = bus(1); this.ambBus = bus(0); this.weatherBus = bus(1); this.fxBus = bus(LEVELS.fx); this.uiBus = bus(LEVELS.ui);
    this.ambSend = bus(0.25, this.revIn); this.ambBus.connect(this.ambSend);
    this.fxSend = bus(0.2, this.revIn); this.fxBus.connect(this.fxSend);

    this.makeAssets();
    this.buildFocus();
    this.buildRivals();
    this.buildBeds();
    this.state = { lastGear: null, lastImpact: 0, lastThr: 0, lastZone: 'asphalt', boost: 0, blipUntil: 0, pit: null, cam: null, camV: [0, 0, 0], camT: 0, d: 6, impacts: new Map(), nextEvent: {}, nextPa: 0, nextThunder: 0, lastBeep: 0, lastImpactAt: 0 };
    this.setTrack(this.trackId);
    await c.resume();
    this.ready = true; this.fadeInUntil = c.currentTime + 2.5;
    this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, c.currentTime + 0.15, 0.45);
    // The slower-to-generate beds (crowd, nature) arrive a moment later and fade in from silence.
    setTimeout(() => this.loadBeds().catch((e) => console.warn('Ambience generation failed', e)), 120);
  }

  toBuffer({ sr, ch }) {
    const b = this.ctx.createBuffer(ch.length, ch[0].length, sr);
    ch.forEach((d, i) => b.copyToChannel(d, i));
    return b;
  }

  makeAssets() {
    const sr = Math.min(48000, this.ctx.sampleRate), lo = 32000, B = this.buffers, buf = (x) => this.toBuffer(x);
    B.pink = buf(A.pinkNoise(lo, 4, 11)); B.brown = buf(A.brownNoise(lo, 4, 12));
    B.slow = buf(A.smoothRandom(3000, 8, 6, 13)); B.flutter = buf(A.smoothRandom(4000, 4, 34, 14)); B.gust = buf(A.smoothRandom(3000, 16, 0.6, 15));
    B.pop = [1, 2, 3, 4, 5, 6].map((s) => buf(A.exhaustPop(sr, s, 'pop')));
    B.bang = [7, 8, 9].map((s) => buf(A.exhaustPop(sr, s, 'bang')));
    B.crack = [10, 11, 12].map((s) => buf(A.exhaustPop(sr, s, 'shift')));
    B.clunk = [21, 22, 23].map((s) => buf(A.gearClunk(sr, s)));
    B.impactHeavy = [31, 32, 33].map((s) => buf(A.impact(sr, s, true)));
    B.impactLight = [34, 35, 36].map((s) => buf(A.impact(sr, s, false)));
    B.bov = [41, 42].map((s) => buf(A.blowOff(sr, s)));
    B.gun = [51, 52, 53].map((s) => buf(A.wheelGun(sr, s)));
    B.jackUp = buf(A.airJack(sr, 61, true)); B.jackDown = buf(A.airJack(sr, 62, false));
    B.gravel = buf(A.gravelLoop(lo, 71)); B.grass = buf(A.grassLoop(lo, 72));
  }

  /** Engine voice: an AudioWorkletNode, or a ScriptProcessor running the same DSP where worklets are unavailable. */
  makeVoice(mode, seed, profile) {
    const c = this.ctx;
    if (this.worklet) {
      const node = new AudioWorkletNode(c, 'engine-voice', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: mode === 'focus' ? [2, 1] : [1, 1], processorOptions: { mode, seed, profile } });
      const params = {}; for (const k in PARAM_DEFAULTS) params[k] = node.parameters.get(k);
      return { node, params, mode, profileId: profile.id, setProfile: (p) => node.port.postMessage({ profile: p }), out: (dest) => node.connect(dest, 0), outIntake: mode === 'focus' ? (dest) => node.connect(dest, 1) : null };
    }
    const dsp = new EngineDSP(c.sampleRate, mode, seed); dsp.setProfile(profile);
    const chans = mode === 'focus' ? 2 : 1, sp = c.createScriptProcessor(1024, 1, chans), params = {}, prm = {};
    for (const k in PARAM_DEFAULTS) params[k] = new HostParam(PARAM_DEFAULTS[k]);
    let tmp = new Float32Array(1024), last = c.currentTime;
    sp.onaudioprocess = (e) => {
      const now = c.currentTime, dt = Math.max(0.001, now - last); last = now;
      for (const k in params) prm[k] = params[k].read(now, dt);
      const L = e.outputBuffer.getChannelData(0), R = chans > 1 ? e.outputBuffer.getChannelData(1) : null;
      if (tmp.length !== L.length) tmp = new Float32Array(L.length);
      dsp.render(L, R, tmp, L.length, prm);
      if (R) for (let i = 0; i < L.length; i++) { L[i] += tmp[i] * 0.6; R[i] += tmp[i] * 0.6; }
    };
    return { node: sp, params, mode, profileId: profile.id, setProfile: (p) => { dsp.setProfile(p); dsp.reset(); }, out: (dest) => sp.connect(dest), outIntake: null };
  }

  periodic(amps) {
    const re = new Float32Array(amps.length + 1), im = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => { im[i + 1] = a; });
    return this.ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }
  loopSource(buffer, rate = 1) {
    const s = this.ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.playbackRate.value = rate;
    s.start(this.ctx.currentTime, Math.random() * buffer.duration); return s;
  }
  filter(type, f, q = 0.7) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

  buildFocus() {
    const c = this.ctx, B = this.buffers, f = this.focus = {};
    const profile = ENGINE_PROFILES['gt-v8-cross'];
    f.voice = this.makeVoice('focus', 1, profile); f.profile = profile;
    f.exhIn = this.gain(1); f.cabin = this.filter('lowpass', 20000, 0.6); f.exhGain = this.gain(1);
    f.voice.out(f.exhIn); this.chain(f.exhIn, f.cabin, f.exhGain, this.focusBus);
    f.intake = this.gain(LEVELS.intakeOutside); f.voice.outIntake?.(f.intake); f.intake.connect(this.focusBus);
    // Gearbox (straight-cut gears follow the engine) and final drive (follows the wheels).
    const whine = this.periodic([1, 0.3, 0.12]);
    f.gearOsc = c.createOscillator(); f.gearOsc.setPeriodicWave(whine); f.diffOsc = c.createOscillator(); f.diffOsc.setPeriodicWave(whine);
    f.whine = this.gain(0); const diffMix = this.gain(0.6);
    f.gearOsc.connect(f.whine); f.diffOsc.connect(diffMix); diffMix.connect(f.whine); f.whine.connect(this.focusBus);
    f.gearOsc.start(); f.diffOsc.start();
    // Hybrid motor-generator.
    f.mguOsc = c.createOscillator(); f.mguOsc.setPeriodicWave(this.periodic([1, 0, 0.1])); f.mgu = this.gain(0);
    this.chain(f.mguOsc, this.filter('lowpass', 2200, 0.5), f.mgu, this.focusBus); f.mguOsc.start();
    // Tyres. Squeal is the tread's stick-slip ringing the carcass: two narrow resonances excited by
    // noise (never a steady oscillator, which reads as a whistle), their centres wandering, the level
    // fluttering with the slip. Scrub is the broad low roar of a tyre working at its limit.
    f.squeal = [0, 1].map((k) => this.squealVoice(k, this.focusBus));
    f.scrubLp = this.filter('lowpass', 700, 0.7); f.scrub = this.gain(0);
    this.chain(this.loopSource(B.pink, 1), this.filter('highpass', 140, 0.7), f.scrubLp, f.scrub, this.focusBus);
    // Rolling roar and off-track rumble.
    f.roadLp = this.filter('lowpass', 160, 0.8); f.road = this.gain(0); this.chain(this.loopSource(B.brown), f.roadLp, f.road, this.focusBus);
    // Kerb: the ridges' buzz (a tone at the ridge rate through the car's body) with a rattle gated by it.
    f.kerbOsc = c.createOscillator(); f.kerbOsc.setPeriodicWave(this.periodic(Array.from({ length: 12 }, (_, k) => 1 / (k + 1) ** 1.1)));
    f.kerb = this.gain(0); this.chain(f.kerbOsc, this.filter('lowpass', 380, 1.4), this.filter('peaking', 95, 1), f.kerb, this.focusBus);
    f.kerbRattle = this.gain(0); const rattleAm = this.gain(0); f.kerbOsc.connect(rattleAm.gain);
    this.chain(this.loopSource(B.pink, 0.9), this.filter('bandpass', 1500, 2), rattleAm, f.kerbRattle, this.focusBus);
    f.kerbOsc.start();
    f.gravel = this.gain(0); f.gravelSrc = this.loopSource(B.gravel); this.chain(f.gravelSrc, f.gravel, this.focusBus);
    f.grass = this.gain(0); f.grassSrc = this.loopSource(B.grass); this.chain(f.grassSrc, f.grass, this.focusBus);
    // Wet: the spray off the tyres.
    f.spray = this.gain(0); this.chain(this.loopSource(B.pink, 0.8), this.filter('bandpass', 1500, 0.5), this.filter('lowpass', 5200, 0.7), f.spray, this.focusBus);
    // Wind over the car/helmet, gusting.
    f.windLp = this.filter('lowpass', 300, 0.6); f.wind = this.gain(0); f.windGust = this.gain(0);
    this.chain(this.loopSource(B.pink, 0.7), f.windLp, this.filter('highpass', 90, 0.7), f.wind, this.focusBus);
    this.loopSource(B.gust).connect(f.windGust); f.windGust.connect(f.wind.gain);
  }

  /** One tyre-squeal voice: pink noise through two cascaded narrow band-passes at f and ~1.9 f, wobbling and fluttering. */
  squealVoice(k, dest) {
    const B = this.buffers, src = this.loopSource(B.pink, 0.9 + 0.08 * k), amp = this.gain(0);
    const bands = [1, 1.92].map((m, i) => {
      const a = this.filter('bandpass', 850 * m, 8), b = this.filter('bandpass', 850 * m, 8), g = this.gain(i ? 0.45 : 1);
      this.chain(src, a, b, g, amp); return [a, b];
    });
    const wob = this.loopSource(B.slow, 1 + 0.27 * k), wobDepth = this.gain(45);
    wob.connect(wobDepth); for (const [a, b] of bands) { wobDepth.connect(a.detune); wobDepth.connect(b.detune); }
    const fl = this.loopSource(B.flutter, 0.85 + 0.2 * k), flDepth = this.gain(0); fl.connect(flDepth); flDepth.connect(amp.gain);
    amp.connect(dest);
    return { bands, amp, flDepth };
  }

  /** Drives a squeal voice: `k` 0..1 how hard it slides, `hz` the lower resonance. */
  setSqueal(v, k, hz, level, t) {
    const g = Math.pow(clamp(fin(k), 0, 1), 1.6) * level * 5; // a full slide sits a few dB under the engine
    v.bands.forEach(([a, b], i) => { const f = hz * (i ? 1.92 : 1); a.frequency.setTargetAtTime(f, t, 0.08); b.frequency.setTargetAtTime(f, t, 0.08); });
    v.amp.gain.setTargetAtTime(g, t, g > v.amp.gain.value ? 0.04 : 0.12);
    v.flDepth.gain.setTargetAtTime(g * 0.45, t, 0.06);
  }

  buildRivals() {
    const c = this.ctx, base = ENGINE_PROFILES['gt-v8-flat'];
    this.rivals = Array.from({ length: RIVAL_VOICES }, (_, i) => {
      const voice = this.makeVoice('rival', 100 + i, base), air = this.filter('lowpass', 8000, 0.5), gain = this.gain(0), send = this.gain(0);
      const pan = new PannerNode(c, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0, coneInnerAngle: 360, coneOuterAngle: 360 });
      voice.out(air); this.chain(air, gain, pan, this.rivalBus); gain.connect(send); send.connect(this.revIn);
      voice.params.level.value = 0;
      return { voice, air, gain, pan, send, car: null, state: 'idle', freeAt: 0, lastGear: null, profileId: base.id };
    });
    // One tonal squeal voice shared by the rivals, placed on the loudest-sliding nearby car.
    const pan = new PannerNode(c, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0 }); pan.connect(this.rivalBus);
    this.rivalSqueal = { ...this.squealVoice(2, pan), pan };
    // The distant field: everything not on a voice, as one soft, roomy drone.
    const fv = this.makeVoice('field', 99, base), lp = this.filter('lowpass', 650, 0.6), g = this.gain(0), s = this.gain(0.6);
    fv.out(lp); this.chain(lp, g, this.fieldBus); g.connect(s); s.connect(this.revIn);
    this.field = { voice: fv, gain: g };
  }

  buildBeds() {
    const b = this.beds = {};
    for (const k of ['crowd', 'sea', 'leaves', 'cicadas', 'wind', 'rain']) { b[k] = this.gain(0); b[k].connect(k === 'rain' ? this.weatherBus : this.ambBus); }
  }

  async loadBeds() {
    const lo = 32000, B = this.buffers, start = (key, buffer) => { if (!this.ctx) return; const s = this.ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.connect(this.beds[key]); s.start(this.ctx.currentTime + 0.05, Math.random() * buffer.duration); };
    const step = () => new Promise((r) => setTimeout(r, 0));
    B.crowd = this.toBuffer(await A.crowd(22050, 81, 10, 0)); start('crowd', B.crowd); await step();
    B.cheer = this.toBuffer(await A.crowd(22050, 82, 4.5, 1)); await step();
    B.song = [91, 92, 93, 94].map((s) => this.toBuffer(A.birdSong(lo, s))); B.blackbird = [95, 96].map((s) => this.toBuffer(A.birdSong(lo, s, true)));
    B.gull = [97, 98, 99].map((s) => this.toBuffer(A.gullCall(lo, s))); B.hawk = [this.toBuffer(A.hawkCry(lo, 100))]; B.cuckoo = [this.toBuffer(A.cuckoo(lo, 101))];
    B.cowbell = [102, 103].map((s) => this.toBuffer(A.cowbells(lo, s))); B.horn = [this.toBuffer(A.shipHorn(16000))];
    await step();
    B.seaLoop = this.toBuffer(A.seaLoop(lo, 111)); start('sea', B.seaLoop); await step();
    B.leavesLoop = this.toBuffer(A.leavesLoop(lo, 112)); start('leaves', B.leavesLoop); await step();
    B.cicadaLoop = this.toBuffer(A.cicadaLoop(lo, 113)); start('cicadas', B.cicadaLoop); await step();
    B.windLoop = this.toBuffer(A.windLoop(lo, 114)); start('wind', B.windLoop); await step();
    B.rainLoop = this.toBuffer(A.rainLoop(lo, 115)); start('rain', B.rainLoop); await step();
    B.thunder = [this.toBuffer(A.thunder(16000, 116)), this.toBuffer(A.thunder(16000, 117))];
    this.bedsReady = true;
  }

  /** Circuit ambience and room. */
  setTrack(id) {
    this.trackId = TRACKS[id] ? id : 'harbor-ring';
    if (!this.ctx || !this.reverb) return;
    const room = A.ROOMS[TRACKS[this.trackId].room];
    if (this.roomId !== room) { this.roomId = room; this.reverb.buffer = this.toBuffer(A.impulseResponse(Math.min(48000, this.ctx.sampleRate), room)); }
    if (this.state) this.state.nextEvent = {};
  }

  setVolume(v) {
    this.volume = v;
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t); this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.setTargetAtTime(this.enabled ? v : 0, t, t < (this.fadeInUntil ?? 0) ? 0.45 : 0.08);
  }
  toggle() { this.enabled = !this.enabled; this.setVolume(this.volume); return this.enabled; }

  // ---------- one-shots ----------
  play(buffer, { gain = 1, rate = 1, dest = this.fxBus, pan = null, lp = 0, send = 0, when = 0, priority = 0 } = {}) {
    if (!this.ready || !buffer || gain < 0.002) return null;
    if (this.oneShots >= MAX_ONESHOTS && priority < 1) return null;
    const c = this.ctx, src = c.createBufferSource(), nodes = [src];
    src.buffer = buffer; src.playbackRate.value = rate;
    let node = src;
    if (lp && lp < 18000) { const f = this.filter('lowpass', lp, 0.6); node.connect(f); node = f; nodes.push(f); }
    const g = this.gain(gain); node.connect(g); node = g; nodes.push(g);
    if (pan !== null) { const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); node.connect(p); node = p; nodes.push(p); }
    node.connect(dest);
    if (send > 0) { const s = this.gain(send); node.connect(s); s.connect(this.revIn); nodes.push(s); }
    this.oneShots++;
    src.onended = () => { this.oneShots--; nodes.forEach((n) => n.disconnect()); };
    src.start(when || c.currentTime);
    return src;
  }
  pick(list) { return Array.isArray(list) ? list[Math.floor(Math.random() * list.length)] : list; }
  tone(freqs, strength, attack, duration, type = 'sine', glide = 1, dest = this.uiBus, pan = 0, when = 0) {
    if (!this.ready) return;
    const c = this.ctx, t = Math.max(c.currentTime, when), g = this.gain(0), p = c.createStereoPanner(); p.pan.value = pan;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(strength, t + attack); g.gain.setTargetAtTime(0, t + Math.max(attack, duration * 0.35), duration * 0.22);
    g.connect(p); p.connect(dest);
    let left = freqs.length;
    for (const fr of freqs) {
      const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(fr, t); if (glide !== 1) o.frequency.exponentialRampToValueAtTime(fr * glide, t + duration);
      o.connect(g); o.start(t); o.stop(t + duration * 1.6 + 0.05);
      o.onended = () => { o.disconnect(); if (--left === 0) { g.disconnect(); p.disconnect(); } };
    }
  }

  /** Broadcast and race-control cues: start lights, flags, graphics stings, menu clicks. */
  cue(name) {
    if (!this.ready || !this.enabled) return;
    const B = this.buffers, now = this.ctx.currentTime;
    if (name === 'light') this.tone([880, 1760], 0.05, 0.004, 0.22);
    else if (name === 'go') { this.tone([1760], 0.06, 0.004, 0.5); this.play(B.cheer, { gain: 0.55, dest: this.ambBus, send: 0.4, priority: 1 }); }
    else if (name === 'final') { this.tone([1318.5, 2637, 3955], 0.035, 0.002, 1.5); this.tone([1318.5, 2637, 3955], 0.03, 0.002, 1.3, 'sine', 1, this.uiBus, 0, now + 0.42); }
    else if (name === 'flag') { this.play(B.cheer, { gain: 0.9, dest: this.ambBus, send: 0.4, priority: 1 }); this.tone([233, 294, 349], 0.018, 0.08, 1.6, 'sawtooth', 1, this.ambBus, -0.3); }
    else if (name === 'fastest') { this.tone([1046.5], 0.035, 0.004, 0.35); this.tone([1568], 0.035, 0.004, 0.5, 'sine', 1, this.uiBus, 0, now + 0.12); }
    else if (name === 'sting') { this.tone([987.8, 1975.5], 0.022, 0.006, 0.3); this.tone([1480], 0.02, 0.006, 0.4, 'sine', 1, this.uiBus, 0, now + 0.07); }
    else if (name === 'click') this.tone([2200], 0.016, 0.001, 0.035, 'sine', 0.7);
    else if (name === 'wipe') { this.tone([220, 330], 0.03, 0.12, 0.45, 'triangle', 3); }
  }

  /**
   * Exhaust backfire, synced with the visual flames (render/exhaust.js).
   * `distance` 0 is the focus car (played through its exhaust path, so the
   * camera perspective applies); rivals fade, darken and pan with range.
   */
  backfire(strength, kind, distance = 0, pan = 0) {
    if (!this.ready || !this.enabled) return;
    const B = this.buffers, list = kind === 'bang' ? B.bang : kind === 'shift' ? B.crack : B.pop;
    const rate = rand(0.88, 1.12);
    if (distance <= 0) { this.play(this.pick(list), { gain: strength * 0.42, rate, dest: this.focus.exhIn, priority: 1 }); return; }
    const k = strength * 0.4 * distGain(distance);
    if (k < 0.01) return;
    this.play(this.pick(list), { gain: k, rate, pan, lp: airCutoff(distance), send: clamp(distance / 120, 0.05, 0.5) });
  }

  // ---------- per frame ----------
  /** Camera basis (world) for placing sources in listener space. */
  listener(car, view) {
    const cam = view.camera;
    if (cam?.matrixWorld) {
      const e = cam.matrixWorld.elements;
      return { x: e[12], y: e[13], z: e[14], r: [e[0], e[1], e[2]], u: [e[4], e[5], e[6]], b: [e[8], e[9], e[10]] };
    }
    // No camera: listen from the focus car, facing its heading.
    const cy = Math.cos(car.yaw ?? 0), sy = Math.sin(car.yaw ?? 0);
    return { x: car.x, y: (car.y ?? 0) + 1.1, z: car.z, r: [-cy, 0, sy], u: [0, 1, 0], b: [-sy, 0, -cy] };
  }
  local(L, o) {
    const dx = o.x - L.x, dy = (o.y ?? 0) + 0.45 - L.y, dz = o.z - L.z;
    return { x: dx * L.r[0] + dy * L.r[1] + dz * L.r[2], y: dx * L.u[0] + dy * L.u[1] + dz * L.u[2], z: dx * L.b[0] + dy * L.b[1] + dz * L.b[2], d: Math.hypot(dx, dy, dz), dx, dy, dz };
  }
  doppler(rel, o, camV) {
    if (rel.d < 1) return 1;
    const ux = -rel.dx / rel.d, uz = -rel.dz / rel.d, uy = -rel.dy / rel.d; // source -> listener
    const vs = fin(o.vx) * ux + fin(o.vz) * uz, vl = camV[0] * ux + camV[1] * uy + camV[2] * uz;
    return clamp((SOUND_SPEED - vl) / (SOUND_SPEED - clamp(vs, -150, 150)), 0.6, 1.6);
  }

  update(car, running, cars = [], view = {}) {
    if (!this.ready || !car) return;
    const c = this.ctx, t = c.currentTime, S = this.state, f = this.focus;
    const menu = Boolean(view.menu) || (cars.length === 0 && view.distance === undefined);
    const nowMs = performance.now() / 1000, dt = clamp(nowMs - (S.camT || nowMs - 0.016), 0.001, 0.1); S.camT = nowMs;
    const set = (param, v, tau = 0.05) => param.setTargetAtTime(fin(v), t, tau);
    if (menu && car.trackId && car.trackId !== this.trackId) this.setTrack(car.trackId);

    // Listener and its velocity (camera cuts reset it rather than producing a Doppler spike).
    const L = this.listener(car, view);
    if (S.cam) {
      const vx = (L.x - S.cam[0]) / dt, vy = (L.y - S.cam[1]) / dt, vz = (L.z - S.cam[2]) / dt;
      if (Math.hypot(vx, vy, vz) > 160) S.camV = [0, 0, 0];
      else S.camV = S.camV.map((v, i) => v + ([vx, vy, vz][i] - v) * 0.3);
    }
    S.cam = [L.x, L.y, L.z];

    // ----- focus car -----
    const prof = ENGINE_PROFILES[profileIdFor(car)];
    if (prof !== f.profile) { f.profile = prof; f.voice.setProfile(prof); }
    const rel = this.local(L, car), camD = view.distance ?? rel.d;
    S.d += (camD - S.d) * 0.25;
    const d = S.d, inside = d < 2.4;
    const live = !menu, moving = live && running;
    const thr = clamp(fin(car.controls?.throttle), 0, 1), speed = Math.max(0, fin(car.speed)), vs = clamp(speed / 14, 0, 1), vk = clamp(speed / 80, 0, 1.3);
    const simRpm = moving ? clamp(fin(car.rpm, SIM_IDLE), SIM_IDLE * 0.9, SIM_MAX) : SIM_IDLE + 120;
    const rf = clamp((simRpm - SIM_IDLE) / (SIM_MAX - SIM_IDLE), 0, 1), load = moving ? thr : 0;
    // Mix for the camera.
    set(this.focusBus.gain, live ? clamp(1 / (1 + Math.max(0, d - 5) * 0.02), 0.22, 1) : 0, 0.06);
    set(this.carAir.frequency, inside ? 20000 : airCutoff(d), 0.08);
    set(this.carSend.gain, clamp((d - 5) / 110, 0.03, 0.5), 0.1);
    set(this.carPan.pan, inside ? 0 : clamp(rel.x / Math.max(6, rel.d), -0.85, 0.85), 0.08);
    set(f.exhGain.gain, inside ? LEVELS.exhaustOnboard : 1, 0.1);
    set(f.cabin.frequency, inside ? 2600 : 20000, 0.1);
    set(f.intake.gain, inside ? LEVELS.intakeOnboard : LEVELS.intakeOutside, 0.1);
    // Engine. Idle is lifted so the dynamic range from idle to full song stays playable (~16 dB, not 30).
    const p = f.voice.params, erpm = engineRpm(prof, simRpm);
    const idleLift = 1 + 2.2 * (1 - rf) * (1 - rf) * (1 - load);
    set(p.level, live ? LEVELS.engine * idleLift * (running ? 1 : 0.6) : 0, live ? 0.04 : 0.3);
    set(p.rpm, erpm, 0.025);
    set(p.doppler, inside || rel.d < 8 ? 1 : this.doppler(rel, car, S.camV), 0.05);
    if (t >= S.blipUntil) set(p.throttle, load, 0.02);
    const pit = view.pit ?? null, inLane = pit === 'lane' || pit === 'release';
    const limiter = moving && ((car.rpm > 8050 && thr > 0.8) || (inLane && thr > 0.25 && speed > 8));
    p.stutter.setValueAtTime(limiter ? 1 : 0, t);
    // Turbo spool: builds with load and revs, collapses on a lift (with the blow-off valve).
    const spoolTo = prof.turbo ? load * clamp((rf - 0.18) / 0.45, 0, 1) : 0;
    S.boost += (spoolTo - S.boost) * clamp(dt / (spoolTo > S.boost ? 0.5 : 0.12), 0, 1);
    set(p.boost, S.boost, 0.03);
    if (prof.turbo && moving && S.boost > 0.4 && S.lastThr > 0.6 && thr < 0.15) this.play(this.pick(this.buffers.bov), { gain: 0.22 * S.boost * (inside ? 1 : 0.6), dest: f.intake, rate: rand(0.95, 1.08) });
    // Gearbox and final drive whine: loudest onboard, and on the overrun when the load reverses.
    const wheelHz = speed / (2 * Math.PI * 0.34);
    set(f.gearOsc.frequency, clamp(erpm / 60 * 17, 20, 9000), 0.03);
    set(f.diffOsc.frequency, clamp(wheelHz * 3.8 * 11, 20, 9000), 0.03);
    set(f.whine.gain, moving ? LEVELS.whine * vs * (inside ? 1 : 0.2) * (1.4 - 0.7 * load) : 0, 0.06);
    // Hybrid deploy / regen.
    const kw = prof.hybrid && car.hybrid ? fin(car.hybrid.kw) : 0;
    set(f.mguOsc.frequency, clamp(30 + speed * 19, 30, 2200), 0.04);
    set(f.mgu.gain, moving ? LEVELS.mgu * clamp(Math.abs(kw) / 120, 0, 1) * (inside ? 1 : 0.25) : 0, 0.08);

    // Shifts: an upshift cuts the ignition for the dog ring to slam home; a downshift blips.
    if (moving && S.lastGear !== null && car.gear !== S.lastGear && speed > 5) {
      if (car.gear > S.lastGear) {
        p.cut.cancelScheduledValues(t); p.cut.setValueAtTime(1, t); p.cut.setValueAtTime(0, t + rand(0.05, 0.075));
        this.play(this.pick(this.buffers.clunk), { gain: inside ? 0.32 : 0.14, dest: this.focusBus, when: t + 0.045, rate: rand(0.9, 1.1) });
      } else {
        p.throttle.cancelScheduledValues(t); p.throttle.setValueAtTime(1, t); p.throttle.setTargetAtTime(load, t + 0.08, 0.03); S.blipUntil = t + 0.12;
        this.play(this.pick(this.buffers.clunk), { gain: inside ? 0.26 : 0.1, dest: this.focusBus, when: t + 0.03, rate: rand(0.8, 0.95) });
      }
    }

    // Tyres.
    const wet = clamp(fin(view.weather?.wet), 0, 1), rain = clamp(fin(view.weather?.rain), 0, 1);
    const onTarmac = car.zone === 'asphalt' || car.zone === 'kerb';
    const grip = moving && onTarmac ? 1 - wet * 0.8 : 0, slide = slideOf(car), vt = clamp(speed / 12, 0, 1);
    // A lock-up or spin climbs; a long slide sits lower. Two voices a little apart in pitch so it never reads as one tone.
    const sq = slide.squeal * vt * grip, hz = 760 + 220 * slide.squeal + clamp(speed, 0, 60) * 2;
    this.setSqueal(f.squeal[0], sq, hz, LEVELS.tyres * (inside ? 0.7 : 1), t);
    this.setSqueal(f.squeal[1], sq * 0.7, hz * 1.13, LEVELS.tyres * (inside ? 0.7 : 1), t);
    set(f.scrubLp.frequency, 380 + speed * 6, 0.1);
    set(f.scrub.gain, slide.scrub * vt * (moving && onTarmac ? 1 - wet * 0.5 : 0) * 0.06, 0.08);
    // Surfaces.
    const kerb = moving && car.zone === 'kerb', gravel = moving && car.zone === 'gravel', grass = moving && car.zone === 'grass';
    set(f.kerbOsc.frequency, clamp(speed / 0.55, 5, 110), 0.03);
    set(f.kerb.gain, kerb ? (0.1 + 0.3 * vs) * LEVELS.surface : 0, 0.015);
    set(f.kerbRattle.gain, kerb ? 0.12 * vs * LEVELS.surface : 0, 0.02);
    set(f.gravelSrc.playbackRate, 0.6 + speed / 50, 0.05); set(f.gravel.gain, gravel ? vs * LEVELS.surface : 0, 0.04);
    set(f.grassSrc.playbackRate, 0.7 + speed / 60, 0.05); set(f.grass.gain, grass ? vs * LEVELS.surface * 0.7 : 0, 0.05);
    set(f.roadLp.frequency, 110 + speed * 3 + (onTarmac ? 0 : 120), 0.1);
    set(f.road.gain, moving ? LEVELS.road * vk * (onTarmac ? 1 : 3) * (inside ? 0.7 : 1) : 0, 0.08);
    if (kerb && S.lastZone !== 'kerb') this.play(this.buffers.jackDown, { gain: 0.12 + 0.2 * vs, dest: this.focusBus, rate: 1.3 });
    set(f.spray.gain, moving && wet > 0.05 ? wet * Math.pow(clamp(speed / 60, 0, 1), 1.5) * 0.11 * (inside ? 0.55 : 1) : 0, 0.15);
    set(f.windLp.frequency, 250 + speed * 11, 0.2);
    const windLevel = moving ? LEVELS.wind * Math.pow(vk, 2.4) * (inside ? 1 : 0.5) : 0;
    set(f.wind.gain, windLevel, 0.2); set(f.windGust.gain, windLevel * 0.3, 0.2);

    // Contact.
    const imp = fin(car.impact);
    if (moving && imp > S.lastImpact + 0.02 && t - S.lastImpactAt > 0.12) {
      S.lastImpactAt = t;
      this.play(this.pick(imp > 0.35 ? this.buffers.impactHeavy : this.buffers.impactLight), { gain: 0.15 + 0.65 * clamp(imp, 0, 1), dest: this.focusBus, rate: rand(0.9, 1.08), priority: 1 });
    }

    // Pit lane: limiter beep onboard, jacks and wheel guns at the box.
    if (pit !== S.pit) {
      if (pit === 'service' && d < 70) {
        const k = distGain(d) * 1.2, B = this.buffers;
        this.play(B.jackUp, { gain: 0.5 * k, dest: this.focusBus, when: t + 0.35, priority: 1 });
        [0.9, 1.15, 1.75, 2.0].forEach((at, i) => this.play(this.pick(B.gun), { gain: 0.35 * k, dest: this.focusBus, when: t + at + Math.random() * 0.1, pan: i < 2 ? -0.4 : 0.4, priority: 1 }));
      }
      if (S.pit === 'service' && pit !== 'service' && d < 70) this.play(this.buffers.jackDown, { gain: 0.6 * distGain(d) * 1.2, dest: this.focusBus, priority: 1 });
      S.pit = pit;
    }
    if (inLane && inside && moving && t - S.lastBeep > 0.6) { S.lastBeep = t; this.tone([1480], 0.012, 0.003, 0.06, 'sine', 1, this.uiBus); }

    // ----- rivals, the field and ambience -----
    this.updateRivals(car, cars, L, live, running, t, set);
    const loud = load * (0.4 + 0.6 * rf) * (inside ? 1 : clamp(1 / (1 + Math.max(0, d - 5) * 0.02), 0.2, 1));
    this.updateAmbience(menu, inside, running, loud, rain, t, set);

    S.lastGear = car.gear; S.lastImpact = imp; S.lastThr = thr; S.lastZone = car.zone;
  }

  updateRivals(car, cars, L, live, running, t, set) {
    const S = this.state, cand = [], byId = new Map();
    if (live) for (const o of cars) {
      if (o === car || o.retired) continue;
      const rel = this.local(L, o); if (rel.d > 900) continue;
      const thr = clamp(fin(o.controls?.throttle), 0, 1), rf = clamp((fin(o.rpm, SIM_IDLE) - SIM_IDLE) / (SIM_MAX - SIM_IDLE), 0, 1);
      const e = { o, rel, thr, rf, score: distGain(rel.d) * (0.35 + 0.65 * thr) * (0.6 + 0.4 * rf) };
      cand.push(e); byId.set(o.id, e);
    }
    cand.sort((a, b) => b.score - a.score);
    const top = cand.slice(0, RIVAL_VOICES).filter((e) => e.rel.d < 320), keepScore = (top[top.length - 1]?.score ?? 0) * 0.7, want = new Set(top.map((e) => e.o.id));
    // Release voices whose car fell well out of the top set (hysteresis keeps a voice from flapping).
    for (const v of this.rivals) {
      if (v.state === 'fading' && t >= v.freeAt) { v.state = 'idle'; v.car = null; }
      if (v.state !== 'active') continue;
      const e = byId.get(v.car.id);
      if (!e || e.rel.d > 360 || (!want.has(v.car.id) && e.score < keepScore)) { v.state = 'fading'; v.freeAt = t + 0.15; set(v.voice.params.level, 0, 0.03); set(v.gain.gain, 0, 0.03); }
    }
    for (const e of top) {
      if (this.rivals.some((v) => v.car === e.o && v.state === 'active')) continue;
      const v = this.rivals.find((x) => x.state === 'idle'); if (!v) break;
      const pid = profileIdFor(e.o);
      if (pid !== v.profileId) { v.profileId = pid; v.voice.setProfile(ENGINE_PROFILES[pid]); }
      v.car = e.o; v.state = 'active'; v.lastGear = e.o.gear;
    }
    let squeal = null;
    for (const v of this.rivals) {
      if (v.state !== 'active') continue;
      const e = byId.get(v.car.id), o = e.o, rel = e.rel, prof = ENGINE_PROFILES[v.profileId], p = v.voice.params;
      const sim = running ? clamp(fin(o.rpm, SIM_IDLE), SIM_IDLE * 0.9, SIM_MAX) : SIM_IDLE + 120, thr = running ? e.thr : 0;
      const idleLift = 1 + 1.6 * (1 - e.rf) * (1 - e.rf) * (1 - thr);
      set(p.rpm, engineRpm(prof, sim), 0.03); set(p.throttle, thr, 0.03);
      set(p.level, LEVELS.rival * idleLift * (running ? 1 : 0.6), 0.05);
      set(p.doppler, this.doppler(rel, o, S.camV), 0.06);
      p.stutter.setValueAtTime(running && o.rpm > 8050 && e.thr > 0.8 ? 1 : 0, t);
      if (running && v.lastGear !== null && o.gear > v.lastGear && o.speed > 5) { p.cut.cancelScheduledValues(t); p.cut.setValueAtTime(1, t); p.cut.setValueAtTime(0, t + 0.06); }
      v.lastGear = o.gear;
      set(v.gain.gain, distGain(rel.d), 0.05);
      set(v.air.frequency, airCutoff(rel.d), 0.08);
      set(v.send.gain, clamp(rel.d / 140, 0.04, 0.6), 0.1);
      set(v.pan.positionX, rel.x, 0.03); set(v.pan.positionY, rel.y, 0.03); set(v.pan.positionZ, rel.z, 0.03);
      // Nearby sliding car for the shared squeal voice.
      if (running && rel.d < 70 && o.wheels?.length && (o.zone === 'asphalt' || o.zone === 'kerb')) {
        const sl = slideOf(o), s = sl.squeal * clamp(o.speed / 12, 0, 1) * distGain(rel.d);
        if (s > (squeal?.s ?? 0.02)) squeal = { s, rel, k: sl.squeal, v: o.speed };
      }
      // Rival contact.
      const imp = fin(o.impact), last = S.impacts.get(o.id) ?? 0;
      if (running && imp > last + 0.03 && rel.d < 150) this.play(this.pick(imp > 0.35 ? this.buffers.impactHeavy : this.buffers.impactLight), { gain: (0.15 + 0.6 * clamp(imp, 0, 1)) * distGain(rel.d), pan: clamp(rel.x / Math.max(6, rel.d), -1, 1), lp: airCutoff(rel.d), send: clamp(rel.d / 120, 0.05, 0.5), priority: 1 });
      S.impacts.set(o.id, imp);
    }
    const rs = this.rivalSqueal;
    this.setSqueal(rs, squeal ? squeal.s : 0, squeal ? 760 + 220 * squeal.k + clamp(squeal.v, 0, 60) * 2 : 800, LEVELS.tyres * 0.8 * (1 - clamp(fin(this.lastWet), 0, 1) * 0.8), t);
    if (squeal) { set(rs.pan.positionX, squeal.rel.x, 0.05); set(rs.pan.positionY, squeal.rel.y, 0.05); set(rs.pan.positionZ, squeal.rel.z, 0.05); }
    // Distant field: the power sum of every car not on a voice.
    let pow = 0, rpmW = 0, w = 0;
    for (const e of cand) {
      if (this.rivals.some((v) => v.car === e.o && v.state === 'active')) continue;
      const g = distGain(e.rel.d), k = g * g * (0.3 + 0.7 * e.thr); pow += k; rpmW += k * fin(e.o.rpm, SIM_IDLE); w += k;
    }
    const fp = this.field.voice.params, fprof = ENGINE_PROFILES['gt-v8-flat'];
    set(fp.level, live && pow > 1e-6 ? 1 : 0, 0.2);
    set(fp.rpm, engineRpm(fprof, w > 0 ? rpmW / w : SIM_IDLE), 0.15); set(fp.throttle, running ? 0.7 : 0, 0.2);
    set(this.field.gain.gain, live ? clamp(Math.sqrt(pow), 0, 0.5) * LEVELS.field : 0, 0.25);
  }

  updateAmbience(menu, inside, running, loud, rain, t, set) {
    const S = this.state, tr = TRACKS[this.trackId], b = this.beds, B = this.buffers;
    this.lastWet = rain;
    const base = menu ? LEVELS.ambienceMenu : LEVELS.ambience * (inside ? 0.5 : 1) * (1 - 0.35 * loud);
    set(this.ambBus.gain, base, menu ? 0.8 : 0.3);
    set(b.crowd.gain, tr.crowd * 0.55, 1.2); set(b.sea.gain, tr.sea * 0.5, 1.2); set(b.leaves.gain, tr.leaves * 0.3 * (1 + rain), 1.2);
    set(b.cicadas.gain, tr.cicadas * 0.16 * (1 - rain), 1.2); set(b.wind.gain, tr.wind * 0.4, 1.2);
    set(b.rain.gain, rain * LEVELS.rain * (inside ? 1.25 : 1), 0.8);
    if (!this.bedsReady) return;
    // Wildlife and circuit events.
    for (const [kind, lo, hi] of tr.events) {
      const due = S.nextEvent[kind] ?? (S.nextEvent[kind] = t + rand(lo * 0.3, hi * 0.6));
      if (t < due) continue;
      S.nextEvent[kind] = t + rand(lo, hi);
      if ((kind === 'song' || kind === 'blackbird' || kind === 'cuckoo') && rain > 0.4) continue;
      const g = { gull: 0.3, horn: 0.25, song: 0.16, blackbird: 0.15, cuckoo: 0.12, cowbell: 0.14, hawk: 0.12 }[kind] ?? 0.15;
      this.play(this.pick(B[kind]), { gain: g * rand(0.6, 1.1), rate: kind === 'horn' ? 1 : rand(0.92, 1.08), pan: rand(-0.85, 0.85), dest: this.ambBus, send: kind === 'horn' ? 0.6 : 0.3, lp: kind === 'horn' ? 0 : rand(5000, 16000) });
    }
    // Circuit PA chime, now and then during the race.
    if (!menu && running) {
      if (!S.nextPa) S.nextPa = t + rand(40, 90);
      if (t > S.nextPa) { [659, 523, 784].forEach((fr, i) => this.tone([fr, fr * 2], 0.02, 0.02, 0.9, 'sine', 1, this.ambBus, 0.35, t + i * 0.34)); S.nextPa = t + rand(70, 140); }
    }
    if (rain > 0.55 && B.thunder) {
      if (!S.nextThunder) S.nextThunder = t + rand(15, 40);
      if (t > S.nextThunder) { this.play(this.pick(B.thunder), { gain: rand(0.25, 0.55) * rain, dest: this.weatherBus, pan: rand(-0.6, 0.6), send: 0.4 }); S.nextThunder = t + rand(35, 90); }
    }
  }

  /** Live snapshot of the graph for debugging and tests. */
  debug() {
    if (!this.ctx) return { state: 'locked' };
    return {
      state: this.ctx.state, sampleRate: this.ctx.sampleRate, worklet: this.worklet, ready: this.ready, bedsReady: Boolean(this.bedsReady), track: this.trackId,
      master: this.master.gain.value, meters: this.meters, oneShots: this.oneShots,
      focus: { profile: this.focus.profile.id, level: this.focus.voice.params.level.value, rpm: this.focus.voice.params.rpm.value },
      rivals: this.rivals.map((v) => ({ state: v.state, car: v.car?.id ?? null, profile: v.profileId, gain: +v.gain.gain.value.toFixed(3) })),
      field: +this.field.gain.gain.value.toFixed(3), ambience: +this.ambBus.gain.value.toFixed(3),
      beds: Object.fromEntries(Object.entries(this.beds).map(([k, g]) => [k, +g.gain.value.toFixed(3)]))
    };
  }
}
