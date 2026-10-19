import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { random, clamp, wrap } from '../engine/sim/math.js';
import { signTexture } from './textures.js';
import { Chunks } from './eifel.js';

// Lago Aurelia: a northern-Italian lake circuit. The lake fills everything
// outside the marina straight and the Lungolago out to the mountains; a
// promenade with plane trees and packed spectators runs along the shore, the
// marina and a water castle sit at the Porto hairpin, the old town closes in on
// sector two (gate, piazza, church, walls) and sector three runs through
// vineyards, olive groves and cypress alleys. Sailboats, a lake steamer and
// balloons keep the view moving. Repeated pieces are instanced in 500 m chunks
// so whole parts of the lap cull at once; unique buildings are plain meshes the
// world's static batching merges.

const FAR = 4490;          // the lake runs out to the edge of the 9 km ground square

// The shoreline and a 10 m raster of the lake for point tests. Pure (track only),
// so the world can cut the ground and keep scenery dry before anything is built.
export function lakeOutline(track, cx, cz) {
  const L = track.length, at = (n) => (track.scenario.landmarks.find((m) => m.name === n)?.f ?? 0) * L;
  const porto = at('Tornante del Porto'), grande = at('Curva Grande'), s0 = 150, s1 = grande + 260;
  // Lateral distance of the shore from the centreline (positive is the lake side here).
  // Wide behind the main grandstand, then the promenade runs right behind the fence to Curva Grande.
  const off = (s) => s < 640 ? 105 : s < 760 ? 105 - (s - 640) / 120 * 57 : s < grande - 40 ? 48 : 48 + (s - grande + 40) / 300 * 180;
  const shore = [];
  for (let s = s0; s <= s1; s += 8) { const p = track.at(s, off(s)); shore.push([p.x, p.z, s]); }
  const a = shore[0], e = shore[shore.length - 1];
  const poly = [...shore.map(([x, z]) => [x, z]), [e[0] + 400, e[1] + 500], [cx + FAR, e[1] + 500], [cx + FAR, cz - FAR], [a[0], cz - FAR]];
  const C = 10, n = Math.ceil(2 * FAR / C), X0 = cx - FAR, Z0 = cz - FAR, mask = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = Z0 + (j + .5) * C, xs = [];
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) { const [xi, zi] = poly[i], [xk, zk] = poly[k]; if ((zi > z) !== (zk > z)) xs.push(xi + (z - zi) / (zk - zi) * (xk - xi)); }
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const i0 = Math.max(0, Math.ceil((xs[m] - X0) / C - .5)), i1 = Math.min(n - 1, Math.floor((xs[m + 1] - X0) / C - .5));
      for (let i = i0; i <= i1; i++) mask[j * n + i] = 1;
    }
  }
  const wet = (x, z) => { const i = Math.floor((x - X0) / C), j = Math.floor((z - Z0) / C); return i >= 0 && j >= 0 && i < n && j < n && mask[j * n + i] === 1; };
  const near = (x, z, r) => wet(x, z) || wet(x + r, z) || wet(x - r, z) || wet(x, z + r) || wet(x, z - r);
  return { poly, shore, wet, near, off, s0, s1 };
}

// ---- textures ----
function facadeTexture(canvasTexture) {
  // 8 m x 6.6 m: two bays, two storeys of shuttered windows on white plaster (tinted per house).
  const t = canvasTexture(512, 512, (c, w, h) => {
    const rng = random(9091);
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) { const v = 225 + rng() * 30; c.fillStyle = `rgba(${v},${v - 6},${v - 14},.35)`; c.fillRect(rng() * w, rng() * h, 2 + rng() * 9, 2 + rng() * 6); }
    for (let k = 0; k < 2; k++) { c.fillStyle = 'rgba(150,140,120,.45)'; c.fillRect(0, k * 256 + 250, w, 6); }
    for (let fy = 0; fy < 2; fy++) for (let bx = 0; bx < 2; bx++) {
      const x = bx * 256 + 128, y = fy * 256 + 70;
      c.fillStyle = '#e9e2d0'; c.fillRect(x - 41, y - 6, 82, 146);
      c.fillStyle = '#26302f'; c.fillRect(x - 34, y, 68, 132);
      c.fillStyle = 'rgba(160,190,200,.25)'; c.fillRect(x - 30, y + 4, 28, 60); c.fillRect(x + 2, y + 4, 28, 60);
      for (const sx of [-1, 1]) {
        const x0 = sx < 0 ? x - 74 : x + 38;
        c.fillStyle = '#3d6a47'; c.fillRect(x0, y, 36, 132);
        c.fillStyle = 'rgba(0,0,0,.25)'; for (let l = 6; l < 132; l += 8) c.fillRect(x0 + 3, y + l, 30, 2);
      }
      c.fillStyle = '#d8d0bc'; c.fillRect(x - 46, y + 132, 92, 10);
      if (fy === 0 && bx === 1) { c.fillStyle = '#5a5f63'; for (let r = 0; r < 9; r++) c.fillRect(x - 50 + r * 12, y + 104, 3, 34); c.fillRect(x - 52, y + 104, 104, 4); }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function stripeTexture(canvasTexture, colors) {
  return canvasTexture(512, 256, (c, w, h) => { const n = colors.length * 2; for (let i = 0; i < n; i++) { c.fillStyle = colors[i % colors.length]; c.fillRect(i * w / n, 0, w / n + 1, h); } });
}

// ---- geometry ----
function personGeometry() {
  // 1.75 m tall; the head starts at 1.5 m (the crowd shader colours it skin).
  const body = new THREE.CylinderGeometry(.22, .18, 1.5, 5).translate(0, .75, 0).toNonIndexed();
  const head = new THREE.IcosahedronGeometry(.13, 0).translate(0, 1.62, 0).toNonIndexed();
  return mergeGeometries([body, head]);
}
function hullGeometry() {
  const s = new THREE.Shape(); s.moveTo(-1, -4); s.lineTo(1, -4); s.lineTo(1.15, 1.2); s.quadraticCurveTo(1, 3.4, 0, 4.6); s.quadraticCurveTo(-1, 3.4, -1.15, 1.2); s.lineTo(-1, -4);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.2, bevelEnabled: false }); g.rotateX(-Math.PI / 2); g.translate(0, -.5, 0);
  const cabin = new THREE.BoxGeometry(1.4, .7, 2.4).translate(0, .95, -.6);
  return mergeGeometries([g.toNonIndexed(), cabin.toNonIndexed()]);
}
function cypressGeometry() {
  const prof = [[0, 0], [.55, .3], [.95, 1.6], [1.05, 3.2], [.95, 5], [.7, 6.8], [.38, 8.4], [0, 9.6]].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(prof, 7);
}
function oliveGeometry() {
  // Three lumpy blobs for the crown, flat-shaded so the facets read as clumps of leaves.
  const rng = random(707), blob = (x, y, z, r) => { const g = new THREE.IcosahedronGeometry(r, 1), p = g.attributes.position; for (let i = 0; i < p.count; i++) { const k = .8 + rng() * .4; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * .75, p.getZ(i) * k); } return g.translate(x, y, z).toNonIndexed(); };
  const crown = mergeGeometries([blob(0, 2.9, 0, 1.7), blob(1.1, 2.5, .5, 1.25), blob(-.9, 2.6, -.6, 1.3)]); crown.computeVertexNormals();
  const trunk = new THREE.CylinderGeometry(.18, .3, 2.2, 5).translate(0, 1.1, 0).toNonIndexed();
  const tint = (g, c) => { const col = new THREE.Color(c), a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) a.set([col.r, col.g, col.b], i); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  return mergeGeometries([tint(crown, '#55623f'), tint(trunk, '#5d5042')]);
}
function balloonGeometry() {
  const prof = [[0, 0], [.25, .1], [.55, .6], [.95, 1.6], [1.15, 2.6], [1.1, 3.4], [.85, 4.1], [.45, 4.5], [0, 4.6]].map(([r, y]) => new THREE.Vector2(r * 7, y * 7));
  return new THREE.LatheGeometry(prof, 24);
}

