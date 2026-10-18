// Procedural sound assets. Everything the race audio plays that is not the
// live engine is generated here, in code, at load: no recorded samples, so
// nothing to license. Each generator returns { sr, ch: [Float32Array...] };
// engine.js turns them into AudioBuffers.
//
// Design rule: beds are built from sound events (voiced syllables, wing
// chirps, wave crests, stones, droplets), not from steady filtered noise, so
// nothing turns into a constant hiss. The few genuinely noisy things (wind,
// spray, rain, a blow-off valve) are band-limited and only play when their
// cause is present.
import { Biquad, Tube, rng } from './worklet.js';

const TAU = Math.PI * 2;
const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

function normalize(chs, peak = 0.9) {
  let m = 0; for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > m) m = a; }
  if (m > 0) { const k = peak / m; for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k; }
  return chs;
}
/** Makes a seamless loop: renders `fade` extra samples and crossfades them over the head. */
function loopify(ch, fade) {
  const n = ch.length - fade, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ch[i];
  for (let i = 0; i < fade; i++) { const x = i / fade, a = Math.sin(x * Math.PI / 2), b = Math.cos(x * Math.PI / 2); out[i] = ch[i] * a + ch[n + i] * b; }
  return out;
}
const fadeEdges = (c, sr, ms = 4) => { const k = Math.min(c.length >> 1, Math.round(sr * ms / 1000)); for (let i = 0; i < k; i++) { const g = i / k; c[i] *= g; c[c.length - 1 - i] *= g; } return c; };
function gauss(R) { return (R() + R() + R() + R() - 2) * 1.2; }

// ---------- noise beds ----------
export function pinkNoise(sr, sec, seed = 1) {
  const R = rng(seed), n = Math.floor(sr * sec), c = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) { const w = R() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; c[i] = b0 + b1 + b2 + w * 0.1848; }
  return { sr, ch: normalize([loopify(c, Math.min(n >> 2, sr >> 2))], 0.7) };
}
export function brownNoise(sr, sec, seed = 2) {
  const R = rng(seed), n = Math.floor(sr * sec), c = new Float32Array(n); let l = 0;
  for (let i = 0; i < n; i++) { l = (l + 0.02 * (R() * 2 - 1)) / 1.02; c[i] = l; }
  const hp = new Biquad().set('highpass', 25, 0.7, sr); for (let i = 0; i < n; i++) c[i] = hp.run(c[i]);
  return { sr, ch: normalize([loopify(c, sr >> 2)], 0.7) };
}
/** A slow random control signal in [-1, 1] (cosine-interpolated points at `rate` Hz). */
export function smoothRandom(sr, sec, rate, seed = 3) {
  const R = rng(seed), n = Math.floor(sr * sec), c = new Float32Array(n), step = sr / rate;
  const pts = Array.from({ length: Math.ceil(n / step) + 2 }, () => R() * 2 - 1); pts[pts.length - 1] = pts[0]; pts[pts.length - 2] = pts[0];
  for (let i = 0; i < n; i++) { const f = i / step, k = Math.floor(f), x = (1 - Math.cos((f - k) * Math.PI)) / 2; c[i] = pts[k] * (1 - x) + pts[k + 1] * x; }
  return { sr, ch: [c] };
}

