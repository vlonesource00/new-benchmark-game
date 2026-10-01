import * as THREE from 'three';
import { random } from '../engine/sim/math.js';

// Procedural PBR texture kit for the sandbox presentation layer. Every map is
// generated once on a canvas and cached, so no binary textures ship with it.
const cache = new Map();
const memo = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };

function canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function texture(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso; return t;
}

// Tileable value noise with octaves; returns Float32Array heights 0..1.
export function fbmField(size, octaves = 5, seed = 1, base = 4) {
  const rng = random(seed), out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = base << o, grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * cells, fy = y / size * cells, ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const x1 = (ix + 1) % cells, y1 = (iy + 1) % cells;
      const a = grid[iy * cells + ix], b = grid[iy * cells + x1], c = grid[y1 * cells + ix], d = grid[y1 * cells + x1];
      out[y * size + x] += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
    }
    total += amp; amp *= .5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function normalFromHeight(h, size, strength) {
  const c = canvas(size), x = c.getContext('2d'), img = x.createImageData(size, size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const l = h[j * size + (i - 1 + size) % size], r = h[j * size + (i + 1) % size];
    const u = h[((j - 1 + size) % size) * size + i], d = h[((j + 1) % size) * size + i];
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1; const len = Math.hypot(nx, ny, nz);
    const k = (j * size + i) * 4; img.data[k] = (nx / len * .5 + .5) * 255; img.data[k + 1] = (ny / len * .5 + .5) * 255; img.data[k + 2] = (nz / len * .5 + .5) * 255; img.data[k + 3] = 255;
  }
  x.putImageData(img, 0, 0); return texture(c, { srgb: false });
}

function grey(values, size, map) {
  const c = canvas(size), x = c.getContext('2d'), img = x.createImageData(size, size);
  for (let i = 0; i < size * size; i++) { const v = map(values[i], i); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0); return c;
}

// Race asphalt: dense aggregate, sealed cracks, subtle tar patches.
export function asphaltMaps() {
  return memo('asphalt', () => {
    const size = 1024, rng = random(811), macro = fbmField(size, 5, 13, 4), height = new Float32Array(size * size);
    const col = canvas(size), cx = col.getContext('2d'), img = cx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const stone = rng(), m = macro[i];
      const bright = stone > .93 ? 34 + rng() * 40 : stone > .6 ? 8 + rng() * 14 : rng() * 7;
      const v = 38 + (m - .5) * 22 + bright;
      img.data[i * 4] = v * .98; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 1.03; img.data[i * 4 + 3] = 255;
      height[i] = stone > .6 ? .5 + rng() * .5 : rng() * .35;
    }
    cx.putImageData(img, 0, 0);
    // Sealed cracks and patch repairs.
    cx.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      cx.strokeStyle = 'rgba(12,12,13,.55)'; cx.lineWidth = 2 + rng() * 3; cx.beginPath();
      let px = rng() * size, py = rng() * size; cx.moveTo(px, py);
      for (let s = 0; s < 14; s++) { px += (rng() - .5) * 70; py += (rng() - .3) * 60; cx.lineTo(px, py); }
      cx.stroke();
    }
    for (let k = 0; k < 5; k++) { cx.fillStyle = `rgba(${18 + rng() * 10},${18 + rng() * 10},${20 + rng() * 10},.22)`; cx.fillRect(rng() * size, rng() * size, 80 + rng() * 220, 60 + rng() * 160); }
    const rough = grey(height, size, (h, i) => 175 + (1 - h) * 60 - macro[i] * 30);
    return { map: texture(col), normalMap: normalFromHeight(height, size, 2.2), roughnessMap: texture(rough, { srgb: false }) };
  });
}

export function grassMaps() {
  return memo('grass', () => {
    const size = 512, rng = random(92), f = fbmField(size, 5, 7, 4);
    const c = canvas(size), x = c.getContext('2d'), img = x.createImageData(size, size), h = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      const blade = rng(), m = f[i];
      const g = 78 + m * 60 + blade * 30, r = 58 + m * 45 + blade * 18, b = 34 + m * 20;
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255; h[i] = blade * .6 + m * .4;
    }
    x.putImageData(img, 0, 0);
    return { map: texture(c), normalMap: normalFromHeight(h, size, 3) };
  });
}

