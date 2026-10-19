import { Biquad, rng } from './worklet.js';

export const V2_LEVELS = Object.freeze({
  engine: 0.72, intakeOnboard: 0.65, intakeOutside: 0.18, exhaustOnboard: 0.8,
  rival: 0.48, field: 0.28, tyres: 0.32, wind: 0.045, road: 0.035, surface: 0.26,
  whine: 0.0035, mgu: 0.012, ambience: 0.24, ambienceMenu: 0.2, rain: 0.16,
  fx: 0.42, ui: 0.16, reverb: 0.035, impacts: 0.8, pops: 0.65, scrub: 0.65
});

/** Single pressure release, with a smooth tail. No secondary cracker bursts, combs or ringing modes. */
export function pressureRelease(sr, seed, kind = 'pop') {
  const random = rng(seed), big = kind === 'bang', shift = kind === 'shift';
  const seconds = big ? 0.28 : shift ? 0.12 : 0.18, n = Math.round(sr * seconds), ch = new Float32Array(n);
  const lp = new Biquad().set('lowpass', big ? 1200 : 1800, 0.65, sr);
  const air = new Biquad().set('lowpass', 550, 0.6, sr), hp = new Biquad().set('highpass', 40, 0.7, sr);
  const width = (big ? 0.0045 : shift ? 0.0018 : 0.0028) * (0.9 + random() * 0.2);
  for (let i = 0; i < n; i++) {
    const t = i / sr, u = (t - 0.009) / width;
    const front = -u * Math.exp(-0.5 * u * u);
    const envelope = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / (big ? 0.045 : 0.025));
    const gas = air.run(random() * 2 - 1) * envelope * 0.8;
    const fade = Math.min(1, t / 0.002) * Math.min(1, (seconds - t) / 0.035);
    ch[i] = lp.run(hp.run(front + gas)) * fade * (big ? 0.9 : 0.7);
  }
  return { sr, ch: [ch] };
}

/** Damped material Foley: broadband hits and air, with no musical metal resonances. */
export function materialEffect(sr, seed, kind) {
  const random = rng(seed), gun = kind === 'gun', heavy = kind === 'heavy', up = kind === 'jackUp';
  const duration = gun ? 0.48 : heavy ? 0.55 : kind.startsWith('jack') ? 0.28 : kind === 'bov' ? 0.3 : 0.16;
  const n = Math.round(duration * sr), ch = new Float32Array(n);
  const low = new Biquad().set('lowpass', heavy ? 900 : gun ? 2200 : kind === 'bov' ? 2600 : 1400, 0.65, sr);
  const hp = new Biquad().set('highpass', kind === 'bov' ? 450 : 45, 0.65, sr);
  const rate = 37 + random() * 7;
  for (let i = 0; i < n; i++) {
    const t = i / sr, fade = Math.min(1, t / 0.003) * Math.min(1, (duration - t) / 0.035);
    let envelope;
    if (gun) envelope = 0.13 + 0.7 * Math.exp(-((t * rate) % 1) * 12);
    else if (kind === 'bov' || up) envelope = (1 - Math.exp(-t / 0.008)) * Math.exp(-t / 0.06);
    else envelope = Math.exp(-t / (heavy ? 0.07 : 0.022));
    const noise = (random() * 2 - 1) * envelope;
    // A low, short body impact underneath the broadband panel/ground texture.
    const thud = kind === 'bov' || gun ? 0 : Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t / 0.025) * 0.18;
    ch[i] = low.run(hp.run(noise + thud)) * fade * (gun ? 0.5 : heavy ? 1 : 0.65);
  }
  return { sr, ch: [ch] };
}

/** Revoice a continuous surface/air layer without narrow bands or bright transient tails. */
export function softenAsset(asset, cutoff = 2800, gain = 0.7) {
  const ch = asset.ch.map((source) => {
    const a = new Biquad().set('lowpass', cutoff, 0.65, asset.sr), b = new Biquad().set('highpass', 40, 0.65, asset.sr);
    return Float32Array.from(source, (x) => a.run(b.run(x)) * gain);
  });
  return { sr: asset.sr, ch };
}