// ---------- exhaust pops, gear clunks, impacts ----------
/** Exhaust afterfire: a sharp, ragged pressure front through a header and tailpipe, with a low thump. */
export function exhaustPop(sr, seed, kind = 'pop') {
  const R = rng(seed), big = kind === 'bang', shift = kind === 'shift';
  const n = Math.floor(sr * (big ? 0.9 : 0.4)), c = new Float32Array(n);
  const h = new Tube(), t = new Tube(), gasC = 560 + R() * 120;
  const dH = 2 * (0.45 + R() * 0.35) / gasC * sr, dT = 2 * (1.1 + R() * 0.9) / gasC * sr;
  const lp = new Biquad().set('lowpass', shift ? 7500 : big ? 4200 : 5600, 0.7, sr), body = new Biquad().set('peaking', 140 + R() * 60, 1, sr, big ? 7 : 4);
  const shots = [[0, 1]];
  if (big) for (let k = 0, at = 0.06; k < 2 + Math.floor(R() * 3); k++) { shots.push([at, 0.35 + R() * 0.3]); at += 0.03 + R() * 0.06; }
  const tau = (shift ? 0.0012 : big ? 0.004 : 0.0022) * sr, thumpHz = big ? 70 : 110, thumpTau = (big ? 0.07 : 0.03) * sr;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const [at, g] of shots) {
      const j = i - Math.floor(at * sr); if (j < 0) continue;
      const env = (1 - Math.exp(-j / (0.00015 * sr))) * Math.exp(-j / (tau * (g < 1 ? 0.7 : 1)));
      x += (R() * 2 - 1) * env * g * 1.4 + Math.sin(TAU * thumpHz * (1 - j / (sr * 0.4)) * j / sr) * Math.exp(-j / thumpTau) * g * (big ? 0.9 : 0.5);
    }
    let y = t.run(h.run(x, dH, 0.4, 0.55), dT, -0.6, 0.35);
    y = Math.tanh(y * 1.6);
    c[i] = lp.run(body.run(y));
  }
  return { sr, ch: [fadeEdges(normalize([c])[0], sr, 2)] };
}
/** Dog-ring engagement: a short metallic clack on a dull thump. */
export function gearClunk(sr, seed) {
  const R = rng(seed), n = Math.floor(sr * 0.16), c = new Float32Array(n), bp = new Biquad().set('bandpass', 2300 + R() * 900, 4, sr);
  const modes = [[1650 + R() * 300, 0.012], [2850 + R() * 400, 0.008], [4100 + R() * 500, 0.005]];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let x = Math.sin(TAU * (105 * t - 180 * t * t)) * Math.exp(-t / 0.022) * 0.8;
    x += bp.run((R() * 2 - 1) * Math.exp(-t / 0.0025)) * 1.4;
    for (const [f, d] of modes) x += Math.sin(TAU * f * t) * Math.exp(-t / d) * 0.12;
    c[i] = x;
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr, 1)] };
}
/** Contact: a body thump, carbon crunch bursts and debris that rattles away. */
export function impact(sr, seed, heavy = true) {
  const R = rng(seed), n = Math.floor(sr * (heavy ? 1.3 : 0.55)), L = new Float32Array(n), Rr = new Float32Array(n);
  const thump = heavy ? 58 : 85;
  for (let i = 0; i < n; i++) { const t = i / sr, s = Math.sin(TAU * thump * t * (1 - t * 0.9)) * Math.exp(-t / (heavy ? 0.12 : 0.05)) * (heavy ? 1 : 0.6); L[i] += s; Rr[i] += s; }
  const bursts = heavy ? 10 + Math.floor(R() * 6) : 4 + Math.floor(R() * 3);
  for (let b = 0; b < bursts; b++) {
    const at = Math.floor(R() * (heavy ? 0.14 : 0.06) * sr), f = 350 + R() * 2600, bq = new Biquad().set('bandpass', f, 1.2 + R() * 2, sr), d = (0.004 + R() * 0.018) * sr, g = (0.5 + R()) * (b === 0 ? 1.5 : 1), pan = R();
    for (let j = 0; j < d * 6 && at + j < n; j++) { const v = bq.run((R() * 2 - 1) * Math.exp(-j / d)) * g; L[at + j] += v * (1 - pan * 0.6); Rr[at + j] += v * (0.4 + pan * 0.6); }
  }
  const debris = heavy ? 14 + Math.floor(R() * 10) : 4 + Math.floor(R() * 4);
  for (let k = 0; k < debris; k++) {
    const at = Math.floor((0.03 + Math.pow(R(), 1.6) * (heavy ? 0.95 : 0.4)) * sr), f = 1100 + R() * 5200, f2 = f * (1.37 + R() * 0.5), d = (0.012 + R() * 0.07) * sr, g = 0.05 + R() * 0.16, pan = R();
    for (let j = 0; j < d * 5 && at + j < n; j++) { const e = Math.exp(-j / d), v = (Math.sin(TAU * f * j / sr) + 0.5 * Math.sin(TAU * f2 * j / sr)) * e * g; L[at + j] += v * (1 - pan); Rr[at + j] += v * pan; }
  }
  const lp = [new Biquad().set('lowpass', heavy ? 7000 : 8000, 0.7, sr), new Biquad().set('lowpass', heavy ? 7000 : 8000, 0.7, sr)];
  for (let i = 0; i < n; i++) { L[i] = lp[0].run(L[i]); Rr[i] = lp[1].run(Rr[i]); }
  normalize([L, Rr], 0.9); fadeEdges(L, sr, 2); fadeEdges(Rr, sr, 2);
  return { sr, ch: [L, Rr] };
}
/** Blow-off valve: a puff that flutters out, with the compressor whistle falling away. */
export function blowOff(sr, seed) {
  const R = rng(seed), n = Math.floor(sr * 0.7), c = new Float32Array(n), bp = new Biquad().set('bandpass', 2600, 1.1, sr), lp = new Biquad().set('lowpass', 5000, 0.7, sr);
  const flutter = 17 + R() * 6; let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, env = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.13), fl = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(Math.PI * flutter * t)), 3) * Math.min(1, t / 0.06);
    ph += (5200 * Math.exp(-t / 0.25) + 1300) / sr;
    c[i] = lp.run(bp.run((R() * 2 - 1)) * env * fl * 1.3 + Math.sin(TAU * ph) * 0.05 * Math.exp(-t / 0.2));
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr, 2)] };
}
/** Pit wheel gun: motor whine under a hammering anvil, revving up then letting go. */
export function wheelGun(sr, seed) {
  const R = rng(seed), n = Math.floor(sr * (0.55 + R() * 0.25)), c = new Float32Array(n), bp = new Biquad().set('bandpass', 3200, 3, sr), hp = new Biquad().set('highpass', 200, 0.7, sr);
  let ph = 0, hammer = 0; const rate = 24 + R() * 6;
  for (let i = 0; i < n; i++) {
    const t = i / sr, u = t / (n / sr), env = Math.min(1, t / 0.03) * Math.min(1, (1 - u) / 0.08);
    ph += (820 + 380 * Math.min(1, t / 0.15) + (u > 0.8 ? (u - 0.8) * 2500 : 0)) / sr;
    const whine = (Math.sin(TAU * ph) + 0.4 * Math.sin(TAU * ph * 2) + 0.2 * Math.sin(TAU * ph * 3.01)) * 0.18;
    hammer += rate / sr; let hit = 0;
    if (hammer >= 1) hammer -= 1;
    if (hammer < 0.12) { const h = hammer / 0.12; hit = bp.run((R() * 2 - 1)) * Math.exp(-h * 6) * 1.2 + Math.sin(TAU * 4300 * hammer / rate) * Math.exp(-h * 4) * 0.3; } else bp.run(0);
    c[i] = hp.run((whine + hit) * env);
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr, 3)] };
}
/** Air jack: up = a pneumatic punch and short gas rush; down = the car dropping on its tyres. */
export function airJack(sr, seed, up = true) {
  const R = rng(seed), n = Math.floor(sr * (up ? 0.45 : 0.35)), c = new Float32Array(n), bp = new Biquad().set('bandpass', up ? 1800 : 900, 0.9, sr), lp = new Biquad().set('lowpass', 6000, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const thump = Math.sin(TAU * (up ? 95 : 62) * t * (1 - t)) * Math.exp(-t / (up ? 0.04 : 0.07)) * (up ? 0.7 : 1);
    const gas = up ? bp.run(R() * 2 - 1) * Math.min(1, t / 0.005) * Math.exp(-t / 0.09) * 0.6 : bp.run(R() * 2 - 1) * Math.exp(-t / 0.012) * 0.5;
    c[i] = lp.run(thump + gas);
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr, 2)] };
}
export function thunder(sr, seed) {
  const R = rng(seed), n = Math.floor(sr * 8), c = new Float32Array(n), lp = new Biquad(), lp2 = new Biquad();
  const peaks = Array.from({ length: 4 + Math.floor(R() * 4) }, (_, k) => [0.2 + k * (0.6 + R() * 0.9), 0.4 + R() * 0.6]);
  let l = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; let env = 0;
    for (const [at, g] of peaks) { const d = t - at; if (d > 0) env += g * (1 - Math.exp(-d / 0.08)) * Math.exp(-d / (0.6 + g)); }
    if ((i & 127) === 0) { lp.set('lowpass', 90 + 220 * Math.exp(-t / 2.5), 0.8, sr); lp2.set('lowpass', 140 + 240 * Math.exp(-t / 2.5), 0.7, sr); }
    l = (l + 0.04 * (R() * 2 - 1)) / 1.04;
    c[i] = lp2.run(lp.run(l * env));
  }
  normalize([c], 0.9); fadeEdges(c, sr, 200);
  return { sr, ch: [c] };
}

