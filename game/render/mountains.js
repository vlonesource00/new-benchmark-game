import * as THREE from 'three';
import { random } from '../engine/sim/math.js';

// Horizon mountains as real terrain: a polar grid ring from just outside the
// circuit to past the fog line, heights from ridged fractal noise, coloured by
// height and slope (meadow, forest, rock, snow) and lit by the sun, so ridges
// and valleys read in relief instead of as flat cut-outs. One mesh, one draw.
//   theme.hills: { colors: [low, mid, high], height, jagged, snow, mesa, arc: [start, span] (x PI) }

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function noise2(seed) {
  const rng = random(seed), P = new Uint16Array(512), G = new Float32Array(256);
  for (let i = 0; i < 256; i++) { P[i] = i; G[i] = rng(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const h = (x, y) => G[P[P[x & 255] + (y & 255)]];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

export function buildMountains(world, { add, std }) {
  const th = world.theme, hl = th.hills, b = world.bounds, harbor = th.harbor;
  const cx = harbor ? 0 : b.cx, cz = harbor ? 0 : b.cz, R0 = harbor ? 2300 : Math.max(2300, b.r + 1400), R1 = R0 + 3400;
  const arc = hl.arc ?? [0, 2], n = noise2(1931 + Math.round(b.r));
  const H = 330 * hl.height * (hl.jagged ? 1.5 : 1);
  const A = 720, RINGS = 46;
  // Angular mask for partial arcs (the harbour keeps its western arc), feathered at the ends.
  const inArc = (a) => {
    if (arc[1] >= 2) return 1;
    const t = ((a / Math.PI - arc[0]) % 2 + 2) % 2;
    return smooth(0, .08, t) * (1 - smooth(arc[1] - .08, arc[1], t));
  };
  const height = (x, z, r, a) => {
    // Ridged multifractal: sharp crests, rounded valleys; the jagged themes push the ridges harder.
    let f = 0, amp = 1, freq = 1 / 2100, w = 1, sum = 0;
    for (let o = 0; o < 6; o++) {
      let v = 1 - Math.abs(n(x * freq + o * 17.3, z * freq - o * 9.1) * 2 - 1);
      v = v ** (hl.jagged ? 1.9 : 1.5) * w; w = Math.min(1, v * 1.8);
      f += v * amp; sum += amp; amp *= .5; freq *= 2.03;
    }
    f /= sum;
    const big = n(x / 5200 + 40, z / 5200 - 7);                     // whole massifs rise and fall along the horizon
    let y = H * (.2 + 1.4 * f ** 1.7) * (.55 + .9 * big);
    if (hl.mesa) {
      // Buttes: broad noise picks where tablelands stand, cliffs where it crosses a level, a second step on top.
      const m = n(x / 1700 + 3.3, z / 1700 - 5.1) * .75 + f * .25;
      y = H * (.06 + .1 * f + .5 * smooth(.5, .54, m) + .3 * smooth(.6, .63, m));
    }
    // Foothills first, the high range behind them; nothing inside R0.
    y *= smooth(R0, R0 + 1100, r) * (.6 + .4 * smooth(R0 + 600, R0 + 2400, r));
    return y * inArc(a) - 6;
  };
  const pos = new Float32Array((A + 1) * (RINGS + 1) * 3);
  for (let i = 0; i <= A; i++) {
    const a = Math.PI * 2 * i / A;
    for (let j = 0; j <= RINGS; j++) {
      const k = j / RINGS, r = R0 - 300 + (R1 - R0 + 300) * k ** 1.35;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      pos.set([x, height(x, z, r, a), z], (i * (RINGS + 1) + j) * 3);
    }
  }
  const idx = [];
  for (let i = 0; i < A; i++) for (let j = 0; j < RINGS; j++) { const p = i * (RINGS + 1) + j, q = p + RINGS + 1; idx.push(p, q, p + 1, p + 1, q, q + 1); }   // wound so the faces (and normals) look up
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  // Colour by height and slope: meadow and forest low, bare rock on steep faces, snow on high flats.
  const nrm = g.attributes.normal, col = new Float32Array(pos.length), c = new THREE.Color();
  const sandy = hl.mesa, [low, mid, high] = hl.colors.map((x) => new THREE.Color(x)), forest = low.clone().multiplyScalar(.62), snow = new THREE.Color('#eef2f6');
  const rock = sandy ? low.clone().multiplyScalar(.7) : high.clone().lerp(new THREE.Color('#8a8580'), .5);
  const snowLine = sandy ? 1e9 : H * (hl.snow ? .45 : .95);
  for (let v = 0; v < pos.length / 3; v++) {
    const y = pos[v * 3 + 1], up = nrm.getY(v), jit = n(pos[v * 3] / 90, pos[v * 3 + 2] / 90) - .5;
    c.copy(low).lerp(forest, sandy ? 0 : smooth(20, 120, y + jit * 60) * (1 - smooth(snowLine * .75, snowLine, y)));
    c.lerp(mid, smooth(H * .35, H * .6, y + jit * 80) * .6);
    c.lerp(rock, smooth(.86, .62, up + jit * .15));
    c.lerp(snow, smooth(snowLine, snowLine + 60, y + jit * 90) * smooth(.55, .8, up));
    if (sandy) c.multiplyScalar(.88 + .12 * Math.sin(y * .21 + jit * 2));   // sandstone strata
    // The theme colours are sRGB but the game runs without colour management, so they
    // would land as linear values and wash out; decode them (a little short of 2.2).
    col.set([c.r ** 1.9, c.g ** 1.9, c.b ** 1.9], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Half the scene's haze: at 3-6 km full fog would bleach the range into the sky,
  // and the ridges are what gives the circuit its sense of place.
  const mat = std('#ffffff', .95, 0, { vertexColors: true });
  mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `#ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * .3);
      #else
        float fogFactor = smoothstep(fogNear, fogFar * 1.6, vFogDepth);
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif`); };
  mat.customProgramCacheKey = () => 'mountains';
  return add(world.root, g, mat, 0, 0, 0, false);
}
