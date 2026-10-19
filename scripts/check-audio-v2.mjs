// CPU-only audio contract/regression checks. node --test scripts/check-audio-v2.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RecordedEngineDSP, SAMPLE_PARAMS } from '../game/render/audio/sample-worklet.js';
import { ENGINE_PROFILES } from '../game/render/audio/profiles.js';
import { EngineDSP } from '../game/render/audio/worklet.js';
import { pressureRelease, materialEffect, V2_LEVELS } from '../game/render/audio/v2-effects.js';
import { exhaustPop } from '../game/render/audio/buffers.js';
import { Biquad } from '../game/render/audio/worklet.js';
import { switchableVoice } from '../game/render/audio/switchable-voice.js';
import { AudioEngine, DEFAULT_LEVELS, LEVELS } from '../game/render/audio/engine.js';
import { loadTuning, saveTuning } from '../game/render/audio/tuning.js';
import { renderSettings } from '../game/ui/menus.js';
import { prepareRecordingLayer } from '../game/render/audio/recordings.js';

const samples = new URL('../game/render/audio/samples/', import.meta.url);
function decodeWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.readUInt16LE(22), 1); assert.equal(buffer.readUInt16LE(34), 16);
  const data = new Float32Array(buffer.readUInt32LE(40) / 2);
  for (let i = 0; i < data.length; i++) data[i] = buffer.readInt16LE(44 + i * 2) / 32768;
  return { sr: buffer.readUInt32LE(24), data };
}
const pitches = { v8: [75.1, 118.5, 115.5], flat: [48.9, 60.4, 118.1], race: [59.5, 125, 213.3], turbo: [53.6, 113.9, 205.1] };
const recordings = Object.fromEntries(Object.keys(pitches).map((key) => [key, [0, 1, 2].map((k) => { const { data, sr } = decodeWav(fs.readFileSync(new URL(`${key}-${k}.wav`, samples))); return prepareRecordingLayer(data, sr, k * 0.5, pitches[key][k]); })]));
const energy = (x) => x.reduce((s, v) => s + v * v, 0) / x.length;

test('all bundled recordings are finite, centred, unclipped, and have click-free wraps', () => {
  const files = fs.readdirSync(samples).filter((f) => f.endsWith('.wav'));
  assert.equal(files.length, 14);
  for (const file of files) {
    const { sr, data } = decodeWav(fs.readFileSync(new URL(file, samples)));
    assert.equal(sr, 32000); assert(data.length > 10000);
    assert(data.every((x) => Number.isFinite(x) && Math.abs(x) < 0.84), file);
    assert(energy(data) > 0.001, file);
    assert(Math.abs(data.reduce((a, b) => a + b) / data.length) < 0.001, file);
    assert(Math.abs(data[0] - data.at(-1)) < 0.22, `${file} wrap`);
  }
});

test('recorded engines survive all profiles, RPM sweeps, shifts, limiter, Doppler and sample rates', () => {
  for (const sr of [32000, 44100, 48000, 96000]) for (const profile of Object.values(ENGINE_PROFILES)) {
    const d = new RecordedEngineDSP(sr, 'focus', 13, recordings); d.setProfile({ ...profile, gain: 0.9 });
    const L = new Float32Array(128), R = new Float32Array(128), I = new Float32Array(128);
    d.render(L, R, I, 128, { ...SAMPLE_PARAMS }); assert(L.every((x) => x === 0));
    let total = 0;
    for (let block = 0; block < 700; block++) {
      const f = block / 699;
      d.render(L, R, I, 128, { rpm: profile.idle + f * (profile.redline - profile.idle), throttle: f, level: V2_LEVELS.engine, doppler: 0.6 + f, cut: block % 90 < 4 ? 0.9 : 0, stutter: block > 650 ? 1 : 0 });
      for (const out of [L, R, I]) assert(out.every((x) => Number.isFinite(x) && Math.abs(x) < 1), profile.id);
      total += energy(L); assert.deepEqual(L, R);
    }
    assert(total > 0.1, `${profile.id} audible`);
    for (let i = 0; i < 500; i++) d.render(L, R, I, 128, { ...SAMPLE_PARAMS, level: 0 });
    assert(L.every((x) => x === 0), 'mute settles to exact silence');
  }
});

