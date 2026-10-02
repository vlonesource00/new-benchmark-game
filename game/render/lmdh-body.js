import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural LMDh / GTP body, built in car space (x right, y up, z forward,
// origin between the axles at ground level) to match the lmdh car spec:
// 3.10 m wheelbase, 1.72 m track, 5.1 m long, 2.0 m wide, ~1.07 m tall.
//
// The surfaces are lofted superellipse sections through spline keyframes, so
// they stay smooth at any distance. Parts follow the class's signature shapes:
// a low nose slung between tall front fenders with louvred tops, a closed
// teardrop canopy with a roof scoop, a shark fin running into a swan-neck rear
// wing, full-width light bars, a splitter, dive planes and a finned diffuser.
// Output matches loadBody() in car-pro.js: merged geometry per material name.

const FZ = 1.674, RZ = -1.426, WX = 0.86;

// Catmull-Rom through keyframes [{z, ...params}] sampled at n stations.
function sample(keys, n) {
  const out = [], names = Object.keys(keys[0]).filter((k) => k !== 'z');
  const z0 = keys[0].z, z1 = keys.at(-1).z;
  for (let i = 0; i <= n; i++) {
    const z = z0 + (z1 - z0) * i / n;
    let j = 0; while (j < keys.length - 2 && (z1 < z0 ? z < keys[j + 1].z : z > keys[j + 1].z)) j++;
    const a = keys[Math.max(0, j - 1)], b = keys[j], c = keys[j + 1], d = keys[Math.min(keys.length - 1, j + 2)];
    const t = (z - b.z) / (c.z - b.z || 1), t2 = t * t, t3 = t2 * t;
    const st = { z };
    for (const k of names) {
      const p0 = a[k], p1 = b[k], p2 = c[k], p3 = d[k];
      st[k] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }
    out.push(st);
  }
  return out;
}

const se = (v, n) => Math.sign(v) * Math.abs(v) ** (2 / n);

/**
 * Lofted shell: each station is a superellipse with centre x (cx), half width
 * (w), top (top), bottom (bot) and exponent (n). `arc` limits the section to
 * the part above the given angle range (radians from +x, counter-clockwise),
 * so fenders and canopies can be open underneath.
 */
function loft(keys, { n = 36, ring = 28, arc = [0, Math.PI * 2], caps = true, grow = 0 } = {}) {
  const st = sample(keys, n), pos = [], idx = [];
  const closed = arc[1] - arc[0] >= Math.PI * 2 - 1e-6;
  const cols = closed ? ring : ring + 1;
  for (const s of st) {
    const cy = (s.top + s.bot) / 2, hy = Math.max(0.005, (s.top - s.bot) / 2) + grow, w = Math.max(0.005, s.w) + grow, ex = s.n ?? 3;
    for (let k = 0; k < cols; k++) {
      const a = arc[0] + (arc[1] - arc[0]) * k / ring;
      pos.push((s.cx ?? 0) + w * se(Math.cos(a), ex), cy + hy * se(Math.sin(a), ex), s.z);
    }
  }
  for (let i = 0; i < st.length - 1; i++) for (let k = 0; k < ring; k++) {
    const k1 = closed ? (k + 1) % ring : k + 1;
    const a = i * cols + k, b = i * cols + k1, c = (i + 1) * cols + k, d = (i + 1) * cols + k1;
    idx.push(a, c, b, b, c, d);
  }
  if (caps && closed) for (const [i, flip] of [[0, true], [st.length - 1, false]]) {
    const s = st[i], centre = pos.length / 3; pos.push(s.cx ?? 0, (s.top + s.bot) / 2, s.z);
    for (let k = 0; k < ring; k++) { const a = i * cols + k, b = i * cols + (k + 1) % ring; flip ? idx.push(centre, b, a) : idx.push(centre, a, b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  // Normals must face out: test one face mid-loft against the section centre.
  const i = Math.floor(st.length / 2), k = Math.floor(ring / 4), s = st[i], P = (j) => new THREE.Vector3(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
  const a = P(i * cols + k), b = P(i * cols + k + 1), c = P((i + 1) * cols + k);
  const face = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(b, a));
  if (face.dot(a.clone().sub(new THREE.Vector3(s.cx ?? 0, (s.top + s.bot) / 2, s.z))) < 0) g.index.array.reverse();
  g.computeVertexNormals();
  return g;
}

/** Side-profile plate: points in (z, y), extruded `t` thick across x at `x`. */
function plate(points, t, x = 0) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 12 });
  g.rotateY(-Math.PI / 2); g.translate(x + t / 2, 0, 0);
  return g;
}

/** Wing element: an airfoil in (z, y) extruded across the car. */
function airfoil(chord, thick, span, aoa) {
  const pts = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16, y = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4); pts.push([-t * chord, y * 1.25]); }
  for (let i = 16; i >= 0; i--) { const t = i / 16, y = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4); pts.push([-t * chord, -y * 0.45]); }
  const g = plate(pts, span); g.rotateX(aoa);
  return g;
}

