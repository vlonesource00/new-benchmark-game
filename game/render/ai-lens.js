// 3D half of the AI debugger: the class racing line ahead of the focused car,
// drawn as a speed curtain (height and colour = planned speed, as in the
// sandbox's Architecture Lens), the car's predicted pose a second ahead and
// the controller's aim point when its bridge exposes one.
import * as THREE from 'three';

const AHEAD = 260, STEP = 2.5, N = Math.ceil(AHEAD / STEP), V = .05; // metres of height per m/s
const STOPS = ['#2b50ff', '#00d9ff', '#6dff8a', '#ffd23f', '#ff4fd8'].map((c) => new THREE.Color(c));
const tmp = new THREE.Color();
function speedColor(v) {
  const t = Math.max(0, Math.min(.9999, (v - 15) / 70)) * (STOPS.length - 1), i = Math.floor(t);
  return tmp.copy(STOPS[i]).lerp(STOPS[i + 1], t - i);
}

export class AiLens {
  constructor(scene) {
    const buffer = (n) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
      return g;
    };
    const mat = (Kind) => new Kind({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.root = new THREE.Group(); this.root.visible = false; this.root.renderOrder = 6;
    this.tris = new THREE.Mesh(buffer(N * 12 + 96), mat(THREE.MeshBasicMaterial));
    this.lines = new THREE.LineSegments(buffer(N * 4 + 256), mat(THREE.LineBasicMaterial));
    for (const o of [this.tris, this.lines]) { o.frustumCulled = false; o.renderOrder = 6; this.root.add(o); }
    scene.add(this.root);
  }

  update(race, focusId, on, bridge) {
    this.root.visible = on && Boolean(race);
    if (!this.root.visible) return;
    const car = race.cars[focusId];
    if (!car) { this.root.visible = false; return; }
    const line = race.lineFor(car), y0 = (car.y ?? 0) + .06;
    const T = this.tris.geometry.attributes, L = this.lines.geometry.attributes;
    let nt = 0, nl = 0;
    const tv = (x, y, z, c, a) => { T.position.array.set([x, y, z], nt * 3); T.color.array.set([c.r, c.g, c.b, a], nt * 4); nt++; };
    const lv = (x, y, z, c, a) => { L.position.array.set([x, y, z], nl * 3); L.color.array.set([c.r, c.g, c.b, a], nl * 4); nl++; };

    // Speed curtain along the racing line, fading out with distance.
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const p = line.at(car.s + 4 + i * STEP), h = p.speed * V, fade = 1 - i / N;
      const c = speedColor(p.speed).clone(), cur = { x: p.x, z: p.z, h, c, a: .55 * fade };
      if (prev) {
        tv(prev.x, y0, prev.z, prev.c, 0); tv(prev.x, y0 + prev.h, prev.z, prev.c, prev.a * .6); tv(cur.x, y0, cur.z, c, 0);
        tv(prev.x, y0 + prev.h, prev.z, prev.c, prev.a * .6); tv(cur.x, y0 + h, cur.z, c, cur.a * .6); tv(cur.x, y0, cur.z, c, 0);
        lv(prev.x, y0 + prev.h, prev.z, prev.c, prev.a * 1.6); lv(cur.x, y0 + h, cur.z, c, cur.a * 1.6);
        lv(prev.x, y0, prev.z, prev.c, prev.a); lv(cur.x, y0, cur.z, c, cur.a);
      }
      prev = cur;
    }

    // Predicted pose one second ahead (constant yaw rate), and the aim point.
    const ring = (x, z, r, c, a) => {
      for (let i = 0; i < 24; i++) {
        const t0 = i / 24 * Math.PI * 2, t1 = (i + 1) / 24 * Math.PI * 2;
        lv(x + Math.sin(t0) * r, y0 + .1, z + Math.cos(t0) * r, c, a); lv(x + Math.sin(t1) * r, y0 + .1, z + Math.cos(t1) * r, c, a);
      }
    };
    let px = car.x, pz = car.z, yaw = car.yaw;
    const white = new THREE.Color('#ffffff'), gold = new THREE.Color('#ffd166');
    for (let k = 0; k < 10; k++) {
      yaw += car.yawRate * .1;
      const nx = px + Math.sin(yaw) * car.speed * .1, nz = pz + Math.cos(yaw) * car.speed * .1;
      lv(px, y0 + .3, pz, white, .2 + k * .07); lv(nx, y0 + .3, nz, white, .27 + k * .07);
      px = nx; pz = nz;
    }
    ring(px, pz, 1.2, white, .9);
    let aim = null;
    try { aim = bridge?.visualDebug?.()?.trackingPoint ?? null; } catch { aim = null; }
    if (aim && Number.isFinite(aim.x)) {
      ring(aim.x, aim.z, .9, gold, 1); lv(car.x, y0 + .5, car.z, gold, .2); lv(aim.x, y0 + .5, aim.z, gold, .9);
    }

    for (const [o, n] of [[this.tris, nt], [this.lines, nl]]) {
      o.geometry.setDrawRange(0, n);
      o.geometry.attributes.position.needsUpdate = true; o.geometry.attributes.color.needsUpdate = true;
    }
  }
  dispose() { this.root.removeFromParent(); for (const o of [this.tris, this.lines]) { o.geometry.dispose(); o.material.dispose(); } }
}