export function gravelMaps() {
  return memo('gravel', () => {
    const size = 512, rng = random(33), c = canvas(size), x = c.getContext('2d'), h = new Float32Array(size * size);
    x.fillStyle = '#8d7c62'; x.fillRect(0, 0, size, size);
    for (let i = 0; i < 9000; i++) {
      const px = rng() * size, py = rng() * size, r = 1 + rng() * 3.2, l = 40 + rng() * 38;
      x.fillStyle = `hsl(${28 + rng() * 16},${14 + rng() * 18}%,${l}%)`; x.beginPath(); x.ellipse(px, py, r, r * (.6 + rng() * .4), rng() * 3, 0, Math.PI * 2); x.fill();
      const ci = (Math.floor(py) * size + Math.floor(px)); h[ci] = 1;
    }
    const f = fbmField(size, 3, 5, 16); for (let i = 0; i < h.length; i++) h[i] = Math.max(h[i] * .8, f[i] * .6);
    return { map: texture(c), normalMap: normalFromHeight(h, size, 4) };
  });
}

export function concreteMaps() {
  return memo('concrete', () => {
    const size = 512, rng = random(71), f = fbmField(size, 6, 3, 4), c = canvas(size), x = c.getContext('2d'), img = x.createImageData(size, size);
    for (let i = 0; i < size * size; i++) { const v = 168 + (f[i] - .5) * 60 + (rng() - .5) * 14; img.data[i * 4] = v; img.data[i * 4 + 1] = v * .99; img.data[i * 4 + 2] = v * .95; img.data[i * 4 + 3] = 255; }
    x.putImageData(img, 0, 0);
    // Streaks of weathering run down from the top.
    for (let i = 0; i < 40; i++) { const g = x.createLinearGradient(0, 0, 0, size); g.addColorStop(0, 'rgba(60,58,50,.18)'); g.addColorStop(1, 'rgba(60,58,50,0)'); x.fillStyle = g; x.fillRect(rng() * size, 0, 2 + rng() * 6, size * (.2 + rng() * .6)); }
    const h = fbmField(size, 5, 9, 8);
    return { map: texture(c), normalMap: normalFromHeight(h, size, 1.6) };
  });
}

// Corrugated container side: white base tinted per instance.
export function containerMaps() {
  return memo('container', () => {
    const w = 256, h = 128, c = canvas(w, h), x = c.getContext('2d'), rng = random(5);
    x.fillStyle = '#eeeeee'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 8) { const g = x.createLinearGradient(i, 0, i + 8, 0); g.addColorStop(0, '#bdbdbd'); g.addColorStop(.5, '#ffffff'); g.addColorStop(1, '#a8a8a8'); x.fillStyle = g; x.fillRect(i, 4, 8, h - 8); }
    x.fillStyle = '#777'; x.fillRect(0, 0, w, 4); x.fillRect(0, h - 4, w, 4); x.fillRect(0, 0, 4, h); x.fillRect(w - 4, 0, 4, h);
    for (let i = 0; i < 60; i++) { x.fillStyle = `rgba(110,70,40,${rng() * .25})`; x.fillRect(rng() * w, rng() * h, 1 + rng() * 5, 1 + rng() * 12); }
    const nc = canvas(w, 4), nx = nc.getContext('2d'), img = nx.createImageData(w, 4);
    for (let i = 0; i < w; i++) { const a = Math.sin(i / 8 * Math.PI * 2); for (let j = 0; j < 4; j++) { const k = (j * w + i) * 4; img.data[k] = 128 + a * 110; img.data[k + 1] = 128; img.data[k + 2] = 255; img.data[k + 3] = 255; } }
    nx.putImageData(img, 0, 0);
    return { map: texture(c), normalMap: texture(nc, { srgb: false }) };
  });
}

export function waterNormal() {
  return memo('water', () => {
    const size = 512, h = fbmField(size, 6, 21, 4); for (let i = 0; i < h.length; i++) h[i] = Math.pow(h[i], 1.5);
    return normalFromHeight(h, size, 9);
  });
}

// Chain-link fence alpha with a tensioned wire at top and bottom.
export function fenceTexture() {
  return memo('fence', () => {
    const c = canvas(64), x = c.getContext('2d');
    x.strokeStyle = 'rgba(190,196,196,1)'; x.lineWidth = 2.2; x.beginPath(); x.moveTo(0, 0); x.lineTo(64, 64); x.moveTo(64, 0); x.lineTo(0, 64); x.stroke();
    const t = texture(c, { srgb: true }); return t;
  });
}

// Office/residential facade with lit windows in the emissive channel.
export function facadeMaps(seed = 1, style = 0) {
  return memo('facade' + seed + ':' + style, () => {
    const w = 256, h = 512, rng = random(seed), c = canvas(w, h), e = canvas(w, h), x = c.getContext('2d'), y = e.getContext('2d');
    const bases = [['#cfd2cf', '#35464f'], ['#b9a891', '#2d3438'], ['#e4dfd3', '#415a63'], ['#7e8a8e', '#1e2a31']][style % 4];
    x.fillStyle = bases[0]; x.fillRect(0, 0, w, h); y.fillStyle = '#000'; y.fillRect(0, 0, w, h);
    const cols = 8, rows = 16, cw = w / cols, rh = h / rows;
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const lit = rng() < .28;
      x.fillStyle = bases[1]; x.fillRect(q * cw + 4, r * rh + 6, cw - 8, rh - 12);
      x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(q * cw + 4, r * rh + 6, cw - 8, 3);
      if (lit) { const warm = rng() < .7; y.fillStyle = warm ? `rgb(255,${190 + rng() * 40},${120 + rng() * 40})` : 'rgb(190,220,255)'; y.globalAlpha = .4 + rng() * .6; y.fillRect(q * cw + 4, r * rh + 6, cw - 8, rh - 12); y.globalAlpha = 1; }
    }
    return { map: texture(c), emissiveMap: texture(e) };
  });
}

