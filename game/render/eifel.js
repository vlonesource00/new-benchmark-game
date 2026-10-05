import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { random, clamp, wrap } from '../engine/sim/math.js';
import { signTexture, fenceTexture } from './textures.js';
import { NURBURGRING_ORIGIN } from '../engine/sim/nurburgring.js';

// The Eifel around the Nürburgring. The road stays flat (physics is flat); the
// landscape is shaped around it: banks that climb away from the tarmac (high in
// the valleys, low on the plateaus), forested hills under a canopy surface with
// real spruce and beech along the verges, double armco on the Nordschleife,
// spectator camps on the banks, the castle above Nürburg and villages in the
// valleys. Everything far is static and chunked so whole kilometres cull.

const E = 4400;                 // half extent of the landscape around the layout centre
const DF_CELL = 10, H_CELL = 25, C_CELL = 20;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash = (i, j, seed) => {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const vnoise = (x, z, seed) => {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j, seed), b = hash(i + 1, j, seed), c = hash(i, j + 1, seed), d = hash(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x, z, seed, oct = 4) => { let v = 0, a = .5, f = 1, n = 0; for (let k = 0; k < oct; k++) { v += a * vnoise(x * f, z * f, seed + k * 17); n += a; a *= .5; f *= 2.03; } return v / n; };

// Track sections by corner name: [first corner, bank height factor, forest density].
const SECTIONS = [
  ['Sabine-Schmitz-Kurve', .8, .85], ['Hocheichen', .55, .6], ['Flugplatz', .3, .25], ['Schwedenkreuz', .65, .75], ['Fuchsröhre', 1.4, .95],
  ['Kallenhard', 1.2, .9], ['Breidscheid', 1.5, .55], ['Lauda-Links', 1.5, .95], ['Mutkurve', 1.1, .9], ['Steilstrecke', .9, .8],
  ['Hedwigshöhe', 1, .9], ['Brünnchen', .7, .55], ['Sprunghügel', .9, .85], ['Galgenkopf', .3, .3], ['Antoniusbuche', .45, .6]
];
// Spectator banks: [corner, metres after it, half length].
const ZONES = [['Hatzenbach', 140, 110], ['Flugplatz', -40, 100], ['Schwedenkreuz', 30, 90], ['Adenauer Forst', 60, 90], ['Breidscheid', 90, 120],
  ['Karussell', 40, 120], ['Wippermann', 20, 80], ['Brünnchen', 80, 140], ['Pflanzgarten', 10, 110], ['Galgenkopf', 120, 90]];
const GRAFFITI = ['GRÜNE HÖLLE', 'NORDSCHLEIFE', '24H', 'GO GO GO', 'RING ♥', 'HOPP HOPP', 'NO LIFT', 'FULL ATTACK'];

// Nearest point of the lap for every 10 m cell, by two-pass propagation of the nearest sample.
function distanceField(t, cx, cz) {
  const n = Math.round(2 * E / DF_CELL) + 1, X0 = cx - E, Z0 = cz - E;
  const N = Math.ceil(t.length / 4), step = t.length / N, sx = new Float32Array(N), sz = new Float32Array(N), tx = new Float32Array(N), tz = new Float32Array(N);
  for (let i = 0; i < N; i++) { const p = t.at(i * step); sx[i] = p.x; sz[i] = p.z; tx[i] = p.tx; tz[i] = p.tz; }
  const seed = new Int32Array(n * n).fill(-1);
  for (let i = 0; i < N; i++) { const ci = Math.round((sx[i] - X0) / DF_CELL), cj = Math.round((sz[i] - Z0) / DF_CELL); if (ci >= 0 && cj >= 0 && ci < n && cj < n) seed[cj * n + ci] = i; }
  const d2 = (c, i) => { const x = X0 + (c % n) * DF_CELL - sx[i], z = Z0 + ((c / n) | 0) * DF_CELL - sz[i]; return x * x + z * z; };
  const relax = (c, o) => { const i = seed[o]; if (i >= 0 && (seed[c] < 0 || d2(c, i) < d2(c, seed[c]))) seed[c] = i; };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const c = j * n + i; if (i > 0) relax(c, c - 1); if (j > 0) { relax(c, c - n); if (i > 0) relax(c, c - n - 1); if (i < n - 1) relax(c, c - n + 1); } }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { const c = j * n + i; if (i < n - 1) relax(c, c + 1); if (j < n - 1) { relax(c, c + n); if (i < n - 1) relax(c, c + n + 1); if (i > 0) relax(c, c + n - 1); } }
  const out = { d: 0, s: 0, side: 1, i: 0 };
  return {
    N, step,
    sample(x, z) {
      const ci = clamp(Math.round((x - X0) / DF_CELL), 0, n - 1), cj = clamp(Math.round((z - Z0) / DF_CELL), 0, n - 1), i = seed[cj * n + ci];
      const dx = x - sx[i], dz = z - sz[i], along = dx * tx[i] + dz * tz[i], lat = dx * tz[i] - dz * tx[i];
      out.i = i; out.s = wrap(i * step + along, t.length); out.side = lat < 0 ? -1 : 1;
      out.d = Math.abs(along) < 6 ? Math.abs(lat) : Math.hypot(dx, dz);
      return out;
    }
  };
}

// Chamfer distance (metres) from every grid vertex to the nearest marked vertex.
function chamfer(mark, n, cell) {
  const d = new Float32Array(n * n); for (let k = 0; k < d.length; k++) d[k] = mark[k] ? 0 : 1e9;
  const a = cell, b = cell * Math.SQRT2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const c = j * n + i; let v = d[c]; if (i > 0) v = Math.min(v, d[c - 1] + a); if (j > 0) { v = Math.min(v, d[c - n] + a); if (i > 0) v = Math.min(v, d[c - n - 1] + b); if (i < n - 1) v = Math.min(v, d[c - n + 1] + b); } d[c] = v; }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { const c = j * n + i; let v = d[c]; if (i < n - 1) v = Math.min(v, d[c + 1] + a); if (j < n - 1) { v = Math.min(v, d[c + n] + a); if (i < n - 1) v = Math.min(v, d[c + n + 1] + b); if (i > 0) v = Math.min(v, d[c + n - 1] + b); } d[c] = v; }
  return d;
}