// ---------- surfaces ----------
/** Gravel trap: stones pinging off the floor and wheel arches over a low crunch. */
export function gravelLoop(sr, seed) {
  const R = rng(seed), fade = sr >> 3, n = Math.floor(sr * 2.4) + fade, c = new Float32Array(n), lp = new Biquad().set('lowpass', 220, 0.8, sr);
  let l = 0;
  for (let i = 0; i < n; i++) { l = (l + 0.05 * (R() * 2 - 1)) / 1.05; c[i] = lp.run(l) * 0.9; }
  for (let k = 0; k < 2.6 * 520; k++) {
    const at = Math.floor(R() * (n - sr * 0.02)), f = 700 + Math.pow(R(), 1.5) * 3800, bq = new Biquad().set('bandpass', f, 2 + R() * 4, sr), d = (0.0008 + R() * 0.004) * sr, g = Math.pow(R(), 2) * 0.9;
    for (let j = 0; j < d * 5; j++) c[at + j] += bq.run((R() * 2 - 1) * Math.exp(-j / d)) * g;
  }
  return { sr, ch: [normalize([loopify(c, fade)], 0.8)[0]] };
}
/** Grass: blades whipping the floor (soft, fast-gated low noise) and the bumps of the ground. */
export function grassLoop(sr, seed) {
  const R = rng(seed), fade = sr >> 3, n = Math.floor(sr * 2.4) + fade, c = new Float32Array(n), lp = new Biquad().set('lowpass', 750, 0.6, sr), hp = new Biquad().set('highpass', 120, 0.7, sr), bump = new Biquad().set('lowpass', 90, 1.2, sr);
  let g = 0, target = 0;
  for (let i = 0; i < n; i++) {
    if ((i % 180) === 0) target = Math.pow(R(), 2);
    g += (target - g) * 0.01;
    c[i] = hp.run(lp.run(R() * 2 - 1)) * (0.25 + g) * 0.6 + bump.run(R() < 0.0008 ? (R() * 2 - 1) * 60 : 0) * 0.5;
  }
  return { sr, ch: [normalize([loopify(c, fade)], 0.8)[0]] };
}
/** Rain: thousands of droplets (clicks and tiny pings) over a soft, low bed. */
export function rainLoop(sr, seed) {
  const R = rng(seed), fade = sr >> 2, n = Math.floor(sr * 5) + fade, L = new Float32Array(n), Rr = new Float32Array(n);
  const bed = [new Biquad().set('lowpass', 1400, 0.6, sr), new Biquad().set('lowpass', 1400, 0.6, sr)];
  for (let i = 0; i < n; i++) { L[i] = bed[0].run(R() * 2 - 1) * 0.08; Rr[i] = bed[1].run(R() * 2 - 1) * 0.08; }
  for (let k = 0; k < 5.25 * 1400; k++) {
    const at = Math.floor(R() * (n - sr * 0.02)), f = 1800 + R() * 5000, d = (0.0006 + R() * 0.0028) * sr, g = Math.pow(R(), 3) * 0.6, pan = R();
    for (let j = 0; j < d * 5; j++) { const v = (Math.sin(TAU * f * j / sr) * 0.7 + (j < 2 ? R() - 0.5 : 0)) * Math.exp(-j / d) * g; L[at + j] += v * (1 - pan); Rr[at + j] += v * pan; }
  }
  return { sr, ch: normalize([loopify(L, fade), loopify(Rr, fade)], 0.8) };
}