test('V2 exhaust releases have no bright cracker tail and end smoothly', () => {
  for (const sr of [32000, 48000]) for (const kind of ['pop', 'bang', 'shift']) {
    const newer = pressureRelease(sr, 3, kind).ch[0], older = exhaustPop(sr, 3, kind).ch[0];
    const highEnergy = (x) => { const hp = new Biquad().set('highpass', 5000, 0.7, sr); return energy(Float32Array.from(x, (s) => hp.run(s))); };
    assert(highEnergy(newer) < highEnergy(older) * 0.2, `${kind} high-frequency glare`);
    assert(energy(newer.slice(Math.floor(newer.length * 0.8))) < energy(newer) * 0.001, `${kind} tail`);
    assert(Math.abs(newer.at(-1)) < 0.0001);
  }
  for (const kind of ['heavy', 'light', 'clunk', 'gun', 'jackUp', 'jackDown', 'bov']) {
    const data = materialEffect(48000, 9, kind).ch[0];
    assert(data.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
    assert(energy(data) > 1e-6); assert(Math.abs(data.at(-1)) < 0.001);
  }
});

test('RPM and Doppler determine pitch consistently across source layers', () => {
  const sr = 48000, sine = Float32Array.from({ length: 3200 }, (_, i) => Math.sin(2 * Math.PI * 100 * i / 32000) * 0.2);
  const layers = [0, 0.5, 1].map((f) => prepareRecordingLayer(sine, 32000, f, 100));
  const pack = { v8: layers, flat: layers, race: layers, turbo: layers };
  for (const rpm of [1200, 4000, 7500]) for (const doppler of [0.8, 1.6]) {
    const dsp = new RecordedEngineDSP(sr, 'focus', 1, pack); dsp.setProfile(ENGINE_PROFILES['gt-v8-cross']);
    const L = new Float32Array(128); let crossings = 0, last = 0;
    for (let block = 0; block < 450; block++) {
      dsp.render(L, null, null, L.length, { ...SAMPLE_PARAMS, rpm, level: 0.5, throttle: 1, doppler });
      if (block < 75) continue;
      for (const x of L) { if (last < 0 && x >= 0) crossings++; last = x; }
    }
    const hz = crossings / (375 * 128 / sr), expected = rpm * 8 / 120 * doppler;
    assert(Math.abs(hz - expected) < 2, `${rpm} rpm: ${hz} vs ${expected}`);
  }
});

test('AudioWorklet registration renders stereo exhaust and intake, handles retuning, then stops on disposal', async () => {
  const previous = { registerProcessor: globalThis.registerProcessor, AudioWorkletProcessor: globalThis.AudioWorkletProcessor, sampleRate: globalThis.sampleRate };
  const processors = new Map();
  try {
    globalThis.sampleRate = 48000;
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = {}; } };
    globalThis.registerProcessor = (name, implementation) => processors.set(name, implementation);
    await import('../game/render/audio/sample-worklet.js?registration-check');
    const Processor = processors.get('recorded-engine'); assert(Processor);
    assert.deepEqual(Processor.parameterDescriptors.map((p) => p.name).sort(), Object.keys(SAMPLE_PARAMS).sort());
    const processor = new Processor({ processorOptions: { mode: 'focus', seed: 1, recordings, profile: ENGINE_PROFILES['gt-f6'] } });
    const outputs = [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128)]];
    const params = Object.fromEntries(Object.entries({ ...SAMPLE_PARAMS, rpm: 6500, throttle: 1, level: 0.7 }).map(([k, v]) => [k, new Float32Array([v])]));
    assert.equal(processor.process([], outputs, params), true);
    assert(energy(outputs[0][0]) > 0); assert(energy(outputs[1][0]) > 0);
    processor.port.onmessage({ data: { profile: ENGINE_PROFILES['gtp-v8-tt'], live: true } });
    assert.equal(processor.process([], outputs, params), true);
    assert(outputs.flat().every((out) => out.every(Number.isFinite)));
    processor.port.onmessage({ data: { dispose: true } }); assert.equal(processor.process([], outputs, params), false);
  } finally {
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[k]; else globalThis[k] = value; }
  }
});

