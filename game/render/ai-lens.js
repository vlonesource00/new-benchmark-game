// 3D half of the AI debugger. Drawn around the focused car, from the
// architecture lens model (ui/lens-model.js), so each AI shows what it reports:
//  · intent tag floating above the car (architecture, intent, what it is doing)
//  · the class racing line as a speed curtain (height and colour = planned speed)
//  · the AI's own planned path as a ribbon in its colour, when it reports one
//  · the options it scored (lanes, transfers) fanned out ahead, the chosen one bright
//  · a tether to the rival it is working on: red attack, amber follow, blue defend
//    (dashed when the AI did not say and the focus is inferred from the field)
//  · chevrons on the side it is going for, a cross over a car it is blocked by
//  · a pedal aura under the car, the predicted pose a second ahead and the aim point
//  · when the AI reports extras: where it expects each nearby rival to be (a car-width forecast ribbon),
//    the car-width footprint of its own path, and a marker where it expects contact
import * as THREE from 'three';
import { toneColor } from '../ui/lens-model.js';

const AHEAD = 260, STEP = 2.5, N = Math.ceil(AHEAD / STEP), V = .05; // metres of height per m/s
const STOPS = ['#2b50ff', '#00d9ff', '#6dff8a', '#ffd23f', '#ff4fd8'].map((c) => new THREE.Color(c));
const MAX_T = 9000, MAX_L = 6000;
const tmp = new THREE.Color();
function speedColor(v) {
  const t = Math.max(0, Math.min(.9999, (v - 15) / 70)) * (STOPS.length - 1), i = Math.floor(t);
  return tmp.copy(STOPS[i]).lerp(STOPS[i + 1], t - i);
}
const col = (hex) => new THREE.Color(hex);
const WHITE = col('#ffffff'), GOLD = col('#ffd166'), GREEN = col('#3ddc84'), RED = col('#ff4d4d');
const FOCUS_WORD = { attack: 'ATTACK', follow: 'CHASE', defend: 'COVER', alongside: 'SIDE BY SIDE' };

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
    this.tris = new THREE.Mesh(buffer(MAX_T), mat(THREE.MeshBasicMaterial));
    this.lines = new THREE.LineSegments(buffer(MAX_L), mat(THREE.LineBasicMaterial));
    for (const o of [this.tris, this.lines]) { o.frustumCulled = false; o.renderOrder = 6; this.root.add(o); }
    // Intent tag: a canvas sprite redrawn only when its text changes.
    this.tagCanvas = document.createElement('canvas'); this.tagCanvas.width = 512; this.tagCanvas.height = 176;
    this.tagTex = new THREE.CanvasTexture(this.tagCanvas); this.tagTex.colorSpace = THREE.SRGBColorSpace;
    // Fixed screen size (sizeAttenuation off) and outside tone mapping, so it reads the same near or far.
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthTest: false, depthWrite: false, fog: false, sizeAttenuation: false, toneMapped: false }));
    this.tag.scale.set(.34, .116875, 1); this.tag.renderOrder = 7; this.tag.center.set(.5, 0); this.tag.frustumCulled = false;
    this.root.add(this.tag);
    this.tagKey = '';
    scene.add(this.root);
  }

  drawTag(m, name, focusText) {
    const key = `${name}|${m.intent}|${m.sub}|${m.tone}|${focusText}`;
    if (key === this.tagKey) return;
    this.tagKey = key;
    const g = this.tagCanvas.getContext('2d'), W = 512, tone = toneColor(m.tone), theme = m.theme?.color ?? '#fff';
    g.clearRect(0, 0, W, 176);
    const box = () => { g.beginPath(); g.roundRect ? g.roundRect(8, 8, W - 16, 124, 14) : g.rect(8, 8, W - 16, 124); };
    g.fillStyle = 'rgba(8,10,14,.8)'; box(); g.fill();
    g.strokeStyle = tone; g.lineWidth = 4; box(); g.stroke();
    g.fillStyle = theme; g.fillRect(10, 10, 10, 120);
    // Pointer down to the car.
    g.fillStyle = tone; g.beginPath(); g.moveTo(W / 2 - 16, 132); g.lineTo(W / 2 + 16, 132); g.lineTo(W / 2, 168); g.fill();
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.font = '700 26px "JetBrains Mono", monospace'; g.fillStyle = theme; g.fillText(name, 34, 34);
    g.font = 'italic 900 44px system-ui, sans-serif'; g.fillStyle = tone; g.fillText(String(m.intent ?? '—').toUpperCase().slice(0, 18), 32, 76);
    g.font = '600 20px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.82)';
    g.fillText(String(focusText || m.sub || '').slice(0, 40), 34, 113);
    this.tagTex.needsUpdate = true;
  }

  update(race, focusId, on, bridge, model = null, name = '') {
    this.root.visible = on && Boolean(race);
    if (!this.root.visible) return;
    const car = race.cars[focusId];
    if (!car) { this.root.visible = false; return; }
    const line = race.lineFor(car), y0 = (car.y ?? 0) + .06;
    const T = this.tris.geometry.attributes, L = this.lines.geometry.attributes;
    let nt = 0, nl = 0;
    const tv = (x, y, z, c, a) => { if (nt >= MAX_T) return; T.position.array.set([x, y, z], nt * 3); T.color.array.set([c.r, c.g, c.b, a], nt * 4); nt++; };
    const lv = (x, y, z, c, a) => { if (nl >= MAX_L) return; L.position.array.set([x, y, z], nl * 3); L.color.array.set([c.r, c.g, c.b, a], nl * 4); nl++; };
    const seg = (a, b, c, al, bl = al) => { lv(a.x, a.y, a.z, c, al); lv(b.x, b.y, b.z, c, bl); };
    const ring = (x, z, r, c, a, y = y0 + .1, n = 24) => {
      for (let i = 0; i < n; i++) {
        const t0 = i / n * Math.PI * 2, t1 = (i + 1) / n * Math.PI * 2;
        lv(x + Math.sin(t0) * r, y, z + Math.cos(t0) * r, c, a); lv(x + Math.sin(t1) * r, y, z + Math.cos(t1) * r, c, a);
      }
    };
    // Soft annulus on the ground, opaque at r0 fading out by r1.
    const disc = (x, z, r0, r1, c, a, y = y0 + .04, n = 32) => {
      for (let i = 0; i < n; i++) {
        const t0 = i / n * Math.PI * 2, t1 = (i + 1) / n * Math.PI * 2, s0 = Math.sin(t0), c0 = Math.cos(t0), s1 = Math.sin(t1), c1 = Math.cos(t1);
        tv(x + s0 * r0, y, z + c0 * r0, c, a); tv(x + s0 * r1, y, z + c0 * r1, c, 0); tv(x + s1 * r0, y, z + c1 * r0, c, a);
        tv(x + s1 * r0, y, z + c1 * r0, c, a); tv(x + s0 * r1, y, z + c0 * r1, c, 0); tv(x + s1 * r1, y, z + c1 * r1, c, 0);
      }
    };
    // Flat ribbon along a polyline; colour and alpha per point.
    const ribbon = (pts, w, colorAt, alphaAt, y) => {
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
        const ca = colorAt(a).clone(), cb = colorAt(b).clone(), aa = alphaAt(k - 1), ab = alphaAt(k);
        tv(a.x - nx, y, a.z - nz, ca, aa); tv(a.x + nx, y, a.z + nz, ca, aa); tv(b.x - nx, y, b.z - nz, cb, ab);
        tv(a.x + nx, y, a.z + nz, ca, aa); tv(b.x + nx, y, b.z + nz, cb, ab); tv(b.x - nx, y, b.z - nz, cb, ab);
      }
    };
    const m = model;

    // Speed curtain along the class racing line, fading with distance (softer when the AI draws its own plan).
    const soft = m?.path ? .4 : 1;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const p = line.at(car.s + 4 + i * STEP), h = p.speed * V, fade = 1 - i / N;
      const c = speedColor(p.speed).clone(), cur = { x: p.x, z: p.z, h, c, a: .55 * fade * soft };
      if (prev) {
        tv(prev.x, y0, prev.z, prev.c, 0); tv(prev.x, y0 + prev.h, prev.z, prev.c, prev.a * .6); tv(cur.x, y0, cur.z, c, 0);
        tv(prev.x, y0 + prev.h, prev.z, prev.c, prev.a * .6); tv(cur.x, y0 + h, cur.z, c, cur.a * .6); tv(cur.x, y0, cur.z, c, 0);
        lv(prev.x, y0 + prev.h, prev.z, prev.c, prev.a * 1.6); lv(cur.x, y0 + h, cur.z, c, cur.a * 1.6);
      }
      prev = cur;
    }

    if (m) {
      const theme = col(m.theme?.color ?? '#ffffff'), tone = col(toneColor(m.tone));
      // Options the AI weighed: fanned out ahead, alpha by score; the chosen one is the path below.
      const withPts = (m.cands ?? []).filter((c) => Array.isArray(c.points) && c.points.length > 1 && Number.isFinite(c.score));
      if (withPts.length) {
        const sc = withPts.map((c) => c.score), lo = Math.min(...sc), hi = Math.max(...sc);
        for (const c of withPts) {
          if (c.chosen && m.path) continue;
          const q = hi > lo ? (c.score - lo) / (hi - lo) : 1, n = c.points.length;
          ribbon(c.points, .25, () => theme, (k) => (.05 + .3 * q) * (1 - k / n), y0 + .12);
          const e = c.points[n - 1]; ring(e.x, e.z, .45, theme, .2 + .6 * q, y0 + .15, 10);
        }
      }
      // The AI's own planned path, coloured by its planned speed when it gives one.
      if (m.path) {
        const n = m.path.length;
        ribbon(m.path, .7, (p) => (Number.isFinite(p.v) ? speedColor(p.v) : theme), (k) => .45 * (1 - k / n) + .05, y0 + .2);
        for (let k = 1; k < n; k++) seg({ x: m.path[k - 1].x, y: y0 + .22, z: m.path[k - 1].z }, { x: m.path[k].x, y: y0 + .22, z: m.path[k].z }, theme, .9 * (1 - k / n));
      }
      // Extras an AI can report (APEX): rival forecasts, own footprint, expected contact.
      const x = m.extras;
      if (x) {
        if (m.path) {
          // the track the car's own width will sweep, so a squeeze between two cars can be read off the ground
          const edge = (sg) => m.path.map((p, k, a) => { const q = a[Math.min(a.length - 1, k + 1)], o = a[Math.max(0, k - 1)], dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1; return { x: p.x - dz / l * .98 * sg, z: p.z + dx / l * .98 * sg }; });
          for (const sg of [-1, 1]) { const e = edge(sg); for (let k = 1; k < e.length; k++) seg({ x: e[k - 1].x, y: y0 + .16, z: e[k - 1].z }, { x: e[k].x, y: y0 + .16, z: e[k].z }, theme, .55 * (1 - k / e.length)); }
        }
        for (const v of x.rivals ?? []) {
          const kc = col(v.kind === 'alongside' ? toneColor('alongside') : v.kind === 'ahead' ? toneColor('follow') : toneColor('defend')), n = v.pts?.length ?? 0;
          if (n > 1) {
            ribbon(v.pts, 1.96, () => kc, (k) => (v.focus ? .32 : .18) * (1 - k / n), y0 + .1);
            const e = v.pts[n - 1]; ring(e.x, e.z, 1.2, kc, .8, y0 + .14, 14);
          }
        }
        const k = x.contact;
        if (k && Number.isFinite(k.x)) {
          const pulse = 1 + .25 * Math.sin(performance.now() / 90), r = (1.4 + Math.min(3, k.closing) * .35) * pulse, cy = y0 + .4;
          seg({ x: k.x - r, y: cy, z: k.z - r }, { x: k.x + r, y: cy, z: k.z + r }, RED, 1); seg({ x: k.x - r, y: cy, z: k.z + r }, { x: k.x + r, y: cy, z: k.z - r }, RED, 1);
          ring(k.x, k.z, r * 1.3, RED, .9, cy, 20); disc(k.x, k.z, r, r * 2.4, RED, .35, y0 + .06);
        }
      }
      // Tether to the rival it is working on.
      const f = m.focus, other = f && f.index >= 0 ? race.cars[f.index] : null;
      if (other) {
        const fc = col(toneColor(f.kind));
        const d = Math.hypot(other.x - car.x, other.z - car.z), hTop = 1.5 + d * .05, K = 24, oy = other.y ?? 0;
        let a = { x: car.x, y: y0 + 1.4, z: car.z };
        for (let k = 1; k <= K; k++) {
          const t = k / K, b = { x: car.x + (other.x - car.x) * t, y: y0 + 1.4 + (oy - (car.y ?? 0)) * t + 4 * hTop * t * (1 - t), z: car.z + (other.z - car.z) * t };
          if (f.declared || k % 2) seg(a, b, fc, .95);
          a = b;
        }
        const pulse = 1 + .12 * Math.sin(performance.now() / 160);
        ring(other.x, other.z, 3.1 * pulse, fc, .95, oy + .15, 32);
        ring(other.x, other.z, 3.6 * pulse, fc, .4, oy + .15, 32);
        disc(other.x, other.z, 2.2, 4.4, fc, f.declared ? .35 : .16, oy + .05);
      }
      // A car the plan is boxed in by: a cross above it.
      const blk = m.block != null ? race.cars[m.block] : null;
      if (blk) {
        const by = (blk.y ?? 0) + 2.6, r = 1.1, fx = Math.cos(blk.yaw), fz = -Math.sin(blk.yaw);
        seg({ x: blk.x - fx * r, y: by - r, z: blk.z - fz * r }, { x: blk.x + fx * r, y: by + r, z: blk.z + fz * r }, RED, 1);
        seg({ x: blk.x + fx * r, y: by - r, z: blk.z + fz * r }, { x: blk.x - fx * r, y: by + r, z: blk.z - fz * r }, RED, 1);
      }
      // Marks an AI reports on the ground (TEMPEST: where its path leaves the racing line and where it rejoins): a post and a ring.
      for (const k of m.marks ?? []) {
        if (!Number.isFinite(k.x)) continue;
        const mc = col(k.color ?? '#ffffff'), h = k.kind === 'out' ? 2.4 : 1.6;
        seg({ x: k.x, y: y0, z: k.z }, { x: k.x, y: y0 + h, z: k.z }, mc, 1);
        ring(k.x, k.z, 1.1, mc, .95, y0 + .12, 16); ring(k.x, k.z, .5, mc, .95, y0 + h, 10);
      }
      // Chevrons on the side it is going for (host lateral convention, from the track normal).
      if (m.side) {
        const p = race.track.at(car.s, 0), h = Math.atan2(p.tx ?? Math.sin(p.heading ?? 0), p.tz ?? Math.cos(p.heading ?? 0));
        const nx = p.nx ?? Math.cos(h), nz = p.nz ?? -Math.sin(h);
        const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw), sx = nx * m.side, sz = nz * m.side;
        for (let k = 0; k < 3; k++) {
          const o = 2.2 + k * .9, ax = car.x + sx * o, az = car.z + sz * o, y = y0 + .3;
          seg({ x: ax - fx * .8 - sx * .5, y, z: az - fz * .8 - sz * .5 }, { x: ax, y, z: az }, tone, .9 - k * .25);
          seg({ x: ax + fx * .8 - sx * .5, y, z: az + fz * .8 - sz * .5 }, { x: ax, y, z: az }, tone, .9 - k * .25);
        }
      }
      // Pedal aura under the car (green throttle, red brake) inside a ring in the intent colour.
      const c = car.controls ?? {};
      if ((c.brake ?? 0) > .02) disc(car.x, car.z, 1.6, 3.6, RED, .55 * Math.min(1, c.brake * 1.4));
      else if ((c.throttle ?? 0) > .02) disc(car.x, car.z, 1.6, 3.2, GREEN, .35 * c.throttle);
      ring(car.x, car.z, 2.4, tone, .7, y0 + .08, 32);
      // Intent tag above the car.
      const fname = other ? race.entries[f.index]?.team?.short ?? `#${f.index + 1}` : '';
      this.drawTag(m, name, m.tagText ?? (other ? `${FOCUS_WORD[f.kind] ?? 'ON'} ${fname}${f.declared ? '' : ' (inferred)'}` : ''));
      this.tag.visible = true;
      this.tag.position.set(car.x, (car.y ?? 0) + 1.6, car.z);
    } else this.tag.visible = false;

    // Predicted pose one second ahead (constant yaw rate), and the aim point.
    let px = car.x, pz = car.z, yaw = car.yaw;
    for (let k = 0; k < 10; k++) {
      yaw += car.yawRate * .1;
      const nx = px + Math.sin(yaw) * car.speed * .1, nz = pz + Math.cos(yaw) * car.speed * .1;
      lv(px, y0 + .3, pz, WHITE, .2 + k * .07); lv(nx, y0 + .3, nz, WHITE, .27 + k * .07);
      px = nx; pz = nz;
    }
    ring(px, pz, 1.2, WHITE, .9);
    let aim = m?.aim ?? null;
    if (!m) { try { aim = bridge?.visualDebug?.()?.trackingPoint ?? null; } catch { aim = null; } }
    if (aim && Number.isFinite(aim.x)) {
      ring(aim.x, aim.z, .9, GOLD, 1); lv(car.x, y0 + .5, car.z, GOLD, .2); lv(aim.x, y0 + .5, aim.z, GOLD, .9);
    }

    for (const [o, n] of [[this.tris, nt], [this.lines, nl]]) {
      o.geometry.setDrawRange(0, n);
      o.geometry.attributes.position.needsUpdate = true; o.geometry.attributes.color.needsUpdate = true;
    }
  }
  dispose() {
    this.root.removeFromParent();
    for (const o of [this.tris, this.lines]) { o.geometry.dispose(); o.material.dispose(); }
    this.tagTex.dispose(); this.tag.material.dispose();
  }
}
