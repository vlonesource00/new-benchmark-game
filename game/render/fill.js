import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Landscape fill around a circuit: car parks, campsites, fan zones, forest
// clumps, fields and a ring road with traffic. Everything is instanced and
// placed once at build time; only the traffic moves. Placement keeps a margin
// from the track and asks the world's occupancy grid so nothing overlaps the
// paddock, the stands, the city or each other.

const CAR_COLORS = ['#e9e9e6', '#e9e9e6', '#1c1d1f', '#1c1d1f', '#8d9396', '#b9bec0', '#5b6266', '#24395e', '#7a1f1f', '#2f4a3a', '#c7b48a', '#3d5f8c'];
const FIELD_COLORS = {
  solenne: ['#b89a4a', '#c9ab55', '#7f8f45', '#5f7a3c', '#8a6a48', '#8f7bb0', '#9c88bd'],
  'harbor-ring': ['#6f8a4a', '#87984f', '#5f7a3c'],
  desert: ['#b98a5c', '#a87a50', '#c49a6a'],
  alpine: ['#5d6f52', '#6a7a5a']
};
const PER_THEME = {
  'harbor-ring': { lots: 6, camps: 1, fan: 1, clumps: 46, fields: 4, road: true, offices: 26 },
  solenne: { lots: 4, camps: 2, fan: 1, clumps: 60, fields: 26, road: true, offices: 0 },
  desert: { lots: 4, camps: 2, fan: 1, clumps: 0, fields: 8, road: true, offices: 0 },
  alpine: { lots: 3, camps: 1, fan: 1, clumps: 0, fields: 6, road: true, offices: 0 },
  // The Eifel brings its own forest, villages and fan camps (render/eifel.js).
  nurburgring: { lots: 6, camps: 3, fan: 1, clumps: 0, fields: 0, road: false, offices: 0 }
};

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
// Flat ground piece: a plane lying on the ground with UVs in metres / tile.
function groundPlane(w, d, tileW, tileD) {
  const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / tileW, uv.getY(i) * d / tileD);
  return g;
}
// One low-poly car shape; vertex colours keep the glass dark under the instance colour.
function carGeometry(len = 4.4, width = 1.85, van = false) {
  const tint = (g, v) => { const n = g.attributes.position.count, c = new Float32Array(n * 3).fill(v); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g.toNonIndexed(); };
  const body = new THREE.BoxGeometry(len, van ? 2.1 : .78, width).translate(0, van ? 1.35 : .62, 0);
  const cabin = new THREE.BoxGeometry(van ? len * .22 : len * .5, van ? .9 : .62, width * .9).translate(van ? len * .36 : -len * .06, van ? 1.25 : 1.3, 0);
  const tyres = new THREE.BoxGeometry(len * .78, .5, width * 1.02).translate(0, .3, 0);
  return mergeGeometries([tint(body, 1), tint(cabin, .14), tint(tyres, .06)]);
}