const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); return g.translate(x, y, z); };

function clean(g) {
  for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
  return g.index ? g.toNonIndexed() : g;
}

let cached = null;
export function buildLmdhBody() {
  if (cached) return cached;
  const parts = { Paint: [], Glass: [], Carbon: [], Grille: [], Well: [], LightF: [], LightR: [] };
  const add = (name, ...gs) => parts[name].push(...gs.flat());

  // ---- monocoque and nose, slung low between the fenders ----
  add('Paint', loft([
    { z: 2.66, w: .44, top: .27, bot: .11, n: 2.6 },
    { z: 2.42, w: .56, top: .37, bot: .09, n: 3 },
    { z: 2.0, w: .5, top: .47, bot: .08, n: 3.2 },
    { z: 1.45, w: .46, top: .58, bot: .08, n: 3.2 },
    { z: .85, w: .6, top: .69, bot: .08, n: 3.4 },
    { z: .15, w: .9, top: .73, bot: .08, n: 4.2 },
    { z: -.6, w: .93, top: .74, bot: .08, n: 4.2 },
    { z: -1.35, w: .66, top: .79, bot: .09, n: 3.6 },
    { z: -2.05, w: .7, top: .8, bot: .16, n: 3.6 },
    { z: -2.42, w: .8, top: .76, bot: .3, n: 4 }
  ], { n: 48, ring: 36 }));

  // ---- fenders: open underneath so the tyres show, louvres on the front tops ----
  const fender = (side, keys) => loft(keys.map((k) => ({ ...k, cx: side * k.cx })), { n: 34, ring: 28, arc: [-.2, Math.PI + .2] });
  for (const side of [1, -1]) {
    add('Paint', fender(side, [
      { z: 2.62, cx: .72, w: .16, top: .36, bot: .2, n: 3 },
      { z: 2.36, cx: .76, w: .23, top: .64, bot: .2, n: 4.5 },
      { z: 2.0, cx: .77, w: .25, top: .8, bot: .3, n: 5.5 },
      { z: FZ, cx: .77, w: .25, top: .83, bot: .34, n: 6 },
      { z: 1.3, cx: .77, w: .24, top: .8, bot: .32, n: 5.5 },
      { z: .95, cx: .76, w: .2, top: .7, bot: .3, n: 4.5 },
      { z: .6, cx: .74, w: .1, top: .6, bot: .3, n: 3 }
    ]));
    add('Paint', fender(side, [
      { z: -.35, cx: .76, w: .14, top: .7, bot: .3, n: 3.5 },
      { z: -.85, cx: .77, w: .24, top: .84, bot: .32, n: 5.5 },
      { z: RZ, cx: .78, w: .25, top: .88, bot: .34, n: 6 },
      { z: -1.95, cx: .78, w: .25, top: .86, bot: .34, n: 5.5 },
      { z: -2.42, cx: .77, w: .22, top: .78, bot: .34, n: 4.5 }
    ]));
    // Louvres: a dark vent with eight raked slats over each front wheel.
    add('Grille', box(.34, .012, .46, side * .77, .832, 1.6, -.04));
    for (let i = 0; i < 8; i++) add('Carbon', box(.34, .05, .012, side * .77, .85, 1.41 + i * .056, -.75));
    // Wheel wells: dark half-drums behind the tyres.
    for (const z of [FZ, RZ]) {
      const well = new THREE.CylinderGeometry(.41, .41, .36, 20, 1, true, 0, Math.PI);
      well.rotateZ(Math.PI / 2); well.rotateX(-Math.PI / 2); add('Well', well.translate(side * WX, .36, z));
    }
    // Sidepod intake and the radiator exit gills.
    add('Grille', box(.04, .2, .5, side * .935, .48, .3, 0, side * .05));
    for (let i = 0; i < 4; i++) add('Carbon', box(.26, .01, .1, side * .62, .75, -.25 - i * .14, -.4));
    // Mirrors on the fender shoulders.
    const mirror = new THREE.SphereGeometry(.1, 16, 10); mirror.scale(1.5, .62, .9); add('Paint', mirror.translate(side * .86, .86, .62));
    add('Carbon', box(.025, .14, .05, side * .8, .76, .62, 0, 0, side * .4));
    // Dive planes on the nose corners.
    add('Carbon', box(.22, .012, .16, side * .9, .36, 2.42, .12, 0, -side * .22));
    add('Carbon', box(.18, .012, .12, side * .9, .45, 2.3, .1, 0, -side * .28));
    // Front LED blades under the fender leading edge, and a vertical DRL.
    add('LightF', box(.22, .028, .04, side * .76, .5, 2.47, -.35, side * .12));
    add('LightF', box(.024, .13, .03, side * .64, .44, 2.5, -.2));
    // Rear light end posts.
    add('LightR', box(.03, .16, .03, side * .92, .7, -2.38));
  }

  // ---- canopy, glasshouse and roof scoop ----
  const canopy = [
    { z: .9, w: .32, top: .74, bot: .58, n: 2.6 },
    { z: .55, w: .48, top: .95, bot: .6, n: 2.8 },
    { z: .12, w: .56, top: 1.06, bot: .6, n: 3 },
    { z: -.38, w: .53, top: 1.07, bot: .6, n: 3 },
    { z: -.88, w: .4, top: 1.0, bot: .62, n: 2.8 },
    { z: -1.3, w: .2, top: .85, bot: .66, n: 2.4 }
  ];
  add('Paint', loft(canopy, { n: 32, ring: 28, arc: [0, Math.PI] }));
  add('Glass', loft([
    { z: .82, w: .37, top: .8, bot: .6, n: 2.6 },
    { z: .55, w: .48, top: .95, bot: .6, n: 2.8 },
    { z: .2, w: .55, top: 1.05, bot: .6, n: 3 },
    { z: -.05, w: .56, top: 1.065, bot: .6, n: 3 }
  ], { n: 18, ring: 24, arc: [.48, Math.PI - .48], grow: .006 }));
  for (const side of [1, -1]) add('Glass', loft([
    { z: -.05, cx: side * .45, w: .1, top: 1.0, bot: .8, n: 2.4 },
    { z: -.45, cx: side * .43, w: .1, top: .99, bot: .82, n: 2.4 }
  ], { n: 6, ring: 10, arc: side > 0 ? [-.6, .9] : [Math.PI - .9, Math.PI + .6], grow: .012 }));
  add('Carbon', loft([
    { z: .02, w: .07, top: 1.07, bot: 1.0, n: 2.6 },
    { z: -.14, w: .13, top: 1.17, bot: 1.0, n: 3 },
    { z: -.6, w: .12, top: 1.15, bot: 1.0, n: 3 },
    { z: -.92, w: .07, top: 1.06, bot: .96, n: 2.6 }
  ], { n: 16, ring: 18 }));
  add('Grille', box(.2, .07, .01, 0, 1.12, -.12));

  // ---- shark fin into the swan-neck rear wing ----
  add('Paint', plate([[-.62, 1.12], [-1.2, 1.16], [-2.1, 1.2], [-2.3, 1.2], [-2.3, .84], [-1.3, .84], [-.9, .98]], .024));
  const wingZ = -2.2, wingY = 1.18;
  add('Carbon', airfoil(.44, .1, 1.82, -.1).translate(0, wingY, wingZ));
  add('Carbon', airfoil(.2, .1, 1.82, -.42).translate(0, wingY + .1, wingZ - .4));
  add('Carbon', box(1.82, .006, .03, 0, wingY + .04, wingZ - .64, .3));
  for (const side of [1, -1]) {
    add('Carbon', plate([[-1.95, .82], [-1.95, 1.3], [-2.25, 1.38], [-2.72, 1.36], [-2.72, .9], [-2.4, .76]], .018, side * .92));
    add('Carbon', plate([[-1.98, .8], [-2.08, 1.05], [-2.12, 1.27], [-2.28, 1.27], [-2.26, 1.06], [-2.18, .8]], .02, side * .28));
  }

  // ---- splitter, diffuser and light bar ----
  add('Carbon', box(1.92, .025, .82, 0, .075, 2.3));
  add('Carbon', box(1.7, .02, .3, 0, .09, 2.72, -.05));
  add('Carbon', box(1.7, .02, .55, 0, .18, -2.2, -.32));
  for (const x of [-.6, -.2, .2, .6]) add('Carbon', box(.012, .2, .52, x, .14, -2.18, -.32));
  add('Carbon', box(1.62, .1, .05, 0, .3, -2.43));
  add('LightR', box(1.72, .03, .03, 0, .74, -2.41));
  add('LightR', box(.08, .07, .02, 0, 1.08, -1.0));     // rain light on the fin root
  add('Grille', box(.5, .1, .04, 0, .52, -2.43));        // exhaust bay

  const merged = new Map();
  for (const [name, list] of Object.entries(parts)) if (list.length) merged.set(name, mergeGeometries(list.map(clean), false));
  const shadowGeo = mergeGeometries([...merged.values()].map((g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); return c; }), false);
  const lamps = {
    LightF: [new THREE.Vector3(-.76, .5, 2.5), new THREE.Vector3(.76, .5, 2.5)],
    LightR: [new THREE.Vector3(-.7, .74, -2.43), new THREE.Vector3(.7, .74, -2.43)]
  };
  cached = { merged, lamps, shadowGeo, exhaust: [new THREE.Vector3(-.12, .52, -2.47), new THREE.Vector3(.12, .52, -2.47)] };
  return cached;
}
