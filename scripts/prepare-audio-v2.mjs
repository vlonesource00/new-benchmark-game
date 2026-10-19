// Rebuild the bundled audio from the credited CC0 source previews. Requires ffmpeg.
// node scripts/prepare-audio-v2.mjs [--download]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, '.tmp/audio-v2-source'), output = path.join(root, 'game/render/audio/samples');
const sources = {
  v8: 'https://cdn.freesound.org/previews/127/127980_2335231-hq.mp3',
  flat: 'https://cdn.freesound.org/previews/90/90404_1473497-hq.mp3',
  flatplane: 'https://cdn.freesound.org/previews/241/241083_3450345-hq.mp3',
  turbo: 'https://cdn.freesound.org/previews/496/496171_1784475-hq.mp3',
  tyre: 'https://cdn.freesound.org/previews/71/71738_995351-hq.mp3',
  rain: 'https://opengameart.org/sites/default/files/1_7.mp3'
};
fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(output, { recursive: true });
if (process.argv.includes('--download')) {
  for (const [name, url] of Object.entries(sources)) {
    const r = await fetch(url); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    fs.writeFileSync(path.join(source, `${name}.mp3`), Buffer.from(await r.arrayBuffer()));
  }
}

const sr = 32000;
function decode(name, at, duration, filters) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', path.join(source, `${name}.mp3`), '-t', String(duration), '-af', filters, '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { maxBuffer: 12e6 });
  if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr?.toString()}`);
  const view = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  return view.slice();
}
function loop(data, fadeSeconds, rmsTarget) {
  const fade = Math.round(sr * fadeSeconds), n = data.length - fade, out = data.slice(0, n);
  // Constant-amplitude wrap crossfade (no equal-power bump on correlated engine cycles).
  for (let i = 0; i < fade; i++) {
    const x = 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
    out[i] = data[n + i] * (1 - x) + data[i] * x;
  }
  const mean = out.reduce((a, b) => a + b, 0) / n;
  let energy = 0, peak = 0;
  for (let i = 0; i < n; i++) { out[i] -= mean; energy += out[i] ** 2; peak = Math.max(peak, Math.abs(out[i])); }
  const gain = Math.min(rmsTarget / Math.sqrt(energy / n), 0.82 / peak);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}
export function wav(data, rate = sr) {
  const b = Buffer.alloc(44 + data.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), 44 + i * 2);
  return b;
}
const banks = {
  v8: ['v8', [2.05, 0.25, 0.82]],
  flat: ['flat', [0.85, 3.85, 5.05]],
  race: ['flatplane', [2.1, 5.1, 8.25]],
  turbo: ['turbo', [11.6, 2.55, 6.65]]
};
for (const [bank, [name, starts]] of Object.entries(banks)) {
  for (let k = 0; k < 3; k++) {
    const data = loop(decode(name, starts[k], 0.48, 'highpass=f=55,lowpass=f=8500'), 0.045, 0.22);
    fs.writeFileSync(path.join(output, `${bank}-${k}.wav`), wav(data));
  }
}
fs.writeFileSync(path.join(output, 'rain.wav'), wav(loop(decode('rain', 2, 14, 'highpass=f=100,lowpass=f=4200'), 0.45, 0.18)));
fs.writeFileSync(path.join(output, 'tyre.wav'), wav(loop(decode('tyre', 7.6, 1.8, 'highpass=f=550,lowpass=f=4000'), 0.12, 0.2)));
const files = fs.readdirSync(output).filter((f) => f.endsWith('.wav'));
console.log(`${files.length} bundled clips, ${(files.reduce((s, f) => s + fs.statSync(path.join(output, f)).size, 0) / 1024).toFixed(0)} KiB`);