export function buildFill(world) {
  const cfg = PER_THEME[world.track.id] ?? PER_THEME['harbor-ring'];
  const t = world.track, rng = world.rng, d = world.dummy, b = world.bounds, th = world.theme;
  const root = world.root, live = world.live, out = { glows: [] };
  const margin = t.barrierOffset + 46;
  const landOk = (x, z) => !th.harbor || x < 520;
  // A circle is free when it clears the track by `margin` and the occupancy grid.
  const fits = (x, z, r, m = margin) => landOk(x, z) && Math.abs(t.nearest(x, z).lateral) > m + r && world.isFree(x, z, r);
  // Random free spot inside the circuit's bounding box grown by `reach` (infield included).
  const spot = (r, reach, m) => {
    for (let k = 0; k < 400; k++) {
      const x = b.x0 - reach + rng() * (b.x1 - b.x0 + 2 * reach), z = b.z0 - reach + rng() * (b.z1 - b.z0 + 2 * reach);
      if (fits(x, z, r, m)) return { x, z, rot: Math.round(rng() * 3) * Math.PI / 2 + (rng() - .5) * .3 };
    }
    return null;
  };
  // Rotate the item to run parallel to the nearest piece of track: looks planned.
  const align = (x, z) => t.at(t.nearest(x, z).s).heading;

  // ---- car parks ----
  const module = 17.4, bay = 2.6;
  const lotMap = canvasTexture(64, 432, (c, w, h) => {
    c.fillStyle = '#3a3c3d'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(${i % 2 ? 255 : 0},${i % 2 ? 255 : 0},${i % 2 ? 255 : 0},${Math.random() * .05})`; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    c.fillStyle = '#d9d8cf'; const px = h / module;
    c.fillRect(0, 0, 3, 5.2 * px); c.fillRect(0, h - 5.2 * px, 3, 5.2 * px);
  });
  const lotMat = new THREE.MeshStandardMaterial({ map: lotMap, roughness: .95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const cars = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .35, metalness: .5 }), 1600); cars.count = 0;
  const color = new THREE.Color();
  const parkCar = (mesh, x, z, rot) => {
    if (mesh.count >= mesh.instanceMatrix.count) return;
    d.position.set(x, 0, z); d.rotation.set(0, rot, 0); d.scale.setScalar(.92 + rng() * .16); d.updateMatrix();
    mesh.setMatrixAt(mesh.count, d.matrix); mesh.setColorAt(mesh.count++, color.set(CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)]).multiplyScalar(.85 + rng() * .3));
  };
  const lampSpots = [];
  for (let i = 0; i < cfg.lots; i++) {
    const w = 60 + Math.floor(rng() * 4) * 13, dd = module * (2 + Math.floor(rng() * 3)), r = Math.hypot(w, dd) / 2 + 4;
    const p = spot(r, 140, t.barrierOffset + 30); if (!p) continue;
    const rot = align(p.x, p.z), lot = new THREE.Group(); lot.position.set(p.x, .02, p.z); lot.rotation.y = rot; root.add(lot);
    const m = new THREE.Mesh(groundPlane(w, dd, bay, module), lotMat); m.receiveShadow = true; lot.add(m);
    world.occupy(p.x, p.z, r);
    lot.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    for (let row = 0; row < dd / module; row++) for (const zc of [2.6, module - 2.6]) for (let k = 0; k < Math.floor(w / bay); k++) {
      if (rng() > .78) continue;
      v.set(-w / 2 + (k + .5) * bay, 0, -dd / 2 + row * module + zc).applyMatrix4(lot.matrixWorld);
      parkCar(cars, v.x, v.z, rot + Math.PI / 2 + (zc > module / 2 ? Math.PI : 0) + (rng() - .5) * .06);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { v.set(sx * (w / 2 - 1), 0, sz * (dd / 2 - 1)).applyMatrix4(lot.matrixWorld); lampSpots.push([v.x, v.z]); }
  }
  cars.castShadow = true; cars.receiveShadow = true; root.add(cars);

  // ---- campsites: dome tents and camper vans in loose rows ----
  const dome = new THREE.SphereGeometry(1.4, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2); dome.scale(1.2, .9, 1);
  const tents = new THREE.InstancedMesh(dome, new THREE.MeshStandardMaterial({ roughness: .8 }), 900); tents.count = 0;
  const campers = new THREE.InstancedMesh(carGeometry(6.4, 2.3, true), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .5, metalness: .2 }), 260); campers.count = 0;
  const tentColors = ['#e8483a', '#f2c230', '#2f6db0', '#3f8f4a', '#f08a2c', '#7a4fb0', '#e9e6dc'];
  for (let i = 0; i < cfg.camps; i++) {
    const p = spot(60, 260); if (!p) continue;
    world.occupy(p.x, p.z, 60);
    for (let k = 0; k < 340; k++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 56, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!landOk(x, z) || Math.abs(t.nearest(x, z).lateral) < margin) continue;
      if (rng() < .22) { if (campers.count < 260) { d.position.set(x, 0, z); d.rotation.set(0, p.rot + (rng() - .5) * .5, 0); d.scale.setScalar(1); d.updateMatrix(); campers.setMatrixAt(campers.count, d.matrix); campers.setColorAt(campers.count++, color.set(rng() < .7 ? '#ecebe6' : '#d9c7a0')); } }
      else if (tents.count < 900) { d.position.set(x, 0, z); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(.8 + rng() * .5); d.updateMatrix(); tents.setMatrixAt(tents.count, d.matrix); tents.setColorAt(tents.count++, color.set(tentColors[Math.floor(rng() * tentColors.length)])); }
    }
    lampSpots.push([p.x, p.z]);
  }
  tents.castShadow = campers.castShadow = true; tents.receiveShadow = campers.receiveShadow = true; root.add(tents, campers);

  // ---- fan zone: marquees around a plaza ----
  const marquee = mergeGeometries([new THREE.BoxGeometry(10, 3, 10).translate(0, 1.5, 0), new THREE.ConeGeometry(7.4, 3.2, 4).rotateY(Math.PI / 4).translate(0, 4.6, 0)]);
  const tentsBig = new THREE.InstancedMesh(marquee, new THREE.MeshStandardMaterial({ roughness: .7 }), 60); tentsBig.count = 0;
  for (let i = 0; i < cfg.fan; i++) {
    const p = spot(45, 160); if (!p) continue;
    world.occupy(p.x, p.z, 45);
    const rot = align(p.x, p.z);
    for (let k = 0; k < 18; k++) {
      const a = k / 18 * Math.PI * 2, x = p.x + Math.cos(a) * 32, z = p.z + Math.sin(a) * 32;
      d.position.set(x, 0, z); d.rotation.set(0, rot, 0); d.scale.setScalar(k % 3 ? 1 : 1.4); d.updateMatrix(); tentsBig.setMatrixAt(tentsBig.count, d.matrix);
      tentsBig.setColorAt(tentsBig.count++, color.set(k % 4 === 0 ? '#e8483a' : k % 4 === 2 ? '#1b2a6b' : '#f2f1ea'));
    }
    const plaza = new THREE.Mesh(groundPlane(56, 56, 4, 4), new THREE.MeshStandardMaterial({ color: '#c9c3b4', roughness: .95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    plaza.position.set(p.x, .02, p.z); plaza.rotation.y = rot; plaza.receiveShadow = true; root.add(plaza);
    // Crowd milling around the plaza.
    const person = mergeGeometries([new THREE.CapsuleGeometry(.2, .9, 2, 5).translate(0, .65, 0), new THREE.SphereGeometry(.13, 5, 4).translate(0, 1.35, 0)]);
    const crowd = new THREE.InstancedMesh(person, new THREE.MeshStandardMaterial({ roughness: .85 }), 260);
    for (let k = 0; k < 260; k++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 26; d.position.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(.9 + rng() * .2); d.updateMatrix();
      crowd.setMatrixAt(k, d.matrix); crowd.setColorAt(k, color.set(tentColors[Math.floor(rng() * tentColors.length)]).multiplyScalar(.5 + rng() * .5));
    }
    root.add(crowd);
    lampSpots.push([p.x + 20, p.z], [p.x - 20, p.z], [p.x, p.z + 20], [p.x, p.z - 20]);
  }
  tentsBig.castShadow = tentsBig.receiveShadow = true; root.add(tentsBig);

  // ---- harbor: low-rise offices and warehouses between the circuit and the city ----
  if (cfg.offices && world.cityBuilding) {
    for (let i = 0; i < cfg.offices; i++) {
      const w = 24 + rng() * 30, dd = 20 + rng() * 26, p = spot(Math.hypot(w, dd) / 2 + 6, 320); if (!p) continue;
      world.cityBuilding(p.x, p.z, w, dd, 9 + rng() * 22, align(p.x, p.z));
    }
  }

  // ---- fields: patchwork of crops and meadows, each a tinted strip texture ----
  if (cfg.fields) {
    const rows = canvasTexture(64, 64, (c, w, h) => { for (let y = 0; y < h; y += 4) { c.fillStyle = y % 8 ? '#e6e6e6' : '#ffffff'; c.fillRect(0, y, w, 4); } for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(0,0,0,${Math.random() * .08})`; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); } });
    const plane = new THREE.PlaneGeometry(1, 1); plane.rotateX(-Math.PI / 2);
    const fields = new THREE.InstancedMesh(plane, new THREE.MeshStandardMaterial({ map: rows, roughness: 1, polygonOffset: true, polygonOffsetFactor: -.5, polygonOffsetUnits: -1 }), cfg.fields); fields.count = 0;
    const palette = FIELD_COLORS[t.id] ?? FIELD_COLORS['harbor-ring'];
    for (let i = 0; i < cfg.fields; i++) {
      const w = 90 + rng() * 160, dd = 70 + rng() * 140, p = spot(Math.hypot(w, dd) / 2, 900); if (!p) continue;
      world.occupy(p.x, p.z, Math.min(w, dd) / 2);
      d.position.set(p.x, -.035, p.z); d.rotation.set(0, p.rot, 0); d.scale.set(w, 1, dd); d.updateMatrix(); fields.setMatrixAt(fields.count, d.matrix);
      fields.setColorAt(fields.count++, color.set(palette[Math.floor(rng() * palette.length)]).multiplyScalar(.9 + rng() * .2));
    }
    // Strip texture repeats with the instance scale: rows stay about 1.5 m apart.
    fields.material.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv=uv*vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[2].xyz))/vec2(6.,6.);\n#endif'); };
    fields.material.customProgramCacheKey = () => 'fields';
    fields.receiveShadow = true; root.add(fields);
  }

  // ---- forest clumps: dense groups of the circuit's trees with undergrowth ----
  if (cfg.clumps && world.treeGeo) {
    const trees = new THREE.InstancedMesh(world.treeGeo, world.treeMat, cfg.clumps * 34); trees.count = 0;
    const bush = new THREE.IcosahedronGeometry(1, 0); bush.translate(0, .55, 0);
    const bushes = new THREE.InstancedMesh(bush, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), cfg.clumps * 50); bushes.count = 0;
    for (let i = 0; i < cfg.clumps; i++) {
      const p = spot(30, 1100, t.barrierOffset + 36); if (!p) continue;
      const spread = 18 + rng() * 30;
      for (let k = 0; k < 34 && trees.count < trees.instanceMatrix.count; k++) {
        const a = rng() * Math.PI * 2, r = Math.abs(rng() + rng() - 1) * spread, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (!landOk(x, z) || Math.abs(t.nearest(x, z).lateral) < t.barrierOffset + 30) continue;
        d.position.set(x, -.05, z); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(.7 + rng() * 1.1); d.updateMatrix();
        trees.setMatrixAt(trees.count, d.matrix); trees.setColorAt(trees.count++, color.setHSL(.18 + rng() * .07, .18, .62 + rng() * .25));
      }
      for (let k = 0; k < 50 && bushes.count < bushes.instanceMatrix.count; k++) {
        const a = rng() * Math.PI * 2, r = spread * (.6 + rng() * .7), x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (!landOk(x, z) || Math.abs(t.nearest(x, z).lateral) < t.barrierOffset + 24) continue;
        const s = .8 + rng() * 1.8; d.position.set(x, -.1, z); d.rotation.set(rng(), rng() * 6.28, rng()); d.scale.set(s * (1 + rng() * .6), s * (.6 + rng() * .4), s); d.updateMatrix();
        bushes.setMatrixAt(bushes.count, d.matrix); bushes.setColorAt(bushes.count++, color.setHSL(.2 + rng() * .08, .35, .2 + rng() * .1));
      }
      world.occupy(p.x, p.z, spread * .8);
    }
    trees.castShadow = bushes.castShadow = true; trees.receiveShadow = bushes.receiveShadow = true; root.add(trees, bushes);
  }

  // ---- ring road round the circuit with traffic and lamps ----
  if (cfg.road) {
    const e = 150, east = th.harbor ? 500 : b.x1 + e;
    const corners = [[b.x0 - e, b.z0 - e], [east, b.z0 - e], [east, b.z1 + e], [b.x0 - e, b.z1 + e]];
    const roadMap = canvasTexture(64, 256, (c, w, h) => {
      c.fillStyle = '#404244'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 600; i++) { c.fillStyle = `rgba(255,255,255,${Math.random() * .05})`; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
      c.fillStyle = '#e6e4da'; c.fillRect(w / 2 - 1, 0, 2, h * .45); c.fillStyle = '#d8d6cc'; c.fillRect(2, 0, 2, h); c.fillRect(w - 4, 0, 2, h);
    });
    const roadMat = new THREE.MeshStandardMaterial({ map: roadMap, roughness: .9, polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 });
    const segs = [];
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = corners[i], [x1, z1] = corners[(i + 1) % 4], len = Math.hypot(x1 - x0, z1 - z0);
      const g = groundPlane(8, len + 8, 8, 12), m = new THREE.Mesh(g, roadMat); m.position.set((x0 + x1) / 2, .015, (z0 + z1) / 2); m.rotation.y = Math.atan2(x1 - x0, z1 - z0); m.receiveShadow = true; root.add(m);
      segs.push({ x0, z0, x1, z1, len });
      for (let u = 20; u < len; u += 45) { const k = u / len; lampSpots.push([x0 + (x1 - x0) * k + Math.cos(m.rotation.y) * 6, z0 + (z1 - z0) * k - Math.sin(m.rotation.y) * 6]); }
    }
    const total = segs.reduce((a, s) => a + s.len, 0);
    const at = (u, lane) => {
      u = ((u % total) + total) % total;
      for (const s of segs) { if (u <= s.len) { const k = u / s.len, nx = (s.z1 - s.z0) / s.len, nz = -(s.x1 - s.x0) / s.len; return [s.x0 + (s.x1 - s.x0) * k + nx * lane, s.z0 + (s.z1 - s.z0) * k + nz * lane, Math.atan2(s.x1 - s.x0, s.z1 - s.z0)]; } u -= s.len; }
      return [0, 0, 0];
    };
    const traffic = new THREE.InstancedMesh(carGeometry(), cars.material, 40); traffic.frustumCulled = false;
    const movers = Array.from({ length: 40 }, (_, i) => ({ u: rng() * total, v: (11 + rng() * 6) * (i % 2 ? 1 : -1), lane: i % 2 ? 2 : -2 }));
    movers.forEach((m, i) => traffic.setColorAt(i, color.set(CAR_COLORS[i % CAR_COLORS.length])));
    traffic.castShadow = true; live.add(traffic);
    let last = null;
    world.animators.push((now) => {
      const dt = last === null ? 0 : Math.min(.1, now - last); last = now;
      movers.forEach((m, i) => {
        m.u += m.v * dt; const [x, z, h] = at(m.u, m.lane);
        d.position.set(x, 0, z); d.rotation.set(0, h + (m.v > 0 ? -Math.PI / 2 : Math.PI / 2), 0); d.scale.setScalar(1); d.updateMatrix(); traffic.setMatrixAt(i, d.matrix);
      });
      traffic.instanceMatrix.needsUpdate = true;
    });
  }

  // ---- lamps: car parks, campsites, plaza and road; heads glow after dusk ----
  if (lampSpots.length) {
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(.08, .12, 8, 6).translate(0, 4, 0), new THREE.MeshStandardMaterial({ color: '#5d6466', roughness: .5, metalness: .7 }), lampSpots.length);
    const headMat = new THREE.MeshStandardMaterial({ color: '#d8dde0', emissive: '#ffd9a0', emissiveIntensity: 0, roughness: .4 });
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(.9, .2, .4).translate(0, 8, 0), headMat, lampSpots.length);
    lampSpots.forEach(([x, z], i) => { d.position.set(x, 0, z); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(1); d.updateMatrix(); poles.setMatrixAt(i, d.matrix); heads.setMatrixAt(i, d.matrix); });
    poles.castShadow = true; root.add(poles, heads);
    out.glows.push({ material: headMat, day: 0, night: 9 });
    // Warm light pools on the ground under each lamp, additive and only at night.
    const pool = new THREE.MeshBasicMaterial({ map: canvasTexture(128, 128, (c, w) => { const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); g.addColorStop(0, 'rgba(255,214,150,.55)'); g.addColorStop(1, 'rgba(255,214,150,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); }), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    const pools = new THREE.InstancedMesh(groundPlane(16, 16, 16, 16), pool, lampSpots.length);
    lampSpots.forEach(([x, z], i) => { d.position.set(x, .05, z); d.rotation.set(0, 0, 0); d.updateMatrix(); pools.setMatrixAt(i, d.matrix); });
    root.add(pools);
    out.glows.push({ material: pool, day: 0, night: 1, opacity: true });
  }
  return out;
}