// ---------- nature and crowd ----------
const VOWELS = [[730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870], [660, 1720], [490, 1350], [440, 1020]];
/**
 * Crowd babble: dozens of voiced talkers (glottal pulses through moving vowel
 * formants, in syllables and pauses), spread across the stereo field and
 * blurred by distance. `excite` 0 = murmur loop, 1 = a cheer (one-shot).
 */
export async function crowd(sr, seed, sec, excite = 0) {
  const R = rng(seed), fade = excite ? 0 : Math.floor(sr * 0.8), n = Math.floor(sr * sec) + fade;
  const L = new Float32Array(n), Rr = new Float32Array(n), voices = excite ? 46 : 30;
  for (let v = 0; v < voices; v++) {
    const male = R() < 0.6, f0 = (male ? 95 + R() * 50 : 175 + R() * 70) * (excite ? 1.35 + R() * 0.35 : 1);
    const pan = R(), dist = 0.35 + R() * 0.65, f1 = new Biquad(), f2 = new Biquad();
    let i = Math.floor(R() * sr * 0.6), ph = 0;
    while (i < n) {
      const dur = Math.floor((excite ? 0.35 + R() * 1.2 : 0.07 + R() * 0.2) * sr), gap = Math.floor((excite ? 0.05 + R() * 0.25 : R() < 0.15 ? 0.4 + R() * 1.2 : 0.03 + R() * 0.12) * sr);
      const [F1, F2] = VOWELS[Math.floor(R() * VOWELS.length)], k = 0.9 + R() * 0.2;
      f1.set('bandpass', F1 * k * (male ? 1 : 1.15), 5, sr); f2.set('bandpass', F2 * k * (male ? 1 : 1.12), 9, sr);
      const glide = (R() - 0.5) * (excite ? 0.5 : 0.25), amp = (0.4 + R() * 0.6) * dist;
      for (let j = 0; j < dur && i + j < n; j++) {
        const x = j / dur, env = Math.pow(Math.sin(Math.PI * Math.min(1, x * (excite ? 1.6 : 1.1))), 0.7) * (excite ? Math.min(1, (1 - x) * 3) : 1);
        const f = f0 * (1 + glide * (x - 0.3)) * (1 + 0.012 * Math.sin(TAU * 5.5 * j / sr) * excite);
        ph += f / sr; if (ph >= 1) ph -= 1;
        const exc = ph < 0.4 ? Math.sin(Math.PI * ph / 0.4) ** 2 - 0.25 : -0.25;
        const y = (f1.run(exc) + 0.45 * f2.run(exc) + (R() - 0.5) * 0.02) * env * amp;
        L[i + j] += y * (1 - pan); Rr[i + j] += y * pan;
      }
      i += dur + gap;
    }
    if ((v & 3) === 3) await yieldFrame();
  }
  // Distance: high frequencies fall away and a little diffusion smears the talkers together.
  for (const c of [L, Rr]) {
    const lp = new Biquad().set('lowpass', excite ? 3600 : 2600, 0.7, sr), hp = new Biquad().set('highpass', 120, 0.7, sr);
    const d1 = Math.floor(sr * 0.023), d2 = Math.floor(sr * 0.037), b = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) { const x = hp.run(lp.run(c[i])); b[i] = x + (i >= d1 ? b[i - d1] * 0.35 : 0) + (i >= d2 ? b[i - d2] * 0.25 : 0); }
    c.set(b);
  }
  if (excite) { for (let i = 0; i < n; i++) { const t = i / n, e = Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.45); L[i] *= e; Rr[i] *= e; } return { sr, ch: normalize([L, Rr], 0.85) }; }
  return { sr, ch: normalize([loopify(L, fade), loopify(Rr, fade)], 0.8) };
}
/** Songbird phrase: chirps, sweeps and trills. `low` = a fluty blackbird. */
export function birdSong(sr, seed, low = false) {
  const R = rng(seed), notes = low ? 4 + Math.floor(R() * 4) : 5 + Math.floor(R() * 9);
  const parts = []; let t = 0.02;
  for (let k = 0; k < notes; k++) {
    const d = low ? 0.12 + R() * 0.2 : 0.03 + R() * 0.13, f = low ? 1600 + R() * 1600 : 2600 + R() * 3800;
    parts.push({ t, d, f, f2: f * (low ? 0.85 + R() * 0.4 : 0.6 + R() * 0.9), trill: !low && R() < 0.3 ? 30 + R() * 30 : 0, a: 0.5 + R() * 0.5 });
    t += d + (low ? 0.06 + R() * 0.12 : 0.02 + R() * 0.08);
  }
  const n = Math.floor(sr * (t + 0.05)), c = new Float32Array(n);
  for (const p of parts) {
    let ph = 0; const i0 = Math.floor(p.t * sr), m = Math.floor(p.d * sr);
    for (let j = 0; j < m && i0 + j < n; j++) {
      const x = j / m, f = p.f + (p.f2 - p.f) * x + (p.trill ? Math.sin(TAU * p.trill * j / sr) * 600 : 0);
      ph += f / sr; const env = Math.sin(Math.PI * x) ** 1.5;
      c[i0 + j] += (Math.sin(TAU * ph) + 0.08 * Math.sin(2 * TAU * ph)) * env * p.a;
    }
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr)] };
}
/** Gull: a raucous, harmonic "kyow" call repeated and falling away. */
export function gullCall(sr, seed) {
  const R = rng(seed), calls = 2 + Math.floor(R() * 3), base = 650 + R() * 250, n = Math.floor(sr * (calls * 0.42 + 0.1)), c = new Float32Array(n);
  const f1 = new Biquad().set('bandpass', 1900, 2, sr), f2 = new Biquad().set('bandpass', 3300, 3, sr);
  let ph = 0;
  for (let k = 0; k < calls; k++) {
    const i0 = Math.floor((0.02 + k * 0.42) * sr), m = Math.floor((0.24 + R() * 0.1) * sr), drop = 1 - k * 0.07;
    for (let j = 0; j < m && i0 + j < n; j++) {
      const x = j / m, f = base * drop * (x < 0.35 ? 1 + x * 1.4 : 1.49 - (x - 0.35) * 0.9);
      ph += f / sr; if (ph >= 1) ph -= 1;
      let s = 0; for (let h = 1; h <= 8; h++) s += Math.sin(TAU * ph * h) / Math.pow(h, 0.8);
      const env = Math.sin(Math.PI * x) ** 0.8;
      c[i0 + j] += (f1.run(s) + 0.6 * f2.run(s)) * env * (1 - k * 0.15);
    }
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr)] };
}
/** Bird of prey: a long, falling "kee-eeer". */
export function hawkCry(sr, seed) {
  const R = rng(seed), n = Math.floor(sr * 1.4), c = new Float32Array(n), f0 = 2700 + R() * 400; let ph = 0;
  for (let i = 0; i < n; i++) { const x = i / n, f = f0 * (1 - 0.25 * x) * (1 + 0.01 * Math.sin(TAU * 7 * i / sr)); ph += f / sr; c[i] = (Math.sin(TAU * ph) + 0.25 * Math.sin(2 * TAU * ph)) * Math.min(1, x * 12) * Math.pow(1 - x, 1.4); }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr)] };
}
/** Cuckoo: two soft falling notes, twice. */
export function cuckoo(sr, seed) {
  const R = rng(seed), f = 660 + R() * 60, n = Math.floor(sr * 1.9), c = new Float32Array(n);
  [[0.02, f], [0.32, f * 0.82], [1.02, f], [1.32, f * 0.82]].forEach(([t, fr]) => {
    const i0 = Math.floor(t * sr), m = Math.floor(0.24 * sr);
    for (let j = 0; j < m; j++) { const x = j / m, ph = fr * j / sr; c[i0 + j] += (Math.sin(TAU * ph) + 0.15 * Math.sin(2 * TAU * ph)) * Math.min(1, x * 8) * Math.pow(1 - x, 1.2); }
  });
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr)] };
}
/** Alpine cowbells: a few loose, clanking dongs. */
export function cowbells(sr, seed) {
  const R = rng(seed), n = Math.floor(sr * 3.2), c = new Float32Array(n), partials = [1, 1.48, 2.09, 2.58, 3.3];
  for (let k = 0; k < 2 + Math.floor(R() * 4); k++) {
    const i0 = Math.floor(R() * 2.2 * sr), f = 480 + R() * 260, a = 0.4 + R() * 0.6;
    for (let j = 0; j < sr * 0.9 && i0 + j < n; j++) { const t = j / sr; let s = 0; partials.forEach((p, q) => { s += Math.sin(TAU * f * p * t) * Math.exp(-t / (0.35 / (1 + q * 0.6))) / (1 + q * 0.5); }); c[i0 + j] += (s + (j < sr * 0.004 ? (R() - 0.5) * 2 : 0)) * a; }
  }
  return { sr, ch: [fadeEdges(normalize([c], 0.8)[0], sr)] };
}
/** Ship's horn across the water: two low, reedy notes. */
export function shipHorn(sr) {
  const n = Math.floor(sr * 4), c = new Float32Array(n), lp = new Biquad().set('lowpass', 1100, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr, env = Math.min(1, t / 0.35) * Math.min(1, (3.4 - t) / 0.8) * (t < 3.4 ? 1 : 0);
    let s = 0; for (const f of [92, 138.5]) for (let h = 1; h <= 18; h++) s += Math.sin(TAU * f * h * t * (1 + 0.002 * Math.sin(TAU * 4.5 * t))) / h;
    c[i] = lp.run(s * env);
  }
  return { sr, ch: [normalize([c], 0.8)[0]] };
}
/** Cicadas: buzzing pulse trains on a high carrier, in overlapping phrases. */
export function cicadaLoop(sr, seed) {
  const R = rng(seed), fade = sr >> 1, n = Math.floor(sr * 7) + fade, L = new Float32Array(n), Rr = new Float32Array(n);
  for (let k = 0; k < 6; k++) {
    const fc = 4200 + R() * 2400, rate = 110 + R() * 140, pan = R(), a = 0.3 + R() * 0.7;
    let t0 = R() * 2;
    while (t0 < n / sr) {
      const dur = 1.5 + R() * 3.5, i0 = Math.floor(t0 * sr), m = Math.floor(dur * sr);
      for (let j = 0; j < m && i0 + j < n; j++) {
        const t = j / sr, x = j / m, pulse = Math.pow(Math.max(0, Math.sin(Math.PI * rate * t)), 6), env = Math.min(1, x * 6) * Math.min(1, (1 - x) * 4);
        const v = (Math.sin(TAU * fc * t) + 0.3 * Math.sin(TAU * fc * 1.5 * t)) * pulse * env * a;
        L[i0 + j] += v * (1 - pan); Rr[i0 + j] += v * pan;
      }
      t0 += dur + 0.4 + R() * 2;
    }
  }
  return { sr, ch: normalize([loopify(L, fade), loopify(Rr, fade)], 0.7) };
}
/** Harbour water: waves rising, breaking and washing back over a low swell. */
export function seaLoop(sr, seed) {
  const R = rng(seed), fade = sr, n = Math.floor(sr * 12) + fade, L = new Float32Array(n), Rr = new Float32Array(n);
  const waves = Array.from({ length: 9 }, (_, k) => ({ at: k * 1.45 + R() * 0.6, g: 0.5 + R() * 0.5, pan: 0.2 + R() * 0.6 }));
  const f = [new Biquad(), new Biquad()]; let bL = 0, bR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; let env = 0, pan = 0, wsum = 0;
    for (const w of waves) { const d = t - w.at; if (d > 0 && d < 5) { const e = w.g * (1 - Math.exp(-d / 0.9)) * Math.exp(-d / 1.2); env += e; pan += w.pan * e; wsum += e; } }
    pan = wsum > 0 ? pan / wsum : 0.5;
    if ((i & 255) === 0) { f[0].set('lowpass', 260 + env * 900, 0.6, sr); f[1].set('lowpass', 260 + env * 900, 0.6, sr); }
    bL = (bL + 0.03 * (R() * 2 - 1)) / 1.03; bR = (bR + 0.03 * (R() * 2 - 1)) / 1.03;
    L[i] = f[0].run(bL) * (0.25 + env * (1.2 - pan)); Rr[i] = f[1].run(bR) * (0.25 + env * (0.2 + pan));
  }
  return { sr, ch: normalize([loopify(L, fade), loopify(Rr, fade)], 0.7) };
}
/** Leaves in the trees: soft rustle that comes and goes with gusts. */
export function leavesLoop(sr, seed) {
  const R = rng(seed), fade = sr >> 1, n = Math.floor(sr * 10) + fade, L = new Float32Array(n), Rr = new Float32Array(n);
  const gust = smoothRandom(sr, n / sr, 0.35, seed + 1).ch[0];
  const bp = [new Biquad().set('bandpass', 1500, 0.8, sr), new Biquad().set('bandpass', 1500, 0.8, sr)], lp = [new Biquad().set('lowpass', 3500, 0.7, sr), new Biquad().set('lowpass', 3500, 0.7, sr)];
  let flick = 0;
  for (let i = 0; i < n; i++) {
    const g = Math.pow(0.5 + 0.5 * gust[i], 2.2);
    if ((i % 64) === 0) flick = 0.4 + R() * 0.6;
    L[i] = lp[0].run(bp[0].run(R() * 2 - 1)) * g * flick; Rr[i] = lp[1].run(bp[1].run(R() * 2 - 1)) * g * (1.4 - flick);
  }
  return { sr, ch: normalize([loopify(L, fade), loopify(Rr, fade)], 0.6) };
}
/** Open-country wind: a low, gusting rumble (no high hiss). */
export function windLoop(sr, seed) {
  const R = rng(seed), fade = sr >> 1, n = Math.floor(sr * 10) + fade, L = new Float32Array(n), Rr = new Float32Array(n);
  const gust = smoothRandom(sr, n / sr, 0.25, seed + 2).ch[0], f = [new Biquad(), new Biquad()]; let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * gust[i], 1.6);
    if ((i & 255) === 0) { f[0].set('lowpass', 180 + g * 380, 0.9, sr); f[1].set('lowpass', 200 + g * 360, 0.9, sr); }
    a = (a + 0.04 * (R() * 2 - 1)) / 1.04; b = (b + 0.04 * (R() * 2 - 1)) / 1.04;
    L[i] = f[0].run(a) * g; Rr[i] = f[1].run(b) * g;
  }
  return { sr, ch: normalize([loopify(L, fade), loopify(Rr, fade)], 0.7) };
}