// Instances grouped into 500 m cells per kind; cells beyond a kind's range are hidden.
class Chunks {
  constructor() { this.items = new Map(); this.meshes = []; }
  put(kind, x, y, z, ry, sx, sy = sx, sz = sx, color = null) {
    const key = `${kind}|${Math.floor(x / 500)},${Math.floor(z / 500)}`;
    let list = this.items.get(key); if (!list) this.items.set(key, list = { kind, data: [] });
    list.data.push(x, y, z, ry, sx, sy, sz, color ? color.r : 1, color ? color.g : 1, color ? color.b : 1);
  }
  build(root, kinds) {
    const d = new THREE.Object3D(), c = new THREE.Color();
    for (const { kind, data } of this.items.values()) {
      const k = kinds[kind], count = data.length / 10, mesh = new THREE.InstancedMesh(k.geo, k.mat, count);
      let cx = 0, cz = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 10; d.position.set(data[o], data[o + 1], data[o + 2]); d.rotation.set(0, data[o + 3], 0); d.scale.set(data[o + 4], data[o + 5], data[o + 6]); d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix); mesh.setColorAt(i, c.setRGB(data[o + 7], data[o + 8], data[o + 9])); cx += data[o]; cz += data[o + 2];
      }
      mesh.castShadow = k.cast ?? true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); root.add(mesh);
      this.meshes.push({ mesh, x: cx / count, z: cz / count, r2: (k.range ?? 1500) ** 2 });
    }
    this.items.clear();
  }
  update(x, z) { for (const m of this.meshes) m.mesh.visible = (m.x - x) ** 2 + (m.z - z) ** 2 < m.r2; }
}