export function signTexture(text, sub = '', { bg = '#11181b', fg = '#f2f0e8', accent = '#ec502e', w = 1024, h = 256, italic = true } = {}) {
  return memo(['sign', text, sub, bg, fg, accent, w, h].join('|'), () => {
    const c = canvas(w, h), x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,.08)'); g.addColorStop(1, 'rgba(0,0,0,.18)'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = accent; x.fillRect(0, 0, w * .018, h); x.fillRect(w - w * .018, 0, w * .018, h);
    x.fillStyle = fg; x.font = `${italic ? 'italic ' : ''}900 ${h * .46}px "Arial Black", Arial`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, w / 2, sub ? h * .42 : h * .53);
    if (sub) { x.font = `600 ${h * .12}px Arial`; x.fillStyle = accent; x.fillText(sub.split('').join(' '), w / 2, h * .78); }
    return texture(c, { repeat: false });
  });
}

// Fictional brands only; the circuit names reuse the project's own identities.
export const SPONSORS = [
  ['HARBOR RING', 'GRAND PRIX', '#0e1a24', '#f4f1e8', '#e8483a'],
  ['PHANTOM', 'RACING INTELLIGENCE', '#070808', '#f5f5f5', '#8a5cff'],
  ['VORTEX', 'LUBRICANTS', '#f2c230', '#141414', '#141414'],
  ['NOVA', 'TELEMETRY', '#1b2a6b', '#ffffff', '#5ad1ff'],
  ['ASTRA', 'MOTORSPORT', '#c43b25', '#fff6ea', '#171717'],
  ['PORTO AZUL', 'SHIPPING CO.', '#e9edf0', '#12375c', '#1f7bc4'],
  ['KESTREL', 'TYRES', '#161616', '#f5d000', '#f5d000'],
  ['MERIDIAN', 'TIMEPIECES', '#0f2a24', '#e6d7a8', '#e6d7a8'],
  ['SALT & IRON', 'BREWING', '#5b1f1a', '#f1e3c8', '#e2a54b'],
  ['GEMINI', 'SUPREME', '#101727', '#9fd0ff', '#ff6b3d']
];
export function sponsorTexture(i, w = 1024, h = 256) {
  const s = SPONSORS[((i % SPONSORS.length) + SPONSORS.length) % SPONSORS.length];
  return signTexture(s[0], s[1], { bg: s[2], fg: s[3], accent: s[4], w, h });
}

// A circular soft sprite used for glows, smoke and contact shadows.
export function radialTexture(stops = [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']], size = 128) {
  return memo('radial' + JSON.stringify(stops) + size, () => {
    const c = canvas(size), x = c.getContext('2d'), g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) g.addColorStop(o, col);
    x.fillStyle = g; x.fillRect(0, 0, size, size); return texture(c, { repeat: false });
  });
}

// Wispy smoke puff with noise, alpha only.
export function smokeTexture() {
  return memo('smoke', () => {
    const size = 128, f = fbmField(size, 4, 17, 4), c = canvas(size), x = c.getContext('2d'), img = x.createImageData(size, size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const dx = i / size - .5, dy = j / size - .5, r = Math.hypot(dx, dy) * 2, k = (j * size + i) * 4;
      const a = Math.max(0, 1 - r) ** 1.6 * (.45 + f[j * size + i] * .9);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.min(255, a * 255);
    }
    x.putImageData(img, 0, 0); return texture(c, { repeat: false });
  });
}

// Race number roundel for the car doors and bonnet.
export function numberTexture(number, accent = '#e8483a') {
  return memo('num' + number + accent, () => {
    const c = canvas(256), x = c.getContext('2d');
    x.clearRect(0, 0, 256, 256);
    x.fillStyle = '#f4f2ea'; x.beginPath(); x.arc(128, 128, 118, 0, Math.PI * 2); x.fill();
    x.lineWidth = 10; x.strokeStyle = accent; x.stroke();
    x.fillStyle = '#121416'; x.font = 'italic 900 138px "Arial Black", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(number), 128, 136);
    return texture(c, { repeat: false });
  });
}
