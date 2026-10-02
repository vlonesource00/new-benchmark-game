import * as THREE from 'three';
import { RacingLine } from '../engine/sim/ai.js';
import { carSpecFor } from '../engine/sim/car-specs.js';

// Race-worn track detail derived from the circuit itself:
// - braking skid marks laid where the racing line sheds speed, on the line;
// - green painted run-off (astroturf) beyond the kerb on the outside of corners;
// - TV camera towers on the outside of the main corners.
// Everything is static, so the batcher folds it into a handful of draw calls.

const decal = (layer) => ({ polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -2 * layer });

export function buildTrackWear(world) {
  const t = world.track, rng = world.rng, root = world.root;
  const line = new RacingLine(t, carSpecFor('gt'));
  skidMarks(t, line, rng, root);
  astroturf(t, root);
  cameraTowers(world, t, line, rng, root);
}

function skidMarks(t, line, rng, root) {
  const STEP = 1.2, pos = [], col = [], idx = [];
  // Decel per metre along the line, smoothed: where cars brake hardest.
  const n = Math.floor(t.length / STEP), brake = new Float32Array(n), off = new Float32Array(n), hdg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * STEP, a = line.at(s), b = line.at(s + 12);
    brake[i] = Math.max(0, Math.min(1, (a.speed - b.speed) / 7)); off[i] = a.offset;
  }
  const streak = (lat, phase, len, strength) => {
    let base = -1;
    for (let i = 0; i <= n; i++) {
      const k = i % n, s = k * STEP, w = brake[k] * strength * (.55 + .45 * Math.sin(s / len + phase));
      const alpha = Math.min(.85, Math.max(0, w - .1) * .9);
      if (alpha <= 0.01) { base = -1; continue; }
      const p = t.at(s, off[k] + lat), nx = p.nx ?? Math.cos(p.heading), nz = p.nz ?? -Math.sin(p.heading), hw = .11;
      pos.push(p.x - nx * hw, .03, p.z - nz * hw, p.x + nx * hw, .03, p.z + nz * hw);
      col.push(.03, .03, .03, alpha, .03, .03, .03, alpha);
      const v = pos.length / 3 - 2;
      if (base >= 0) idx.push(base, v, base + 1, base + 1, v, v + 1);
      base = v;
    }
  };
  // A handful of cars' worth of marks: two tyres each, scattered about the line.
  for (let c = 0; c < 7; c++) {
    const j = (rng() - .5) * 1.4, ph = rng() * 6.28, len = 4 + rng() * 9, str = .5 + rng() * .8;
    for (const tyre of [-.8, .8]) streak(j + tyre, ph, len, str);
  }
  if (!idx.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); g.setIndex(idx);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: .55, side: THREE.DoubleSide, ...decal(3) }));
  mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.userData.layer = 'wear'; root.add(mesh);
}

function astroturf(t, root) {
  const tex = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 256; const x = c.getContext('2d');
    x.fillStyle = '#3f7a3a'; x.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 1600; i++) { x.fillStyle = `rgba(${Math.random() < .5 ? '20,40,18' : '120,170,100'},${Math.random() * .25})`; x.fillRect(Math.random() * 64, Math.random() * 256, 1, 2 + Math.random() * 3); }
    const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.anisotropy = 8; return tx;
  })();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: .95, side: THREE.DoubleSide, ...decal(1) });
  const inner = t.halfWidth + t.curbWidth, outer = inner + 2.6;
  // Outside of a corner = the side away from its centre; curvature sign gives the turn direction.
  const outside = (s, side) => { const k = t.at(s).curvature; return Math.abs(k) > .007 && Math.sign(k) === -side; };
  for (const side of [-1, 1]) {
    const pos = [], uv = [], idx = [], N = Math.ceil(t.length / 2);
    for (let i = 0; i <= N; i++) {
      const s = i / N * t.length, a = t.at(s, side * inner), b = t.at(s, side * outer);
      pos.push(a.x, .02, a.z, b.x, .02, b.z); uv.push(0, s / 4, 1, s / 4);
      if (i < N && outside(s + 1, side)) { const v = i * 2; if (side > 0) idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); else idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.userData.layer = 'wear'; root.add(m);
  }
}