export function buildEifel(world, kit) {
  const t = world.track, L = t.length, rng = random(24624), B = world.bounds, cx = B.cx, cz = B.cz, X0 = cx - E, Z0 = cz - E;
  const { std, add, box, sway, canvasTexture, sweep, decal } = kit;
  const marks = t.scenario.landmarks, at = (name) => (marks.find((m) => m.name === name)?.f ?? 0) * L;
  const inGP = world.inGP, df = distanceField(t, cx, cz), color = new THREE.Color(), chunks = new Chunks();

  // ---- per-sample section character, smoothed along the lap ----
  const N = df.N, bank = new Float32Array(N), forest = new Float32Array(N), gpw = new Float32Array(N);
  {
    const starts = SECTIONS.map(([name, b, f]) => [at(name), b, f]).sort((a, b) => a[0] - b[0]);
    const raw = (s) => { if (inGP(s)) return [0, 0, 1]; let r = starts[starts.length - 1]; for (const x of starts) if (x[0] <= s) r = x; return [r[1], r[2], 0]; };
    const rb = new Float32Array(N), rf = new Float32Array(N), rg = new Float32Array(N);
    for (let i = 0; i < N; i++) [rb[i], rf[i], rg[i]] = raw(i * df.step);
    const W = 40;
    for (let i = 0; i < N; i++) { let a = 0, b = 0, c = 0; for (let k = -W; k <= W; k++) { const j = (i + k + N) % N; a += rb[j]; b += rf[j]; c += rg[j]; } bank[i] = a / (2 * W + 1); forest[i] = b / (2 * W + 1); gpw[i] = c / (2 * W + 1); }
  }

  // ---- landmarks off the track: castle, villages, spectator zones ----
  const KX = 111320 * Math.cos(NURBURGRING_ORIGIN.lat * Math.PI / 180);
  const geo = (lat, lon) => [(lon - NURBURGRING_ORIGIN.lon) * KX, -(lat - NURBURGRING_ORIGIN.lat) * 111320];
  // Outward from the lap at a corner: the side with more room.
  const outward = (s, dist) => {
    let best = null;
    for (const side of [-1, 1]) for (const k of [1, .8, .6, 1.25]) { const p = t.at(s, side * dist * k), q = df.sample(p.x, p.z); if (!best || q.d > best.d) best = { x: p.x, z: p.z, d: q.d }; }
    return best;
  };
  const [castleX, castleZ] = geo(50.3437, 6.9520);
  const villages = [
    { name: 'Nürburg', x: castleX + 180, z: castleZ + 140, r: 170, n: 46, church: true },
    { name: 'Quiddelbach', ...outward(at('Quiddelbacher Höhe'), 520), r: 150, n: 30, church: true },
    { name: 'Herschbroich', ...outward(at('Brünnchen') + 300, 620), r: 140, n: 26, church: false },
    { name: 'Breidscheid', ...outward(at('Breidscheid') + 40, 260), r: 140, n: 30, church: true },
    { name: 'Adenau', ...outward(at('Breidscheid') + 40, 1250), r: 340, n: 110, church: true },
    { name: 'Döttingen', ...outward(at('Döttinger Höhe') + 300, 900), r: 140, n: 26, church: true }
  ];
  const zones = ZONES.map(([name, ds, half]) => {
    const s = wrap(at(name) + ds, L); let side = -Math.sign(t.at(s).curvature) || 1;
    const room = (sd) => { const p = t.at(s, sd * 70); return df.sample(p.x, p.z).d; };
    if (room(side) < 55) side = -side;
    return { name, s, half, side };
  });
  const inZone = (s, side, d) => d < 170 && zones.some((z) => z.side === side && Math.abs(wrap(s - z.s + L / 2, L) - L / 2) < z.half + 15);
  const clearing = (x, z) => {
    for (const v of villages) if ((x - v.x) ** 2 + (z - v.z) ** 2 < (v.r + 50) ** 2) return true;
    return (x - castleX) ** 2 + (z - castleZ) ** 2 < 140 ** 2;
  };

  // ---- height field: banks rising from the verge, distant ridges, the castle hill ----
  const n = Math.round(2 * E / H_CELL) + 1, H = new Float32Array(n * n), D = new Float32Array(n * n);
  const takenDist = (() => {
    const mark = new Uint8Array(n * n);
    for (const k of world.taken) { const [i, j] = k.split(',').map(Number), gi = Math.round(((i + .5) * 8 - X0) / H_CELL), gj = Math.round(((j + .5) * 8 - Z0) / H_CELL); if (gi >= 0 && gj >= 0 && gi < n && gj < n) mark[gj * n + gi] = 1; }
    return chamfer(mark, n, H_CELL);
  })();
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = X0 + i * H_CELL, z = Z0 + j * H_CELL, q = df.sample(x, z), c = j * n + i, d = q.d; D[c] = d;
    const gp = gpw[q.i], wild = 1 - gp * (1 - smooth(300, 900, d));
    let h = bank[q.i] * 46 * smooth(42, 260, d) * (.55 + .9 * fbm(x / 420, z / 420, 3));
    h += smooth(380, 2400, d) * (55 + 160 * fbm(x / 1300, z / 1300, 9, 5));
    h += smooth(60, 300, d) * (fbm(x / 110, z / 110, 21, 3) - .5) * 9;
    h += smooth(3300, 4400, Math.max(Math.abs(x - cx), Math.abs(z - cz))) * 130;
    h += Math.exp(-((x - castleX) ** 2 + (z - castleZ) ** 2) / (2 * 230 ** 2)) * 85 * smooth(80, 320, d);
    H[c] = h * wild;
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = H.slice();
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) { let a = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) a += src[(j + v) * n + i + u]; H[j * n + i] = a / 9; }
  }
  for (let c = 0; c < n * n; c++) H[c] *= smooth(40, 75, D[c]) * smooth(25, 110, takenDist[c]);
  const height = (x, z) => {
    const gx = clamp((x - X0) / H_CELL, 0, n - 1.001), gz = clamp((z - Z0) / H_CELL, 0, n - 1.001), i = Math.floor(gx), j = Math.floor(gz), u = gx - i, v = gz - j, c = j * n + i;
    return (H[c] * (1 - u) + H[c + 1] * u) * (1 - v) + (H[c + n] * (1 - u) + H[c + n + 1] * u) * v;
  };

  // ---- terrain tiles in the ground material (same UVs as the ground plane) ----
  const ground = world.groundMeshes[0], gcx = ground.position.x, gcz = ground.position.z, tiles = 8, per = (n - 1) / tiles;
  for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
    const pos = [], nrm = [], uv = [], idx = [], i0 = tx * per, j0 = ty * per, w = per + 1;
    for (let j = j0; j <= j0 + per; j++) for (let i = i0; i <= i0 + per; i++) {
      const x = X0 + i * H_CELL, z = Z0 + j * H_CELL, c = j * n + i;
      pos.push(x, H[c] - .055, z); uv.push((x - gcx + 4500) / 9000, (gcz + 4500 - z) / 9000);
      const hx = (H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)]) / (2 * H_CELL), hz = (H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i]) / (2 * H_CELL), l = Math.hypot(hx, 1, hz);
      nrm.push(-hx / l, 1 / l, -hz / l);
    }
    for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
      const a = (i0 + i) + (j0 + j) * n; if (H[a] < .02 && H[a + 1] < .02 && H[a + n] < .02 && H[a + n + 1] < .02) continue;
      const k = j * w + i; idx.push(k, k + w, k + 1, k + 1, k + w, k + w + 1);
    }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = add(world.root, g, ground.material, 0, 0, 0, false); world.groundMeshes.push(m);
  }

  // ---- forest: canopy surface behind the verge trees ----
  const forestBase = (q) => q.d > 1200 ? .6 : forest[q.i] + (.62 - forest[q.i]) * smooth(500, 1200, q.d);
  const forestAt = (x, z, q) => {
    if (clearing(x, z)) return 0;
    const f = smooth(-.07, .07, forestBase(q) - fbm(x / 380, z / 380, 41) * 1.05 + .02);
    return f * (1 - gpw[q.i] * (1 - smooth(380, 700, q.d))) * (inZone(q.s, q.side, q.d) ? smooth(150, 170, q.d) : 1);
  };
  {
    const cn = Math.round(2 * E / C_CELL) + 1, Y = new Float32Array(cn * cn), F = new Float32Array(cn * cn), col = new Float32Array(cn * cn * 3);
    const tk = (x, z) => { const gi = clamp(Math.round((x - X0) / H_CELL), 0, n - 1), gj = clamp(Math.round((z - Z0) / H_CELL), 0, n - 1); return takenDist[gj * n + gi]; };
    for (let j = 0; j < cn; j++) for (let i = 0; i < cn; i++) {
      const x = X0 + i * C_CELL, z = Z0 + j * C_CELL, q = df.sample(x, z), c = j * cn + i;
      const f = forestAt(x, z, q) * smooth(55, 90, q.d) * smooth(30, 80, tk(x, z)); F[c] = f;
      const beech = fbm(x / 520, z / 520, 77), crown = hash(i, j, 5);
      Y[c] = height(x, z) - 1.5 + f * (19 + 8 * fbm(x / 70, z / 70, 13, 3) + (crown - .5) * 4.5) + (f - 1) * 1.5;
      color.setHSL(.27 + beech * .07 + (crown - .5) * .02, .34 + beech * .12, .1 + beech * .07 + crown * .035);
      col.set([color.r, color.g, color.b], c * 3);
    }
    const crownMap = canvasTexture(512, 512, (c, w, h) => {
      const r = random(808); c.fillStyle = '#3d3d3d'; c.fillRect(0, 0, w, h);
      for (let k = 0; k < 340; k++) {
        const x = r() * w, y = r() * h, rad = 16 + r() * 26;
        for (const [dx, dy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) {
          const g = c.createRadialGradient(x + dx - rad * .3, y + dy - rad * .35, rad * .1, x + dx, y + dy, rad);
          g.addColorStop(0, '#ffffff'); g.addColorStop(.6, '#b4b4b4'); g.addColorStop(1, 'rgba(70,70,70,0)'); c.fillStyle = g; c.beginPath(); c.arc(x + dx, y + dy, rad, 0, Math.PI * 2); c.fill();
        }
      }
    });
    crownMap.wrapS = crownMap.wrapT = THREE.RepeatWrapping;
    const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: crownMap, roughness: 1, metalness: 0 });
    const ct = 8, cper = (cn - 1) / ct;
    for (let ty = 0; ty < ct; ty++) for (let tx = 0; tx < ct; tx++) {
      const pos = [], nrm = [], uv = [], cols = [], idx = [], i0 = tx * cper, j0 = ty * cper, w = cper + 1;
      for (let j = j0; j <= j0 + cper; j++) for (let i = i0; i <= i0 + cper; i++) {
        const c = j * cn + i, x = X0 + i * C_CELL, z = Z0 + j * C_CELL;
        pos.push(x, Y[c], z); uv.push(x / 17, z / 17); cols.push(col[c * 3], col[c * 3 + 1], col[c * 3 + 2]);
        const hx = (Y[j * cn + Math.min(cn - 1, i + 1)] - Y[j * cn + Math.max(0, i - 1)]) / (2 * C_CELL), hz = (Y[Math.min(cn - 1, j + 1) * cn + i] - Y[Math.max(0, j - 1) * cn + i]) / (2 * C_CELL), l = Math.hypot(hx, 1, hz);
        nrm.push(-hx / l, 1 / l, -hz / l);
      }
      for (let j = 0; j < cper; j++) for (let i = 0; i < cper; i++) {
        const a = (i0 + i) + (j0 + j) * cn; if (F[a] < .03 && F[a + 1] < .03 && F[a + cn] < .03 && F[a + cn + 1] < .03) continue;
        const k = j * w + i; idx.push(k, k + w, k + 1, k + 1, k + w, k + w + 1);
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); g.setIndex(idx);
      add(world.root, g, canopyMat, 0, 0, 0, false);
    }
  }

  // ---- verge trees (spruce and beech), undergrowth ----
  const cone = (r, h, y) => new THREE.ConeGeometry(r, h, 7, 1, true).translate(0, y, 0).toNonIndexed();
  const shade = (g, k) => { const p = g.attributes.position, c = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) { const v = k(p.getY(i)); c.set([v, v, v], i * 3); } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; };
  const needles = shade(mergeGeometries([cone(2.7, 5.2, 4.6), cone(2.25, 4.8, 7.2), cone(1.8, 4.3, 9.6), cone(1.3, 3.7, 11.8), cone(.75, 3, 13.8)]), (y) => .55 + y / 15 * .5);
  const stem = shade(new THREE.CylinderGeometry(.16, .3, 6, 6, 1, true).translate(0, 3, 0).toNonIndexed(), () => 1);
  const spruceMat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95, side: THREE.DoubleSide }), .0006, 'spruce');
  const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#4b3b2e', roughness: 1 });
  const { geo: beechGeo, mat: beechMat } = world.treeAssets();
  const bush = new THREE.IcosahedronGeometry(1, 0).translate(0, .55, 0);
  const bushMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
  for (let s = 0; s < L; s += 9) for (const side of [-1, 1]) {
    for (let lat = 26; lat < 70; lat += 7.5) {
      const ss = s + (rng() - .5) * 6, ll = lat + (rng() - .5) * 5, p = t.at(wrap(ss, L), side * ll), q = df.sample(p.x, p.z);
      if (q.d < 24 || gpw[q.i] > .5 || inZone(q.s, q.side, q.d) || clearing(p.x, p.z) || !world.isFree(p.x, p.z, 3)) continue;
      if (rng() > Math.min(1, forestBase(q) * 1.2) * smooth(.15, .45, fbm(p.x / 160, p.z / 160, 55) + forestBase(q) * .4)) continue;
      const y = height(p.x, p.z) - .4, ry = rng() * 6.28;
      if (rng() < .62) {
        const sc = 1.25 + rng() * .85, c = color.setHSL(.33 + rng() * .05, .32 + rng() * .14, .19 + rng() * .08);
        chunks.put('spruce', p.x, y, p.z, ry, sc * (.9 + rng() * .2), sc, sc * (.9 + rng() * .2), c); chunks.put('stem', p.x, y, p.z, ry, sc, sc, sc);
      } else chunks.put('beech', p.x, y, p.z, ry, 1.2 + rng() * .8, 1.2 + rng() * .9, 1.2 + rng() * .8, color.setHSL(.17 + rng() * .07, .2, .66 + rng() * .25));
    }
    const ss = s + rng() * 9, ll = 22.5 + rng() * 4, p = t.at(wrap(ss, L), side * ll), q = df.sample(p.x, p.z);
    if (q.d > 21 && gpw[q.i] < .5 && !inZone(q.s, q.side, q.d) && rng() < forestBase(q) * .9) {
      const sc = .7 + rng() * 1.4; chunks.put('bush', p.x, -.15, p.z, rng() * 6.28, sc * (1 + rng() * .5), sc * (.6 + rng() * .4), sc, color.setHSL(.22 + rng() * .08, .38, .14 + rng() * .1));
      if (rng() < .5) { const p2 = t.at(wrap(ss + 2, L), side * (ll + 1.5)); chunks.put('bush', p2.x, -.15, p2.z, rng() * 6.28, sc * .8, sc * .7, sc * .9, color.setHSL(.24 + rng() * .06, .32, .16 + rng() * .08)); }
    }
  }

  // ---- Nordschleife double armco on posts (the GP keeps its concrete walls) ----
  const steel = std('#b5babb', .38, .85, { side: THREE.DoubleSide });
  const rail = (y) => [[0, y], [.07, y + .08], [.02, y + .16], [.07, y + .24], [0, y + .32]];
  for (const side of [-1, 1]) for (let from = 0; from < L; from += 1000) {
    const length = Math.min(1000, L - from), skip = (s) => inGP(s) || world.pitGap(s, side);
    for (const y of [.48, .9]) add(world.root, sweep(t, rail(y), t.barrierOffset + .15, side, Math.ceil(length / 3), 3, { from, length, skip }), steel);
  }
  const postGeo = new THREE.BoxGeometry(.1, 1.25, .16).translate(0, .62, 0), postMat = std('#8e9596', .5, .7);
  for (const side of [-1, 1]) for (let s = 0; s < L; s += 4) {
    if (inGP(s)) continue; const p = t.at(s, side * (t.barrierOffset + .32)); chunks.put('post', p.x, 0, p.z, p.heading, 1);
  }

  // ---- spectator banks: catch fence, crowds, tents, campers, flags, scaffolds, fires ----
  const fmap = fenceTexture().clone(); fmap.needsUpdate = true;
  const fenceMat = new THREE.MeshStandardMaterial({ map: fmap, alphaTest: .35, side: THREE.DoubleSide, roughness: .5, metalness: .6, color: '#b9bfbf' });
  const fans = ['#f08a2c', '#141414', '#e8483a', '#f2c230', '#2f6db0', '#e9e6dc', '#3f8f4a', '#7a1f1f', '#2a2e33'];
  const fireMat = new THREE.MeshStandardMaterial({ color: '#2a1a10', emissive: '#ff7a2a', emissiveIntensity: .2, roughness: 1 });
  world.glows.push({ material: fireMat, day: .2, night: 6 });
  const flagTex = [['#141414', '#d62828', '#f2c230', 'h'], ['#ae1c28', '#ffffff', '#21468b', 'h'], ['#141414', '#f2d21c', '#e32b2b', 'v'], ['#1f8a3a', '#ffffff', '#1f8a3a', 'g'], ['#f2f0e8', '#141414', '', 'c'], ['#f08a2c', '#141414', '#f08a2c', 'h']].map(([a, b, c, kind]) => canvasTexture(256, 160, (x, w, h) => {
    if (kind === 'c') { for (let i = 0; i < 8; i++) for (let j = 0; j < 5; j++) { x.fillStyle = (i + j) % 2 ? a : b; x.fillRect(i * 32, j * 32, 32, 32); } return; }
    for (let k = 0; k < 3; k++) { x.fillStyle = [a, b, c][k]; if (kind === 'v') x.fillRect(k * w / 3, 0, w / 3 + 1, h); else x.fillRect(0, k * h / 3, w, h / 3 + 1); }
    if (kind === 'g') { x.fillStyle = '#ffffff'; x.font = 'italic 900 34px Arial'; x.textAlign = 'center'; x.fillText('GRÜNE HÖLLE', w / 2, h / 2 + 12); }
  }));
  const flagGeo = new THREE.PlaneGeometry(1.6, 1, 10, 1).translate(.8, 0, 0);
  const flagMeshes = flagTex.map((map, i) => { const m = new THREE.InstancedMesh(flagGeo, sway(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: .8 }), .09, 'flag', 'flag'), 60); m.count = 0; return m; });
  const poleGeo = new THREE.CylinderGeometry(.04, .05, 1, 5).translate(0, .5, 0);
  const d = world.dummy, banners = [];
  const bannerTex = ['GRÜNE HÖLLE', 'RING FREUNDE', 'EIFEL 24H', 'ALLEZ!', 'NORDSCHLEIFE FAN CLUB', 'GAS GEBEN'].map((txt, i) => signTexture(txt, '', { bg: ['#1f6b34', '#141414', '#f2c230', '#e8483a', '#f2f0e8', '#2f6db0'][i], fg: ['#ffffff', '#f08a2c', '#141414', '#ffffff', '#1f6b34', '#ffffff'][i], accent: '#141414', w: 1024, h: 160 }));
  for (const zn of zones) {
    const { s: s0, half, side } = zn, from = wrap(s0 - half, L);
    add(world.root, sweep(t, [[0, .95], [0, 4.2]], t.barrierOffset + 1.35, side, Math.ceil(half / 2), 1 / 1.6, { from, length: half * 2 }), fenceMat, 0, 0, 0, false);
    for (let u = 0; u <= half * 2; u += 5) { const p = t.at(wrap(from + u, L), side * (t.barrierOffset + 1.4)); chunks.put('fencePost', p.x, 0, p.z, 0, 1); }
    for (let k = 0; k < 4; k++) {
      const p = t.at(wrap(from + 20 + k * (half * 2 - 40) / 3, L), side * (t.barrierOffset + 1.3)), g = new THREE.Group(); g.position.set(p.x, 1.5, p.z); g.rotation.y = p.heading - side * Math.PI / 2; world.root.add(g);
      add(g, new THREE.PlaneGeometry(7, 1.1), new THREE.MeshStandardMaterial({ map: bannerTex[(k + zones.indexOf(zn)) % bannerTex.length], roughness: .7, side: THREE.DoubleSide }), 0, 0, -.04, false);
    }
    // Fans along the bank behind the fence, thinning out up the slope.
    for (let k = 0; k < 520; k++) {
      const u = (rng() * 2 - 1) * half, lat = t.barrierOffset + 3 + Math.pow(rng(), 1.7) * 34, p = t.at(wrap(s0 + u, L), side * lat), q = df.sample(p.x, p.z); if (q.d < t.barrierOffset + 2.5) continue;
      chunks.put('fan', p.x, height(p.x, p.z) - .05, p.z, p.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + (rng() - .5) * .9, .9 + rng() * .2, .9 + rng() * .2, .9 + rng() * .2, color.set(fans[Math.floor(rng() * fans.length)]).multiplyScalar(.6 + rng() * .5));
    }
    for (let k = 0; k < 70; k++) {
      const u = (rng() * 2 - 1) * (half + 30), lat = t.barrierOffset + 28 + rng() * 75, p = t.at(wrap(s0 + u, L), side * lat), q = df.sample(p.x, p.z); if (q.d < t.barrierOffset + 24) continue;
      const y = height(p.x, p.z), r = rng(), rot = p.heading + (rng() - .5) * .6;
      if (r < .55) chunks.put('tent', p.x, y - .1, p.z, rng() * 6.28, .8 + rng() * .5, .8 + rng() * .4, .8 + rng() * .5, color.set(['#e8483a', '#f2c230', '#2f6db0', '#3f8f4a', '#f08a2c', '#e9e6dc'][Math.floor(rng() * 6)]));
      else if (r < .75) chunks.put('camper', p.x, y - .3, p.z, rot, 1, 1, 1, color.set(rng() < .7 ? '#ecebe6' : '#d9c7a0'));
      else if (r < .9) chunks.put('gazebo', p.x, y - .1, p.z, rot, 1 + rng() * .4, 1, 1 + rng() * .4, color.set(['#f2f0e8', '#1f6b34', '#e8483a', '#141414'][Math.floor(rng() * 4)]));
      else chunks.put('fire', p.x, y, p.z, 0, 1);
    }
    for (let k = 0; k < 7; k++) {
      const u = (rng() * 2 - 1) * half, p = t.at(wrap(s0 + u, L), side * (t.barrierOffset + 14 + rng() * 40)), y = height(p.x, p.z), hgt = 6 + rng() * 4;
      chunks.put('pole', p.x, y, p.z, 0, 1, hgt, 1);
      const m = flagMeshes[Math.floor(rng() * flagMeshes.length)]; if (m.count >= 60) continue;
      d.position.set(p.x, y + hgt - .6, p.z); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(1); d.updateMatrix(); m.setMatrixAt(m.count++, d.matrix);
    }
    // DIY scaffold towers with a few fans on top.
    for (let k = 0; k < 2; k++) {
      const u = (k ? 1 : -1) * half * (.3 + rng() * .4), p = t.at(wrap(s0 + u, L), side * (t.barrierOffset + 9 + rng() * 6)), y = height(p.x, p.z), hgt = 4 + rng() * 2.5;
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) chunks.put('pole', p.x + ox * 1.1, y, p.z + oz * 1.1, 0, 1.6, hgt + 1, 1.6);
      chunks.put('deck', p.x, y + hgt, p.z, p.heading, 2.6, 1, 2.6, color.set('#7a6a52'));
      for (let f = 0; f < 4; f++) chunks.put('fan', p.x + (rng() - .5) * 2, y + hgt + .1, p.z + (rng() - .5) * 2, p.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 1, 1, color.set(fans[Math.floor(rng() * fans.length)]));
    }
  }
  for (const m of flagMeshes) { m.castShadow = true; world.root.add(m); }

  // ---- signage: km boards, corner names, painted road ----
  const s0 = at('Sabine-Schmitz-Kurve');
  for (let km = 1; km <= 20; km++) {
    const s = wrap(s0 + km * 1000, L); if (inGP(s)) continue;
    const p = t.at(s, t.barrierOffset + 1.2), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading + Math.PI; world.root.add(g);
    add(g, new THREE.PlaneGeometry(.7, .9), new THREE.MeshStandardMaterial({ map: signTexture(String(km), 'KM', { bg: '#f4f3ee', fg: '#16191a', accent: '#1f6b34', w: 192, h: 256, italic: false }), roughness: .6 }), 0, 1.45, 0);
    box(g, std('#3b4041', .5, .6), 0, .5, .03, .06, 1, .05);
  }
  for (const m of marks) {
    const s = wrap(m.f * L - 70, L), side = -Math.sign(t.at(m.f * L).curvature) || 1;
    const p = t.at(s, side * (t.barrierOffset + 2.2)), q = df.sample(p.x, p.z); if (q.d < t.barrierOffset + 1.5) continue;
    const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading + Math.PI; world.root.add(g);
    add(g, new THREE.PlaneGeometry(4.2, .8), new THREE.MeshStandardMaterial({ map: signTexture(m.name.toUpperCase(), '', { bg: '#17442a', fg: '#f2f0e8', accent: '#f2c230', w: 1024, h: 196, italic: false }), roughness: .6 }), 0, 2.3, 0);
    for (const x of [-1.8, 1.8]) box(g, std('#3b4041', .5, .6), x, .95, .04, .08, 1.9, .06);
  }
  {
    const atlas = canvasTexture(1024, 1024, (c, w, h) => {
      c.clearRect(0, 0, w, h); c.textAlign = 'center'; c.textBaseline = 'middle';
      GRAFFITI.forEach((txt, k) => {
        const x = (k % 2) * 512 + 256, y = Math.floor(k / 2) * 256 + 128, r = random(k + 3);
        c.save(); c.translate(x, y); c.rotate((r() - .5) * .12);
        c.font = `italic 900 ${txt.length > 9 ? 70 : 110}px "Arial Black", Arial`; c.fillStyle = ['rgba(245,245,236,.92)', 'rgba(250,214,60,.9)', 'rgba(245,245,236,.92)', 'rgba(240,120,60,.88)'][k % 4];
        c.fillText(txt, 0, 0);
        for (let i = 0; i < 26; i++) { c.globalAlpha = r() * .5; c.fillRect((r() - .5) * 420, (r() - .5) * 120, 2 + r() * 5, 2 + r() * 14); }
        c.globalAlpha = 1; c.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 1400; i++) { c.globalAlpha = r() * .7; c.fillRect((r() - .5) * 500, (r() - .5) * 240, 1 + r() * 4, 1 + r() * 3); }
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.restore();
      });
    });
    const pos = [], uv = [], idx = [];
    for (let k = 0; k < 160; k++) {
      const s = rng() * L; if (inGP(s) || inGP(s + 10)) continue;
      const slot = Math.floor(rng() * GRAFFITI.length), u0 = (slot % 2) * .5, v1 = 1 - Math.floor(slot / 2) * .25, v0 = v1 - .25;
      const w = 6.4, l = 3.2, lat = (rng() - .5) * (t.width - w - 1), base = pos.length / 3;
      for (const [ds, dl, u, v] of [[-l / 2, -w / 2, u0, v0], [-l / 2, w / 2, u0 + .5, v0], [l / 2, w / 2, u0 + .5, v1], [l / 2, -w / 2, u0, v1]]) { const p = t.at(wrap(s + ds, L), lat + dl); pos.push(p.x, .03, p.z); uv.push(u, v); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const paint = add(world.root, g, new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, roughness: .55, side: THREE.DoubleSide, ...decal(3) }), 0, 0, 0, false);
    paint.renderOrder = 1;
  }

  // ---- road bridges over the track (Breidscheid, Antoniusbuche) ----
  const concrete = std('#b8b4aa', .92), deckTop = std('#3c3e40', .95), railMat = std('#c9ced0', .4, .7);
  for (const s of [wrap(at('Breidscheid') + 70, L), wrap(at('Antoniusbuche') + 10, L)]) {
    const p = t.at(s), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading; world.root.add(g);
    const span = (t.barrierOffset + 4) * 2, len = span + 150;
    box(g, concrete, 0, 7.4, 0, len, 1.1, 11); box(g, deckTop, 0, 8, 0, len, .12, 10, false);
    for (const z of [-5.3, 5.3]) { box(g, railMat, 0, 8.9, z, len, .1, .1, false); box(g, concrete, 0, 8.25, z, len, .5, .35); }
    for (const x of [-span / 2 - 1, span / 2 + 1]) box(g, concrete, x, 3.7, 0, 3, 7.4, 13);
    for (let x = -len / 2 + 4; x < len / 2; x += 8) if (Math.abs(x) > span / 2 + 4) box(g, concrete, x, 3.4, 0, 1.6, 6.8, 6);
  }

  // ---- Nürburg castle on its hill ----
  {
    const stone = std('#8a8378', .95), dark = std('#5e584f', .95), roof = std('#3b3d42', .8), base = height(castleX, castleZ);
    const g = new THREE.Group(); g.position.set(castleX, base - 2, castleZ); world.root.add(g);
    add(g, new THREE.CylinderGeometry(7.5, 8.5, 34, 20), stone, 0, 17, 0);
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; box(g, stone, Math.cos(a) * 7.4, 35, Math.sin(a) * 7.4, 2.2, 2, 1.2).rotation.y = -a; }
    const ring = 12, R = 42;
    for (let k = 0; k < ring; k++) {
      const a = k / ring * Math.PI * 2, b = (k + 1) / ring * Math.PI * 2, rr = R * (.85 + .3 * hash(k, 1, 9)), rb = R * (.85 + .3 * hash((k + 1) % ring, 1, 9));
      const ax = Math.cos(a) * rr, az = Math.sin(a) * rr, bx = Math.cos(b) * rb, bz = Math.sin(b) * rb, len = Math.hypot(bx - ax, bz - az);
      const wall = box(g, k % 5 === 3 ? dark : stone, (ax + bx) / 2, 4.5 + hash(k, 2, 9) * 2, (az + bz) / 2, len + 1, 9 + hash(k, 3, 9) * 4, 2.6); wall.rotation.y = -Math.atan2(bz - az, bx - ax);
      if (k % 3 === 0) add(g, new THREE.CylinderGeometry(3.6, 4, 13, 12), stone, ax, 6.5, az);
    }
    for (const [x, z, w, dd, h] of [[-18, 10, 14, 9, 8], [16, -14, 11, 16, 7], [8, 22, 18, 8, 6]]) { box(g, dark, x, h / 2, z, w, h, dd); const r = add(g, new THREE.ConeGeometry(Math.hypot(w, dd) * .55, 6, 4), roof, x, h + 3, z); r.rotation.y = Math.PI / 4; r.scale.set(w / Math.hypot(w, dd) * 1.4, 1, dd / Math.hypot(w, dd) * 1.4); }
    d.position.set(castleX + 2, base + 35.5, castleZ); d.rotation.set(0, .6, 0); d.scale.setScalar(2.2); d.updateMatrix(); flagMeshes[0].setMatrixAt(flagMeshes[0].count++, d.matrix);
    chunks.put('pole', castleX + 2, base + 32, castleZ, 0, 1.4, 5, 1.4);
  }

  // ---- villages: white-rendered gable houses, slate roofs, churches ----
  const wallGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0);
  const tri = new THREE.Shape(); tri.moveTo(-.56, 0); tri.lineTo(.56, 0); tri.lineTo(0, 1); tri.lineTo(-.56, 0);
  const roofGeo = new THREE.ExtrudeGeometry(tri, { depth: 1.06, bevelEnabled: false }).translate(0, 0, -.53);
  const spire = new THREE.ConeGeometry(.72, 1, 4).rotateY(Math.PI / 4).translate(0, .5, 0);
  for (const v of villages) {
    const street = rng() * Math.PI;
    for (let k = 0, tries = 0; k < v.n && tries < v.n * 8; tries++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * v.r, x = v.x + Math.cos(a) * r, z = v.z + Math.sin(a) * r;
      if (Math.abs(x - cx) > E - 60 || Math.abs(z - cz) > E - 60 || df.sample(x, z).d < 70 || !world.isFree(x, z, 9)) continue;
      world.occupy(x, z, 7); k++;
      const w = 7 + rng() * 5, dd = 9 + rng() * 6, h = 5 + rng() * 2.5, y = height(x, z), rot = street + (rng() < .5 ? 0 : Math.PI / 2) + (rng() - .5) * .25;
      chunks.put('wall', x, y - 3, z, rot, w, h + 3, dd, color.set(['#ece7da', '#e4dccb', '#f1eee6', '#d9cdb8', '#c9b89a'][Math.floor(rng() * 5)]));
      chunks.put('roof', x, y + h, z, rot, w, 3.5 + rng() * 2, dd, color.set(rng() < .8 ? '#3a3d42' : '#8a4a34').multiplyScalar(.85 + rng() * .3));
    }
    if (v.church) {
      const y = height(v.x, v.z), rot = street;
      chunks.put('wall', v.x, y - 3, v.z, rot, 5.5, 25, 5.5, color.set('#ebe6da')); chunks.put('spire', v.x, y + 22, v.z, rot, 5.5, 13, 5.5, color.set('#34373c'));
      chunks.put('wall', v.x + Math.cos(rot) * 12, y - 3, v.z - Math.sin(rot) * 12, rot, 10, 12, 20, color.set('#ebe6da'));
      chunks.put('roof', v.x + Math.cos(rot) * 12, y + 9, v.z - Math.sin(rot) * 12, rot, 10, 6, 20, color.set('#34373c'));
    }
  }

  // ---- wind turbines on the distant ridges ----
  const turbineSpots = [];
  for (let k = 0; k < 600 && turbineSpots.length < 7; k++) {
    const x = cx + (rng() * 2 - 1) * (E - 500), z = cz + (rng() * 2 - 1) * (E - 500); if (df.sample(x, z).d < 1300 || height(x, z) < 110) continue;
    if (turbineSpots.some(([a, b]) => Math.hypot(a - x, b - z) < 380)) continue; turbineSpots.push([x, z]);
  }
  const white = std('#eef0ee', .45, .2), blade = new THREE.BoxGeometry(2.4, 44, .5).translate(0, 23, 0); blade.attributes.position.array.forEach((v, i, a) => { if (i % 3 === 0) a[i] = v * (1 - (a[i + 1] / 50) * .7); });
  for (const [x, z] of turbineSpots) {
    const y = height(x, z) - 1, yaw = .6 + rng() * .3;
    add(world.root, new THREE.CylinderGeometry(1.4, 2.4, 96, 14).translate(0, 48, 0), white, x, y, z, false);
    const head = new THREE.Group(); head.position.set(x, y + 97, z); head.rotation.y = yaw; world.live.add(head);
    box(head, white, 0, 0, -1.5, 3, 3.4, 9.5, false); add(head, new THREE.SphereGeometry(1.7, 12, 8), white, 0, 0, 3.8, false);
    const rotor = new THREE.Group(); rotor.position.z = 3.9; head.add(rotor);
    for (let b = 0; b < 3; b++) { const m = add(rotor, blade, white, 0, 0, 0, false); m.rotation.z = b * Math.PI * 2 / 3; }
    const speed = .9 + rng() * .3, ph = rng() * 6;
    world.animators.push((now) => { rotor.rotation.z = now * speed + ph; });
  }

  // ---- instanced kinds ----
  const person = mergeGeometries([new THREE.CapsuleGeometry(.2, .9, 2, 5).translate(0, .65, 0), new THREE.SphereGeometry(.13, 5, 4).translate(0, 1.35, 0)]);
  const dome = new THREE.SphereGeometry(1.4, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.2, .9, 1);
  const van = mergeGeometries([new THREE.BoxGeometry(6.4, 2.3, 2.3).translate(0, 1.55, 0), new THREE.BoxGeometry(5, .5, 2.34).translate(0, .3, 0)]);
  const gazebo = mergeGeometries([new THREE.BoxGeometry(3, .1, 3).translate(0, 2.4, 0), new THREE.ConeGeometry(2.2, 1, 4).rotateY(Math.PI / 4).translate(0, 2.95, 0), ...[[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]].map(([x, z]) => new THREE.BoxGeometry(.06, 2.4, .06).translate(x, 1.2, z))]);
  const fanMat = sway(new THREE.MeshStandardMaterial({ roughness: .85 }), .025, 'fans');
  chunks.build(world.root, {
    spruce: { geo: needles, mat: spruceMat, range: 1600 }, stem: { geo: stem, mat: barkMat, range: 900 },
    beech: { geo: beechGeo, mat: beechMat, range: 1600 }, bush: { geo: bush, mat: bushMat, range: 700, cast: false },
    post: { geo: postGeo, mat: postMat, range: 650, cast: false }, fencePost: { geo: new THREE.CylinderGeometry(.05, .06, 4.4, 6).translate(0, 2.2, 0), mat: postMat, range: 900 },
    fan: { geo: person, mat: fanMat, range: 900, cast: false }, tent: { geo: dome, mat: new THREE.MeshStandardMaterial({ roughness: .8 }), range: 1500 },
    camper: { geo: van, mat: new THREE.MeshStandardMaterial({ roughness: .5, metalness: .2 }), range: 1500 }, gazebo: { geo: gazebo, mat: new THREE.MeshStandardMaterial({ roughness: .7, side: THREE.DoubleSide }), range: 1500 },
    fire: { geo: new THREE.SphereGeometry(.6, 8, 5).scale(1, .45, 1), mat: fireMat, range: 1500, cast: false }, pole: { geo: poleGeo, mat: std('#cfd3d4', .3, .8), range: 1200, cast: false },
    deck: { geo: new THREE.BoxGeometry(1, .2, 1), mat: new THREE.MeshStandardMaterial({ roughness: .9 }), range: 1200 },
    wall: { geo: wallGeo, mat: new THREE.MeshStandardMaterial({ roughness: .9 }), range: 9000 }, roof: { geo: roofGeo, mat: new THREE.MeshStandardMaterial({ roughness: .75 }), range: 9000 },
    spire: { geo: spire, mat: new THREE.MeshStandardMaterial({ roughness: .7 }), range: 9000 }
  });
  return { height, update: (car) => chunks.update(car.x, car.z) };
}