// ---------- reverb ----------
export const ROOMS = {
  // Harbour: quay walls and buildings, a slap across the water.
  harbor: { rt: 1.6, pre: 18, damp: 0.55, er: [[23, 0.5], [41, 0.4], [67, 0.3]], echo: [[180, 0.22]] },
  // Grandstands close to the track: bright, short reflections.
  stands: { rt: 1.25, pre: 10, damp: 0.4, er: [[15, 0.55], [28, 0.45], [52, 0.3]], echo: [] },
  // Mountain valley: a diffuse field and a clear echo off the rock faces.
  valley: { rt: 1.1, pre: 14, damp: 0.6, er: [[31, 0.3]], echo: [[430, 0.32], [880, 0.16]] },
  // Desert: wide open, short and dry.
  open: { rt: 0.65, pre: 26, damp: 0.5, er: [[38, 0.3]], echo: [] },
  // Forest: dense and dark, the trees soak up the highs.
  forest: { rt: 1.8, pre: 9, damp: 0.78, er: [[12, 0.4], [19, 0.35], [33, 0.3], [47, 0.25]], echo: [] }
};
export function impulseResponse(sr, room, seed = 9) {
  const R = rng(seed), n = Math.floor(sr * (room.rt + 0.3 + Math.max(0, ...room.echo.map((e) => e[0] / 1000)))), pre = Math.floor(room.pre / 1000 * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const c = out[ch]; let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr, decay = Math.exp(-6.9 * t / room.rt), k = 0.85 - (0.85 - (1 - room.damp)) * Math.min(1, t / room.rt);
      lp += (gauss(R) - lp) * Math.max(0.05, k);
      c[i] = lp * decay * Math.min(1, t / 0.006);
    }
    for (const [ms, g] of room.er) { const at = Math.floor((ms * (ch ? 1.07 : 0.94)) / 1000 * sr); for (let j = 0; j < 24 && at + j < n; j++) c[at + j] += g * 0.9 * Math.exp(-j / 4) * (R() - 0.3); }
    for (const [ms, g] of room.echo) { const at = Math.floor((ms + (ch ? 9 : 0)) / 1000 * sr), bq = new Biquad().set('lowpass', 2400, 0.7, sr); for (let j = 0; j < sr * 0.08 && at + j < n; j++) c[at + j] += bq.run(gauss(R)) * g * Math.exp(-j / (sr * 0.018)); }
  }
  let e = 0; for (const c of out) for (const v of c) e += v * v;
  const k = 1 / Math.sqrt(e / 2 + 1e-12); for (const c of out) for (let i = 0; i < n; i++) c[i] *= k;
  return { sr, ch: out };
}