function cameraTowers(world, t, line, rng, root) {
  const steel = new THREE.MeshStandardMaterial({ color: '#9aa1a3', roughness: .45, metalness: .8 });
  const black = new THREE.MeshStandardMaterial({ color: '#16181a', roughness: .5, metalness: .3 });
  const canopy = new THREE.MeshStandardMaterial({ color: '#2f6fd0', roughness: .7, side: THREE.DoubleSide });
  const shirt = new THREE.MeshStandardMaterial({ color: '#e9a21f', roughness: .8 });
  const part = (g, m, geo, x, y, z) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };
  // One tower per real corner: the slowest point of each braking zone.
  const spots = []; let prev = Infinity, falling = false;
  for (let s = 0; s < t.length; s += 6) {
    const v = line.at(s).speed;
    if (v > prev + .3 && falling && prev < 50) spots.push(s - 6);
    falling = v < prev - .05 || (falling && v <= prev + .3); prev = v;
  }
  let placed = 0;
  for (const s of spots) {
    if (placed >= 8) break;
    const k = t.at(s).curvature, side = -Math.sign(k) || 1, p = t.at(s - 25, side * (t.barrierOffset + 9));
    if (!world.clearOf(p.x, p.z, 2) || (world.isFree && !world.isFree(p.x, p.z, 3))) continue;
    world.occupy?.(p.x, p.z, 3);
    const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = Math.atan2(t.at(s).x - p.x, t.at(s).z - p.z); root.add(g);
    const H = 5.5 + rng() * 2;
    for (const x of [-1, 1]) for (const z of [-1, 1]) part(g, steel, new THREE.CylinderGeometry(.06, .06, H, 6), x * .9, H / 2, z * .9);
    for (let y = 1.4; y < H; y += 1.4) for (const r of [0, 1]) { const b = part(g, steel, new THREE.BoxGeometry(1.8, .05, .05), 0, y, 0); b.rotation.y = r * Math.PI / 2; b.position.set(r ? .9 : 0, y, r ? 0 : .9); const b2 = b.clone(); b2.position.set(r ? -.9 : 0, y, r ? 0 : -.9); g.add(b2); }
    part(g, steel, new THREE.BoxGeometry(2.2, .12, 2.2), 0, H, 0);
    for (const z of [-1.05, 1.05]) part(g, steel, new THREE.BoxGeometry(2.2, .05, .05), 0, H + 1, z);
    for (const x of [-1.05, 1.05]) part(g, steel, new THREE.BoxGeometry(.05, .05, 2.2), x, H + 1, 0);
    // Camera on a tripod head, its operator and a parasol.
    part(g, black, new THREE.CylinderGeometry(.04, .04, 1.1, 5), 0, H + .6, .3);
    part(g, black, new THREE.BoxGeometry(.32, .34, .7), 0, H + 1.3, .45);
    part(g, black, new THREE.CylinderGeometry(.12, .1, .5, 10), 0, H + 1.32, .95).rotation.x = Math.PI / 2;
    part(g, shirt, new THREE.BoxGeometry(.42, .62, .26), 0, H + .95, -.2);
    part(g, new THREE.MeshStandardMaterial({ color: '#c99b7a', roughness: .8 }), new THREE.SphereGeometry(.13, 10, 8), 0, H + 1.4, -.2);
    part(g, black, new THREE.BoxGeometry(.38, .8, .22), 0, H + .4, -.2);
    part(g, steel, new THREE.CylinderGeometry(.02, .02, 2.2, 5), -.7, H + 1.1, -.7);
    part(g, canopy, new THREE.ConeGeometry(1.3, .45, 10, 1, true), -.7, H + 2.2, -.7);
    placed++;
  }
}