// Instanced boxes whose facade texture repeats with the instance size (8 m x 6.6 m tiles); roofs (up faces) stay plain.
function facadeMaterial(map) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: .9 });
  m.onBeforeCompile = (s) => {
    s.vertexShader = 'varying vec2 vFac;varying float vRoof;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 sc=vec3(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz),length(instanceMatrix[2].xyz));vec3 lp=position*sc;
      vFac=(abs(normal.x)>.5?vec2(lp.z,lp.y):vec2(lp.x,lp.y))/vec2(8.,6.6)+vec2(.5,0.);vRoof=step(.5,abs(normal.y));`);
    s.fragmentShader = 'varying vec2 vFac;varying float vRoof;\n' + s.fragmentShader
      .replace('#include <map_fragment>', 'diffuseColor*=mix(texture2D(map,vFac),vec4(.8,.78,.74,1.),vRoof);');
  };
  m.customProgramCacheKey = () => 'lago-facade';
  return m;
}

export function buildLago(world, kit) {
  const t = world.track, L = t.length, lake = world.lake, rng = random(61842), B = world.bounds;
  const { std, add, box, sway, canvasTexture, mipAlpha } = kit;
  const at = (name) => (t.scenario.landmarks.find((m) => m.name === name)?.f ?? 0) * L;
  const root = world.root, live = world.live, chunks = new Chunks(), color = new THREE.Color(), d = world.dummy;
  const bo = t.barrierOffset, land = world.land;
  const pose = (s, lat) => t.at(wrap(s, L), lat);

  // ---- water, shore wall, promenade ----
  {
    const shape = new THREE.Shape(lake.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ShapeGeometry(shape, 1); geo.rotateX(-Math.PI / 2);
    const normal = kit.waterNormal().clone(); normal.needsUpdate = true; normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 34, uv.getY(i) / 34);
    const water = new THREE.MeshPhysicalMaterial({ color: '#1d4a52', roughness: .06, metalness: 0, ior: 1.33, normalMap: normal, normalScale: new THREE.Vector2(.4, .4), envMapIntensity: 1.25, specularIntensity: 1 });
    water.onBeforeCompile = (s) => {
      s.uniforms.uTime = kit.TIME;
      s.fragmentShader = 'uniform float uTime;\n' + s.fragmentShader.replace('#include <normal_fragment_maps>', `
        vec3 n1=texture2D(normalMap,vNormalMapUv+vec2(uTime*.009,uTime*.005)).xyz*2.-1.;
        vec3 n2=texture2D(normalMap,vNormalMapUv*2.7+vec2(-uTime*.007,uTime*.011)).xyz*2.-1.;
        vec3 mapN=normalize(vec3((n1.xy+n2.xy*.7)*normalScale,max(n1.z*n2.z,.2)));
        normal=normalize(tbn*mapN);`);
    };
    water.customProgramCacheKey = () => 'lago-water';
    world.lakeMesh = add(root, geo, water, 0, -.75, 0, false);
    // Stone quay wall down to the water, with a capstone.
    const pos = [], idx = [], sh = lake.shore;
    for (let i = 0; i < sh.length; i++) { pos.push(sh[i][0], .08, sh[i][1], sh[i][0], -1.3, sh[i][1]); if (i) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); } }
    const wall = new THREE.BufferGeometry(); wall.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); wall.setIndex(idx); wall.computeVertexNormals();
    add(root, wall, std('#a39a88', .92, 0, { side: THREE.DoubleSide }), 0, 0, 0, false);
    // Promenade paving between the shore and the circuit fence, and a capstone kerb.
    const pave = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#c9bea8'; c.fillRect(0, 0, w, h); const r2 = random(5);
      for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 * 24; x < w; x += 48) { const v = 180 + r2() * 40; c.fillStyle = `rgb(${v},${v - 8},${v - 22})`; c.fillRect(x + 1, y + 1, 46, 30); }
    });
    pave.wrapS = pave.wrapT = THREE.RepeatWrapping;
    const strip = (from, to, y, mat) => {
      const p2 = [], u2 = [], i2 = [], n2 = [];
      for (let i = 0; i < sh.length; i++) {
        const s = sh[i][2], o = lake.off(s);
        for (const l of [o - from, o - to]) { const q = pose(s, l); p2.push(q.x, y, q.z); n2.push(0, 1, 0); u2.push(l / 3, s / 3); }
        if (i) { const k = (i - 1) * 2; i2.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p2, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(n2, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(u2, 2)); g.setIndex(i2);
      return add(root, g, mat, 0, 0, 0, false);
    };
    strip(0, 14, .03, new THREE.MeshStandardMaterial({ map: pave, roughness: .85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    strip(-.2, .7, .16, std('#d8d1c2', .8, 0, { side: THREE.DoubleSide }));
    // Railing posts, lamps, benches and plane trees along the promenade.
    for (let i = 0; i < sh.length; i++) {
      const s = sh[i][2], o = lake.off(s), q = pose(s, o - .3);
      if (i % 1 === 0) chunks.put('post', q.x, 0, q.z, q.heading, 1);
      if (i % 3 === 0) { const r = pose(s, o - 6.5); chunks.put('lamp', r.x, 0, r.z, r.heading, 1); }
      if (i % 3 === 1) { const r = pose(s + 4, o - 11); if (world.clearOf(r.x, r.z, 1)) chunks.put('tree', r.x, -.05, r.z, rng() * 6.28, .9 + rng() * .3, .9 + rng() * .3, .9 + rng() * .3, color.setHSL(.2 + rng() * .05, .2, .8)); }
      if (i % 5 === 2) { const r = pose(s, o - 3); chunks.put('bench', r.x, 0, r.z, r.heading, 1); }
      world.occupy(q.x, q.z, 6);
    }
    // Top rail as one ribbon along the posts.
    const rp = [], ri = [];
    for (let i = 0; i < sh.length; i++) { const s = sh[i][2], q = pose(s, lake.off(s) - .3); rp.push(q.x, 1.05, q.z, q.x, 1.12, q.z); if (i) { const k = (i - 1) * 2; ri.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); } }
    const rail = new THREE.BufferGeometry(); rail.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3)); rail.setIndex(ri); rail.computeVertexNormals();
    add(root, rail, std('#2d3436', .5, .7, { side: THREE.DoubleSide }), 0, 0, 0, false);
  }

  // ---- marina on the straight: piers, moored boats, a harbour office ----
  const porto = at('Tornante del Porto');
  {
    const pierMat = std('#8a7158', .85), pierPost = std('#4a3b2e', .9);
    for (let s = 780; s < porto - 160; s += 82) {
      const o = lake.off(s), a = pose(s, o), n = [a.nx, a.nz], len = 52 + rng() * 18;
      const g = new THREE.Group(); g.position.set(a.x + n[0] * len / 2, 0, a.z + n[1] * len / 2); g.rotation.y = Math.atan2(n[0], n[1]); root.add(g);
      box(g, pierMat, 0, .25, 0, 3, .3, len, false);
      for (let z = -len / 2; z <= len / 2; z += 6) for (const x of [-1.4, 1.4]) box(g, pierPost, x, -.4, z, .25, 1.6, .25, false);
      for (let z = -len / 2 + 6; z < len / 2 - 2; z += 6.5) for (const x of [-1, 1]) {
        if (rng() < .15) continue;
        const bx = g.position.x + Math.sin(g.rotation.y) * z + Math.cos(g.rotation.y) * x * 4.6, bz = g.position.z + Math.cos(g.rotation.y) * z - Math.sin(g.rotation.y) * x * 4.6;
        const yaw = g.rotation.y + Math.PI / 2 * x + (rng() - .5) * .08, sc = .8 + rng() * .5;
        chunks.put('hull', bx, 0, bz, yaw, sc, 1, sc, color.set(rng() < .7 ? '#f2f0ea' : ['#1d2f4f', '#7d2424', '#2c5a6b', '#c9b48a'][Math.floor(rng() * 4)]));
        if (rng() < .55) chunks.put('mast', bx, 0, bz, yaw, 1, .8 + sc * .5, 1);
      }
    }
    // Harbour office with a clock tower near the head of the piers.
    const hq = pose(porto - 260, bo + 9.5), g = new THREE.Group(); g.position.set(hq.x, 0, hq.z); g.rotation.y = hq.heading; root.add(g);
    box(g, std('#d9b36f', .85), 0, 4, 0, 10, 8, 18); box(g, std('#b4553a', .8), 0, 8.4, 0, 11, .8, 19);
    box(g, std('#e7dcc3', .8), 0, 11, 6, 4, 14, 4); add(g, new THREE.ConeGeometry(3.1, 3, 4).rotateY(Math.PI / 4), std('#a14a33', .8), 0, 19.5, 6);
    const clock = add(g, new THREE.CircleGeometry(1.2, 24), std('#f6f2e6', .5), -2.02, 15, 6, false); clock.rotation.y = -Math.PI / 2;
    world.occupy(hq.x, hq.z, 14);
  }

  // ---- Rocca: the water castle off the Porto hairpin ----
  {
    const c = pose(porto + 30, lake.off(porto + 30) + 95), stone = std('#b9ad94', .95), dark = std('#8d826c', .95);
    const g = new THREE.Group(); g.position.set(c.x, 0, c.z); g.rotation.y = c.heading; root.add(g);
    box(g, dark, 0, -.6, 0, 66, 2.2, 66);
    const W = 52, H = 12, merl = [];
    for (const [x, z, w, dd] of [[0, -W / 2, W, 2.4], [0, W / 2, W, 2.4], [-W / 2, 0, 2.4, W], [W / 2, 0, 2.4, W]]) {
      box(g, stone, x, H / 2, z, w, H, dd);
      const along = w > dd, n = Math.floor((along ? w : dd) / 2.2);
      for (let k = 0; k < n; k++) { const u = -((along ? w : dd) / 2) + 1.1 + k * 2.2; merl.push(along ? [x + u, H + .6, z] : [x, H + .6, z + u]); }
    }
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      box(g, stone, x * W / 2, 9, z * W / 2, 8, 18, 8);
      for (let k = 0; k < 4; k++) for (let m = 0; m < 3; m++) { const u = -2.6 + m * 2.6; merl.push(k % 2 ? [x * W / 2 + (k === 1 ? 4 : -4), 18.6, z * W / 2 + u] : [x * W / 2 + u, 18.6, z * W / 2 + (k === 0 ? 4 : -4)]); }
    }
    box(g, stone, 6, 15, -4, 11, 30, 11);
    for (let k = 0; k < 4; k++) for (let m = 0; m < 4; m++) { const u = -4 + m * 2.7; merl.push(k % 2 ? [6 + (k === 1 ? 5.5 : -5.5), 30.6, -4 + u] : [6 + u, 30.6, -4 + (k === 0 ? 5.5 : -5.5)]); }
    for (const [x, y, z] of merl) {
      const p = new THREE.Vector3(x, y, z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, g.rotation.y).add(g.position);
      chunks.put('merlon', p.x, p.y, p.z, g.rotation.y, 1);
    }
    // Causeway to the promenade and a flag on the keep.
    const sh = pose(porto + 30, lake.off(porto + 30)), len = Math.hypot(c.x - sh.x, c.z - sh.z) - 33;
    const cw = add(root, new THREE.BoxGeometry(5, 1, len), dark, (sh.x * (len / 2 + 33) + c.x * (len / 2)) / (len + 33), .2, (sh.z * (len / 2 + 33) + c.z * (len / 2)) / (len + 33), false);
    cw.rotation.y = Math.atan2(c.x - sh.x, c.z - sh.z);
    world.rocca = { x: c.x, z: c.z };
  }

  // ---- the old town: sector two between the gate and the walls ----
  const borgo = at('Porta del Borgo'), mura = at('Mura'), chiesa = at('Esse della Chiesa'), piazza = at('Piazza');
  const townFrom = borgo - 110, townTo = mura + 120;
  const facade = facadeMaterial(facadeTexture(canvasTexture));
  const WALLS = ['#d9a35a', '#c7704a', '#e8cf8a', '#d99a8c', '#ece0c4', '#b5653c', '#e3b98c', '#cfa77a', '#f0d9a8'];
  const house = (x, z, rot, w, dd, h, roof = true) => {
    chunks.put('house', x, 0, z, rot, dd, h, w, color.set(WALLS[Math.floor(rng() * WALLS.length)]).multiplyScalar(.92 + rng() * .14));
    if (roof) chunks.put('roof', x, h, z, rot, dd * 1.06, 1.6 + rng() * 1.6, w * 1.06, color.setHSL(.03 + rng() * .02, .5, .36 + rng() * .1));
  };
  // Landmarks first so the rows of houses leave them room.
  const roomy = (s, dist) => { let best = null; for (const side of [-1, 1]) { const p = pose(s, side * dist); let free = 0; for (const r of [0, 15, 30]) if (world.clearOf(p.x + (p.nx * side) * r, p.z + (p.nz * side) * r, 4) && land(p.x, p.z)) free++; if (!best || free > best.free) best = { p, side, free }; } return best; };
  {
    // Church and campanile beside the church esses.
    const { p, side } = roomy(chiesa + 20, bo + 26), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading + (side > 0 ? 0 : Math.PI); root.add(g);
    const stone = std('#e2d6bb', .9), roofM = std('#a64f36', .85);
    box(g, stone, 0, 8, 0, 14, 16, 30);
    const gable = new THREE.Shape(); gable.moveTo(-7.6, 0); gable.lineTo(7.6, 0); gable.lineTo(0, 5); gable.lineTo(-7.6, 0);
    const gr = new THREE.ExtrudeGeometry(gable, { depth: 31, bevelEnabled: false }); gr.translate(0, 16, -15.5); add(g, gr, roofM);
    box(g, stone, 0, 9, -15.4, 15, 18, 1.2);
    add(g, new THREE.CircleGeometry(2.2, 24), std('#5b6e8c', .3, .2, { emissive: '#ffcf8a', emissiveIntensity: .25 }), 0, 12, -16.05, false).rotation.y = Math.PI;
    box(g, std('#d4c4a4', .9), 9.5, 19, 10, 6.5, 38, 6.5);
    for (const [x, z] of [[9.5, 6.7], [9.5, 13.3], [6.2, 10], [12.8, 10]]) box(g, std('#1c1f20', .9), x, 33, z, x === 9.5 ? 2 : .2, 4.5, x === 9.5 ? .2 : 2, false);
    add(g, new THREE.ConeGeometry(4.8, 7, 4).rotateY(Math.PI / 4), roofM, 9.5, 41.5, 10);
    world.occupy(p.x, p.z, 26); world.campanile = { x: p.x, z: p.z };
  }
  {
    // Porta del Borgo: two towers and a crenellated bridge over the road, banners both ways.
    const s = borgo - 45, p = pose(s, 0), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading; root.add(g);
    const stone = std('#c8b998', .95), span = bo + 4;
    for (const x of [-span, span]) { box(g, stone, x, 9, 0, 8, 18, 9); for (let k = 0; k < 3; k++) for (const z of [-4, 4]) box(g, stone, x - 2.6 + k * 2.6, 18.7, z, 1.4, 1.4, .9); }
    box(g, stone, 0, 13.5, 0, span * 2, 5, 7);
    for (let x = -span + 1; x < span; x += 2.4) for (const z of [-3.2, 3.2]) box(g, stone, x, 16.6, z, 1.3, 1.2, .7);
    const sign = signTexture('LAGO AURELIA', 'AUTODROMO · BORGO VECCHIO', { bg: '#7a1f1a', accent: '#f2c230' });
    for (const z of [-3.56, 3.56]) { const b = add(g, new THREE.PlaneGeometry(span * 1.3, span * .33), new THREE.MeshStandardMaterial({ map: sign, roughness: .6 }), 0, 13.5, z, false); b.rotation.y = z < 0 ? Math.PI : 0; }
    world.occupy(pose(s, -span).x, pose(s, -span).z, 8); world.occupy(pose(s, span).x, pose(s, span).z, 8);
  }
  {
    // Rows of town houses on both sides, set back just behind the barrier.
    for (const side of [-1, 1]) {
      let s = townFrom;
      while (s < townTo) {
        const w = 8 + rng() * 8; let dd = 10 + rng() * 8, ok = false;
        const core = 1 - Math.min(1, Math.abs(s - piazza) / 600);
        const h = 8 + rng() * 6 + core * 6 * rng();
        for (let tries = 0; tries < 3 && !ok; tries++) {
          const p = pose(s + w / 2, side * (bo + 2.6 + dd / 2)), tx = p.tx, tz = p.tz, nx = p.nx * side, nz = p.nz * side;
          const pts = [[0, 0], [w / 2, dd / 2], [-w / 2, dd / 2], [w / 2, -dd / 2], [-w / 2, -dd / 2]].map(([u, v]) => [p.x + tx * u + nx * v, p.z + tz * u + nz * v]);
          if (pts.every(([x, z]) => world.clearOf(x, z, -.5) && land(x, z)) && world.isFree(p.x, p.z, Math.min(w, dd) / 2 - 1)) {
            house(p.x, p.z, p.heading, w, dd, h); ok = true;
            // Spectators packed along the fence in front, some flags hung from the windows.
            for (let u = -w / 2 + .5; u < w / 2; u += 1.1) if (rng() < .62) { const q = pose(s + w / 2 + u, side * (bo + .5 + rng() * 1.7)); chunks.put('person', q.x, 0, q.z, q.heading + side * Math.PI / 2 + Math.PI + (rng() - .5) * .6, .92 + rng() * .16, .92 + rng() * .16, .92 + rng() * .16, color.setHSL(rng(), .55, .35 + rng() * .3)); }
            if (rng() < .3) { const q = pose(s + w / 2, side * (bo + 2.4)); chunks.put('flag', q.x, 4 + Math.floor(rng() * 2) * 3.3, q.z, q.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 1, 1, color.set(['#c8102e', '#ffffff', '#009246', '#1b2a6b', '#f2c230'][Math.floor(rng() * 5)])); }
          } else dd *= .7;
        }
        s += w + (rng() < .1 ? 6 : .4);
      }
    }
    // Bunting strung across the road between the houses.
    const pos = [], col = [], pal = ['#c8102e', '#f2f0e8', '#009246', '#f2c230', '#1b5aa6'].map((c) => new THREE.Color(c));
    for (let s = townFrom + 40; s < townTo - 30; s += 55 + rng() * 40) {
      const a = pose(s, -(bo + 2.6)), b = pose(s, bo + 2.6), n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / .7);
      for (let i = 0; i < n; i++) {
        const k0 = i / n, k1 = (i + .55) / n, y0 = 9.5 - Math.sin(k0 * Math.PI) * 1.6, y1 = 9.5 - Math.sin(k1 * Math.PI) * 1.6;
        const x0 = a.x + (b.x - a.x) * k0, z0 = a.z + (b.z - a.z) * k0, x1 = a.x + (b.x - a.x) * k1, z1 = a.z + (b.z - a.z) * k1;
        pos.push(x0, y0, z0, x1, y1, z1, (x0 + x1) / 2, (y0 + y1) / 2 - .45, (z0 + z1) / 2); const c = pal[i % pal.length]; for (let v = 0; v < 3; v++) col.push(c.r, c.g, c.b);
      }
    }
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); bg.computeVertexNormals();
    add(root, bg, std('#ffffff', .8, 0, { vertexColors: true, side: THREE.DoubleSide }), 0, 0, 0, false);
    // Town walls with towers on the open side of the Mura corner.
    const { side } = roomy(mura + 40, bo + 12), stone = std('#bfb08f', .95);
    for (let s = mura - 60; s < mura + 260; s += 6) {
      const p = pose(s, side * (bo + 7)); if (!world.clearOf(p.x, p.z, 1) || !world.isFree(p.x, p.z, 2)) continue;
      chunks.put('wall', p.x, 0, p.z, p.heading, 1); chunks.put('merlon', p.x, 8.6, p.z, p.heading, 1);
      if (Math.round(s) % 72 < 6) box(root, stone, p.x, 6.5, p.z, 7, 13, 7);
    }
  }

  // ---- sector three: vineyards, olive groves, cypress alleys, villas ----
  {
    const vigne = t.scenario.landmarks.find((m) => m.name === 'Curvone') ? at('Curvone') - 700 : 0;
    // Cypress alleys both sides of the Vigne straight and along the Lungolago's inland side.
    for (const [from, to, sides] of [[vigne - 40, at('Cipressi') + 60, [-1, 1]], [porto + 200, at('Curva Grande') - 40, [-1]], [at('Variante del Lago') + 30, at('Curva del Lago') + 60, [-1, 1]]]) {
      for (let s = from; s < to; s += 13 + rng() * 3) for (const side of sides) {
        const p = pose(s, side * (bo + 7 + rng() * 2)); if (!world.clearOf(p.x, p.z, 1.5) || !land(p.x, p.z) || !world.isFree(p.x, p.z, 1.5)) continue;
        const sc = .9 + rng() * .4; chunks.put('cypress', p.x, -.05, p.z, rng() * 6.28, sc, sc * (1 + rng() * .3), sc, color.setHSL(.29 + rng() * .05, .45, .045 + rng() * .025)); world.occupy(p.x, p.z, 2);
      }
    }
    // Vineyard plots: rows of vines on the infield and the slopes past Vigne.
    const span = (B.x1 - B.x0) + 900, spanZ = (B.z1 - B.z0) + 900;
    let plots = 0;
    // Most plots line the vineyard sector (Mura to the Variante) within sight of the road; the rest anywhere.
    const s3a = at('Mura'), s3b = at('Variante del Lago');
    for (let k = 0; k < 2400 && plots < 80; k++) {
      let x, z;
      if (k % 3) { const p = pose(s3a + rng() * (s3b - s3a), (rng() < .5 ? -1 : 1) * (bo + 50 + rng() * 260)); x = p.x; z = p.z; }
      else { x = B.x0 - 450 + rng() * span; z = B.z0 - 450 + rng() * spanZ; }
      const w = 70 + rng() * 110, dd = 60 + rng() * 80, rot = rng() * Math.PI;
      const ca = Math.cos(rot), sa = Math.sin(rot), corners = [[w / 2, dd / 2], [-w / 2, dd / 2], [w / 2, -dd / 2], [-w / 2, -dd / 2], [0, 0]].map(([u, v]) => [x + ca * u + sa * v, z - sa * u + ca * v]);
      if (!corners.every(([cx, cz]) => Math.abs(t.nearest(cx, cz).lateral) > bo + 30 && land(cx, cz) && !lake.near(cx, cz, 30) && world.isFree(cx, cz, 6))) continue;
      plots++;
      const olive = rng() < .3;
      if (olive) {
        for (let u = -w / 2 + 4; u < w / 2; u += 9) for (let v = -dd / 2 + 4; v < dd / 2; v += 9) { const px = x + ca * u + sa * v + (rng() - .5) * 2, pz = z - sa * u + ca * v + (rng() - .5) * 2, sc = .8 + rng() * .4; chunks.put('olive', px, 0, pz, rng() * 6.28, sc, sc * (.8 + rng() * .4), sc, color.setHSL(0, 0, .85 + rng() * .25)); }
      } else {
        const tone = color.setHSL(.2 + rng() * .06, .5, .14 + rng() * .05).clone();
        for (let v = -dd / 2 + 1.4; v < dd / 2; v += 2.8) { const px = x + sa * v, pz = z + ca * v; chunks.put('vine', px, 0, pz, rot + Math.PI / 2, .8, 1.3 + rng() * .2, w, color.copy(tone).multiplyScalar(.85 + rng() * .3)); }
      }
      world.occupy(x, z, Math.min(w, dd) / 2);
    }
    // Villas on the slopes: a house, a hip roof, a ring of cypresses.
    for (let k = 0, n = 0; k < 400 && n < 10; k++) {
      const x = B.x0 - 500 + rng() * (span + 100), z = B.z0 - 500 + rng() * (spanZ + 100);
      if (Math.abs(t.nearest(x, z).lateral) < bo + 60 || !land(x, z) || lake.near(x, z, 40) || !world.isFree(x, z, 26)) continue;
      n++; const rot = rng() * 6.28; house(x, z, rot, 16 + rng() * 8, 12 + rng() * 6, 9 + rng() * 4);
      for (let a = 0; a < 6.28; a += .5) { const r = 18 + rng() * 4; chunks.put('cypress', x + Math.cos(a) * r, -.05, z + Math.sin(a) * r, 0, 1, 1.1, 1, color.setHSL(.3, .45, .055)); }
      world.occupy(x, z, 26);
    }
  }

  // ---- crowds: the promenade along the Lungolago, the hairpins, the Anello ----
  {
    const zones = [[780, porto - 140, 1, 2], [porto + 140, at('Curva Grande') - 30, 1, 3], [porto - 70, porto + 60, 1, 4], [at('Tornante San Rocco') - 60, at('Tornante San Rocco') + 50, 0, 3], [at('Anello') - 30, at('Anello') + 160, 0, 3], [at('Variante del Lago') - 40, at('Variante del Lago') + 60, 0, 3]];
    for (const [from, to, sideHint, rows] of zones) for (const side of sideHint ? [sideHint] : [-1, 1]) for (let s = from; s < to; s += .9) {
      if (rng() < .3) continue;
      for (let r = 0; r < rows; r++) {
        if (rng() < .25) continue;
        const p = pose(s + (rng() - .5) * .6, side * (bo + 1 + r * .9 + rng() * .4));
        if (!world.clearOf(p.x, p.z, -1.5) || !land(p.x, p.z)) continue;
        chunks.put('person', p.x, 0, p.z, p.heading + side * Math.PI / 2 + Math.PI + (rng() - .5) * .7, .92 + rng() * .16, .92 + rng() * .16, .92 + rng() * .16, color.setHSL(rng(), .55, .35 + rng() * .3));
      }
      if (rng() < .012) { const p = pose(s, side * (bo + 6)); if (land(p.x, p.z) && world.clearOf(p.x, p.z, 2)) chunks.put('parasol', p.x, 0, p.z, rng() * 6.28, 1, 1, 1, color.set(['#c8102e', '#f2f0e8', '#1b5aa6', '#f2c230', '#2f7a4a'][Math.floor(rng() * 5)])); }
    }
  }

  // ---- build the instanced chunks ----
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: .85 });
  crowdMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = kit.TIME;
    sh.vertexShader = 'uniform float uTime;varying float vHead;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float id=float(gl_InstanceID)+instanceMatrix[3].x*.37;vHead=step(1.5,position.y);
      float jump=max(0.,sin(uTime*(4.+mod(id,7.)*.5)+id*2.39));transformed.y+=jump*jump*.08*step(.7,fract(id*.173));`);
    sh.fragmentShader = 'varying float vHead;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.66,.5,.4),vHead);');
  };
  crowdMat.customProgramCacheKey = () => 'lago-crowd';
  const leafMat = (base) => { const m = sway(std(base, .9), .0012, 'lago-cypress'); return m; };
  const vineMat = std('#ffffff', .95);
  vineMat.onBeforeCompile = (s) => {
    s.vertexShader = 'varying vec3 vW;\n' + s.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW=(modelMatrix*instanceMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader = 'varying vec3 vW;\n' + s.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float n=fract(sin(dot(floor(vW.xz*2.1+vW.y*1.3),vec2(12.9898,78.233)))*43758.5453);diffuseColor.rgb*=.7+.55*n;`);
  };
  vineMat.customProgramCacheKey = () => 'lago-vine';
  const { geo: treeGeo, mat: treeMat } = world.treeAssets();
  const flagGeo = new THREE.PlaneGeometry(1.1, 1.6).translate(.55, -.8, 0);
  const parasol = mergeGeometries([new THREE.ConeGeometry(1.5, .6, 10, 1, true).translate(0, 2.3, 0).toNonIndexed(), new THREE.CylinderGeometry(.03, .03, 2.3, 4).translate(0, 1.15, 0).toNonIndexed()]);
  const lampGeo = mergeGeometries([new THREE.CylinderGeometry(.06, .09, 4.2, 6).translate(0, 2.1, 0).toNonIndexed(), new THREE.BoxGeometry(.32, .45, .32).translate(0, 4.35, 0).toNonIndexed()]);
  const benchGeo = mergeGeometries([new THREE.BoxGeometry(.5, .08, 1.8).translate(0, .45, 0).toNonIndexed(), new THREE.BoxGeometry(.08, .45, 1.8).translate(-.22, .7, 0).toNonIndexed(), new THREE.BoxGeometry(.4, .45, .1).translate(0, .22, .8).toNonIndexed(), new THREE.BoxGeometry(.4, .45, .1).translate(0, .22, -.8).toNonIndexed()]);
  const lampMat = std('#2b2f31', .5, .6);
  chunks.build(root, {
    house: { geo: new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0), mat: facade, range: 2200 },
    roof: { geo: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, .5, 0), mat: std('#ffffff', .85), range: 2200 },
    person: { geo: personGeometry(), mat: crowdMat, cast: false, range: 650 },
    flag: { geo: flagGeo, mat: sway(std('#ffffff', .8, 0, { side: THREE.DoubleSide }), .06, 'lago-flag', 'flag'), cast: false, range: 500 },
    parasol: { geo: parasol, mat: std('#ffffff', .8, 0, { side: THREE.DoubleSide }), range: 700 },
    post: { geo: new THREE.CylinderGeometry(.04, .04, 1.1, 5).translate(0, .55, 0), mat: lampMat, cast: false, range: 450 },
    lamp: { geo: lampGeo, mat: lampMat, range: 900 },
    bench: { geo: benchGeo, mat: std('#6b5340', .85), cast: false, range: 400 },
    tree: { geo: treeGeo, mat: treeMat, range: 2600 },
    hull: { geo: hullGeometry(), mat: std('#ffffff', .45, .05), range: 1600 },
    mast: { geo: new THREE.CylinderGeometry(.06, .08, 13, 5).translate(0, 7, 0), mat: std('#d9dcdd', .4, .6), cast: false, range: 1600 },
    merlon: { geo: new THREE.BoxGeometry(1.2, 1.2, .9), mat: std('#bfb08f', .95), range: 1800 },
    wall: { geo: new THREE.BoxGeometry(2.2, 8, 6.2).translate(0, 4, 0), mat: std('#bfb08f', .95), range: 2200 },
    cypress: { geo: cypressGeometry(), mat: leafMat('#ffffff'), range: 3200 },
    olive: { geo: oliveGeometry(), mat: std('#ffffff', .9, 0, { vertexColors: true, flatShading: true }), range: 1800 },
    vine: { geo: new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0), mat: vineMat, range: 1400 }
  });

  // ---- lake life: sailboats, the steamer, balloons; gulls over the marina ----
  const sails = [], free = (x, z, m) => lake.wet(x, z) && !lake.near(x, z, m);
  for (let k = 0; k < 3000 && sails.length < 18; k++) {
    const x = B.cx + (rng() - .2) * 6000, z = B.cz + (rng() - .8) * 6000, r = 120 + rng() * 260; let ok = free(x, z, 60);
    for (let a = 0; ok && a < 6.28; a += .5) ok = free(x + Math.cos(a) * r, z + Math.sin(a) * r, 50);
    if (ok) sails.push({ x, z, r, ph: rng() * 6.28, w: (.4 + rng() * .5) / r * (rng() < .5 ? -1 : 1), sc: .9 + rng() * .6, c: rng() < .8 ? '#f4f2ec' : ['#c8102e', '#1b5aa6', '#f2c230'][Math.floor(rng() * 3)] });
  }
  if (sails.length) {
    const sailGeo = new THREE.BufferGeometry(); sailGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.6, .2, 0, 13, .4, 0, 1.6, -4.2, 0, 1.6, .9, 0, 10, 1.1, 0, 1.6, 3.6], 3)); sailGeo.computeVertexNormals();
    const hull = new THREE.InstancedMesh(hullGeometry(), std('#f2f0ea', .45), sails.length), sail = new THREE.InstancedMesh(sailGeo, std('#ffffff', .7, 0, { side: THREE.DoubleSide }), sails.length);
    const mast = new THREE.InstancedMesh(new THREE.CylinderGeometry(.06, .08, 13, 5).translate(0, 7, 0), std('#d9dcdd', .4, .6), sails.length);
    sails.forEach((b, i) => sail.setColorAt(i, color.set(b.c)));
    for (const m of [hull, sail, mast]) { m.frustumCulled = false; m.castShadow = m !== mast; live.add(m); }
    world.animators.push((now) => {
      sails.forEach((b, i) => {
        const a = b.ph + now * b.w, x = b.x + Math.cos(a) * b.r, z = b.z + Math.sin(a) * b.r, yaw = Math.atan2(-Math.sin(a) * Math.sign(b.w), Math.cos(a) * Math.sign(b.w));
        d.position.set(x, -.55 + Math.sin(now * 1.1 + i) * .05, z); d.rotation.set(Math.sin(now * .9 + i * 2) * .03, yaw, .12 * Math.sign(b.w)); d.scale.setScalar(b.sc); d.updateMatrix();
        hull.setMatrixAt(i, d.matrix); sail.setMatrixAt(i, d.matrix); mast.setMatrixAt(i, d.matrix);
      });
      hull.instanceMatrix.needsUpdate = sail.instanceMatrix.needsUpdate = mast.instanceMatrix.needsUpdate = true;
    });
  }
  {
    // The lake steamer plies from the marina out towards the far shore and back.
    const sh = pose(porto - 420, lake.off(porto - 420) + 90), dir = [sh.nx, sh.nz], g = new THREE.Group(); live.add(g);
    const white = std('#f1efe8', .5), red = std('#a3261f', .6);
    const hs = new THREE.Shape(); hs.moveTo(-4, -18); hs.lineTo(4, -18); hs.lineTo(4.4, 10); hs.quadraticCurveTo(3, 18, 0, 21); hs.quadraticCurveTo(-3, 18, -4.4, 10); hs.lineTo(-4, -18);
    const hg = new THREE.ExtrudeGeometry(hs, { depth: 3, bevelEnabled: false }); hg.rotateX(-Math.PI / 2); add(g, hg, std('#1d2c3a', .5), 0, -1.6, 0);
    box(g, white, 0, 2.6, -2, 7.4, 2.6, 26); box(g, white, 0, 4.7, -4, 6, 1.6, 16); box(g, std('#2a3236', .3, .4), 0, 2.9, -2, 7.5, .9, 25, false);
    add(g, new THREE.CylinderGeometry(.9, 1, 5, 14), red, 0, 7.5, 0); box(g, std('#3c3a36', .7), 0, 5.6, 8, 3, 1.4, 3);
    let last = null, u = 0;
    world.animators.push((now) => {
      const dt = last === null ? 0 : Math.min(.1, now - last); last = now; u += dt * .0016;
      const k = (1 - Math.cos(u * Math.PI * 2)) / 2, dist = 120 + k * 2200, back = Math.sin(u * Math.PI * 2) < 0;
      g.position.set(sh.x + dir[0] * dist, Math.sin(now * .7) * .08, sh.z + dir[1] * dist); g.rotation.y = Math.atan2(dir[0], dir[1]) + (back ? Math.PI : 0);
    });
    // Hot-air balloons drifting over the hills behind the vineyards.
    const env = balloonGeometry(), basket = new THREE.BoxGeometry(1.6, 1.2, 1.6);
    const pals = [['#c8102e', '#f2c230'], ['#1b5aa6', '#f4f2ec'], ['#2f7a4a', '#f2c230', '#c8102e']];
    pals.forEach((pal, i) => {
      const b = new THREE.Group(); add(b, env, new THREE.MeshStandardMaterial({ map: stripeTexture(canvasTexture, pal), roughness: .7 }), 0, 4, 0, false); add(b, basket, std('#6b5340', .9), 0, 0, 0, false); live.add(b);
      const a0 = 2.4 + i * .9, r0 = B.r + 500 + i * 260, h0 = 180 + i * 70;
      world.animators.push((now) => { const a = a0 + now * .002; b.position.set(B.cx + Math.cos(a) * r0, h0 + Math.sin(now * .05 + i) * 25, B.cz + Math.sin(a) * r0); });
    });
    const m0 = pose(porto - 500, lake.off(porto - 500) + 60), m1 = pose(porto + 300, lake.off(porto + 300) + 80);
    world.gullCentres = [[m0.x, m0.z], [m1.x, m1.z], [world.rocca.x, world.rocca.z], [m0.x + m0.nx * 300, m0.z + m0.nz * 300]];
  }
  return { update: (x, z) => chunks.update(x, z) };
}
