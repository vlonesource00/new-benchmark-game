// Bundled, offline recordings. Sources, edits and CC0 dedication: samples/CREDITS.md.
const url = (name) => new URL(`./samples/${name}.wav`, import.meta.url).href;
const KEYS = ['v8', 'flat', 'race', 'turbo'];
// Measured repeating firing texture of each selected layer, in Hz (not claimed source-car RPM).
const FIRING_HZ = { v8: [75.1, 118.5, 115.5], flat: [48.9, 60.4, 118.1], race: [59.5, 125, 213.3], turbo: [53.6, 113.9, 205.1] };
export const RECORDING_URLS = Object.fromEntries(KEYS.map((key) => [key, [0, 1, 2].map((k) => url(`${key}-${k}`))]));
export const RAIN_URL = new URL('./samples/rain.wav', import.meta.url).href;
export const TYRE_URL = new URL('./samples/tyre.wav', import.meta.url).href;

const TAPS = Array.from({ length: 31 }, (_, k) => {
  const x = k - 15;
  return (x === 0 ? 0.44 : Math.sin(2 * Math.PI * 0.22 * x) / (Math.PI * x)) * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / 30));
});
const tapSum = TAPS.reduce((a, b) => a + b); TAPS.forEach((x, i) => { TAPS[i] = x / tapSum; });
export function prepareRecordingLayer(data, sr, fraction, firingHz) {
  // Band-limited mip levels prevent the high-rev playback rates folding bright source harmonics
  // back into the audible band. Built once on the host, shared by all profiles in the pack.
  const mips = [data];
  for (let level = 1; level <= 4; level++) {
    const previous = mips.at(-1), next = new Float32Array(Math.floor(previous.length / 2));
    for (let i = 0; i < next.length; i++) {
      let sum = 0;
      for (let j = 0; j < TAPS.length; j++) sum += previous[(i * 2 + j - 15 + previous.length) % previous.length] * TAPS[j];
      next[i] = sum;
    }
    mips.push(next);
  }
  return { fraction, sr, data, mips, firingHz };
}

export async function loadRecordings(ctx, fetcher = fetch) {
  const read = async (u) => {
    const r = await fetcher(u);
    if (!r.ok) throw new Error(`Audio recording unavailable (${r.status})`);
    return ctx.decodeAudioData(await r.arrayBuffer());
  };
  // One small pack, decoded once per context, rather than a request per engine voice.
  const recordings = {};
  for (const key of KEYS) {
    recordings[key] = [];
    for (let k = 0; k < 3; k++) {
      const b = await read(RECORDING_URLS[key][k]);
      recordings[key].push(prepareRecordingLayer(b.getChannelData(0).slice(), b.sampleRate, k * 0.5, FIRING_HZ[key][k]));
    }
  }
  return { recordings, rain: await read(RAIN_URL), tyre: await read(TYRE_URL) };
}