class Param {
  constructor(v = 0) { this.current = v; this.events = []; }
  get value() { return this.current; }
  set value(v) { assert(Number.isFinite(v), 'finite AudioParam'); this.current = v; }
  setTargetAtTime(v, t, tau) { this.value = v; this.events.push(['target', v, t, tau]); return this; }
  setValueAtTime(v, t) { this.value = v; this.events.push(['value', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['ramp', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { return this.linearRampToValueAtTime(v, t); }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e[2] < t); return this; }
}
class Node {
  constructor() {
    for (const key of ['gain', 'frequency', 'Q', 'detune', 'pan', 'playbackRate', 'positionX', 'positionY', 'positionZ', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[key] = new Param(key === 'gain' || key === 'playbackRate' ? 1 : 0);
    this.connections = []; this.port = { postMessage: () => {}, close: () => {} };
  }
  connect(dest) { assert(dest); this.connections.push(dest); return dest; }
  disconnect() { this.connections = []; }
  start() {} stop() {} setPeriodicWave() {}
}
function buffer(channels, n, sampleRate) {
  const data = Array.from({ length: channels }, () => new Float32Array(n));
  return { sampleRate, duration: n / sampleRate, length: n, numberOfChannels: channels, getChannelData: (i) => data[i], copyToChannel: (x, i) => data[i].set(x) };
}
class Context {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new Node(); this.audioWorklet = { addModule: async () => {} }; }
  createGain() { return new Node(); } createBiquadFilter() { return new Node(); } createStereoPanner() { return new Node(); }
  createDynamicsCompressor() { return new Node(); } createConvolver() { return new Node(); } createBufferSource() { return new Node(); }
  createOscillator() { return new Node(); } createPeriodicWave() { return {}; } createScriptProcessor() { return new Node(); }
  createBuffer(...args) { return buffer(...args); }
  async decodeAudioData(b) { const { sr, data } = decodeWav(Buffer.from(b)), out = buffer(1, data.length, sr); out.copyToChannel(data, 0); return out; }
  async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
}

test('switching midway through a shift preserves its scheduled ignition return and retires old voices', async () => {
  const ctx = new Context(), made = [];
  const create = (_mode, _seed, _p, v2) => {
    const v = { v2, params: Object.fromEntries(Object.entries(SAMPLE_PARAMS).map(([k, v]) => [k, new Param(v)])), out() {}, outIntake() {}, setProfile() {}, dispose() { this.stopped = true; } };
    made.push(v); return v;
  };
  const voice = switchableVoice(ctx, create, false, 'focus', 1, ENGINE_PROFILES['gt-f6'], SAMPLE_PARAMS);
  voice.params.cut.setValueAtTime(0.9, 0); voice.params.cut.setValueAtTime(0, 0.04);
  ctx.currentTime = 0.015; voice.setV2(true);
  assert(made[1].params.cut.events.some((e) => e[0] === 'value' && e[1] === 0 && e[2] === 0.04));
  voice.setV2(false); voice.setV2(true);
  await new Promise((r) => setTimeout(r, 280));
  assert(made.slice(0, -1).every((v) => v.stopped)); assert(!made.at(-1).stopped);
  voice.dispose(); assert(made.every((v) => v.stopped));
});

test('full mixer loads V2, swaps live, keeps volume/mute, separates saved tuning, and supports fallback', async () => {
  const keys = ['window', 'AudioWorkletNode', 'PannerNode', 'fetch', 'localStorage'];
  const previous = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  const storage = new Map(), worklets = [];
  const originalLoadBeds = AudioEngine.prototype.loadBeds;
  try {
    globalThis.localStorage = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) };
    globalThis.window = new EventTarget(); window.AudioContext = Context;
    globalThis.PannerNode = Node;
    globalThis.AudioWorkletNode = class extends Node { constructor(_ctx, name) { super(); this.name = name; this.parameters = new Map(Object.entries(SAMPLE_PARAMS).map(([k, v]) => [k, new Param(v)])); this.port.postMessage = (msg) => { if (msg.dispose) this.stopped = true; }; worklets.push(this); } };
    globalThis.fetch = async (u) => ({ ok: true, arrayBuffer: async () => { const b = fs.readFileSync(fileURLToPath(u)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
    // Bed synthesis has its own existing generators; avoid generating minutes of crowd audio in a graph-contract test.
    AudioEngine.prototype.loadBeds = async function () { this.bedsReady = true; };
    saveTuning({ levels: { rain: 0.9 }, engines: {} });
    const audio = new AudioEngine(); audio.setVolume(0.37); await audio.unlock(); await audio.setV2(true);
    assert.equal(audio.sampleStatus, 'ready'); assert.equal(LEVELS.rain, V2_LEVELS.rain);
    assert.equal(worklets.filter((n) => n.name === 'recorded-engine').length, 8);
    const car = { id: 'a', x: 0, z: 0, yaw: 0, speed: 45, rpm: 6200, gear: 3, controls: { throttle: 0.8 }, zone: 'asphalt', wheels: [] };
    audio.update(car, true, [car], { distance: 6, weather: { rain: 0.8, wet: 0.5 } });
    assert.equal(audio.beds.rain.gain.value, 0); assert(audio.sampleRain.gain.value > 0);
    audio.toggle(); const c = audio.ctx; await audio.setV2(false);
    assert.equal(audio.ctx, c); assert.equal(audio.volume, 0.37); assert.equal(audio.enabled, false); assert.equal(audio.master.gain.value, 0);
    assert.equal(LEVELS.rain, 0.9); assert.equal(LEVELS.reverb, DEFAULT_LEVELS.reverb);
    audio.setTuning({ levels: { rain: 0.7 }, engines: {} }); await audio.setV2(true);
    audio.setTuning({ levels: { rain: 0.13 }, engines: {} });
    assert.equal(loadTuning().levels.rain, 0.7); assert.equal(loadTuning('pe.audioTune.v2').levels.rain, 0.13);
    for (const kind of ['rev', 'pops', 'crash', 'slide', 'scrub', 'surface', 'rain', 'hybrid', 'flyby', 'pack', 'circuit']) {
      audio.audition(kind, 'gtp-v8-na'); audio.ctx.currentTime += 0.1; audio.update(car, true, [car], { distance: 6 });
    }
    await new Promise((r) => setTimeout(r, 280));
    assert(worklets.filter((n) => n.name === 'engine-voice').every((n) => n.stopped));
    const fallback = audio.makeRawVoice('focus', 1, audio.prof('gt-f6'), true);
    assert(fallback.params); // Worklet path above; explicitly exercise the ScriptProcessor path too.
    fallback.dispose(); audio.sampleWorklet = false;
    const script = audio.makeRawVoice('focus', 1, audio.prof('gt-f6'), true);
    script.params.level.value = 0.7;
    const out = buffer(2, 1024, 48000); script.node.onaudioprocess({ outputBuffer: out });
    assert(out.getChannelData(0).every(Number.isFinite)); script.dispose();
    for (const voice of audio.voices) voice.dispose(); await audio.ctx.close();
    const failed = new AudioEngine(); failed.ctx = new Context(); globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(failed.prepareRecordings(), /404/); assert.equal(failed.sampleStatus, 'unavailable');
    assert.equal(failed.loadingRecordings, null, 'a later gesture can retry');
    // A slow decode must not turn V2 back on after the user has already switched it off.
    const slower = new AudioEngine({ v2: false }); await slower.unlock();
    let release; const gate = new Promise((r) => { release = r; });
    globalThis.fetch = async (u) => { await gate; return { ok: true, arrayBuffer: async () => { const b = fs.readFileSync(fileURLToPath(u)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }; };
    const pending = slower.setV2(true); await slower.setV2(false); release(); await pending;
    assert.equal(slower.v2, false); assert.equal(LEVELS.reverb, DEFAULT_LEVELS.reverb);
    assert.equal(slower.buffers.pop, slower.originalEffects.pop);
    for (const voice of slower.voices) voice.dispose(); await slower.ctx.close();
  } finally {
    AudioEngine.prototype.loadBeds = originalLoadBeds;
    for (const k of keys) { if (previous[k] === undefined) delete globalThis[k]; else globalThis[k] = previous[k]; }
  }
});

test('Settings exposes a labelled persistent boolean switch, including saved original mode', () => {
  const elements = new Map(), el = { querySelector: (s) => { if (!elements.has(s)) elements.set(s, { addEventListener: (name, fn) => { elements.get(s)[name] = fn; } }); return elements.get(s); }, querySelectorAll: () => [] };
  let patch;
  renderSettings(el, { volume: 0.5, audioV2: false, quality: 'high', pixelRatio: 1 }, { settings: (p) => { patch = p; } });
  assert(el.innerHTML.includes('role="switch"')); assert(!el.innerHTML.match(/data-audio-v2 checked/));
  elements.get('[data-audio-v2]').change({ target: { checked: true } }); assert.deepEqual(patch, { audioV2: true });
});

test('original procedural engine remains finite and available', () => {
  const d = new EngineDSP(48000, 'focus', 1); d.setProfile(ENGINE_PROFILES['gt-v8-cross']);
  const L = new Float32Array(128), R = new Float32Array(128), I = new Float32Array(128); d.render(L, R, I, 128, { ...SAMPLE_PARAMS, rpm: 6000, throttle: 1, level: 0.5 });
  assert(L.every(Number.isFinite));
});
