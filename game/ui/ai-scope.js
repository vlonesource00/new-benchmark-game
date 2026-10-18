// 3D tab of the AI debugger: a scale model of the road around the focused car, drawn from what its AI reports
// (the lens model) and the live field. Its own small WebGL view, rendered only while the tab is on screen.
//  · the road with kerbs, every car nearby as a box in its team colour
//  · the path the AI will drive as a speed fence (height and colour = forecast speed), glowing where it is in a wake
//  · the options it weighed, alpha by score, with what each gains; a "?" option is a preview, not a decision
//  · each rival's forecast as a car-width ribbon ending in a ghost box; the wake cone behind cars ahead
//  · ORACLE: the braking point and apex its moves are judged at, the ghost of itself at the brake, the follow-cap tether
//  · a forecast contact as a pulsing red ring
// Drag to orbit, wheel to zoom, double-click to reset; CHASE / TOP switch the camera.
import * as THREE from 'three';
import { toneColor } from './lens-model.js';

const MAX_T = 24000, MAX_L = 12000, CAR = { w: 1.96, h: 1.15, l: 4.56 };
const STOPS = ['#2b50ff', '#00d9ff', '#6dff8a', '#ffd23f', '#ff4fd8'].map((c) => new THREE.Color(c));
const tmp = new THREE.Color(), RED = new THREE.Color('#ff3b3b'), WHITE = new THREE.Color('#ffffff');
const col = (c) => new THREE.Color(c);
function speedColor(v) {
  const q = Math.max(0, Math.min(0.999, (v - 15) / 70)) * (STOPS.length - 1), i = Math.floor(q);
  return tmp.copy(STOPS[i]).lerp(STOPS[i + 1], q - i).clone();
}

export class AiScope {
  constructor(pane) {
    this.pane = pane;
    this.wrap = document.createElement('div'); this.wrap.className = 'scope';
    this.wrap.innerHTML = '<canvas></canvas><div class="shud"></div><div class="sview"><button data-v="chase">CHASE</button><button data-v="top">TOP</button></div><div class="slegend"></div>';
    pane.append(this.wrap);
    this.canvas = this.wrap.querySelector('canvas'); this.hud = this.wrap.querySelector('.shud'); this.legend = this.wrap.querySelector('.slegend');
    this.view = 'chase'; this.cam = { yaw: 0, pitch: 0.42, dist: 34 }; this.az = null; this.target = null;
    this.wrap.querySelector('.sview').addEventListener('pointerdown', (ev) => { const b = ev.target.closest('[data-v]'); if (!b) return; ev.preventDefault(); ev.stopPropagation(); this.setView(b.dataset.v); });
    this.bindOrbit();
    this.setView('chase');
    this.model = null; this.race = null; this.focus = -1; this.on = false; this.raf = 0; this.trackId = null; this.labels = new Map();
  }

  setView(v) {
    // CHASE sits behind and a little to the right so the speed fence reads as a wall, not a line.
    this.view = v; this.cam = v === 'top' ? { yaw: 0, pitch: 1.42, dist: 95 } : { yaw: -0.5, pitch: 0.36, dist: 30 };
    for (const b of this.wrap.querySelectorAll('.sview button')) b.classList.toggle('on', b.dataset.v === v);
  }
  bindOrbit() {
    let drag = null;
    this.canvas.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY }; this.canvas.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      this.cam.yaw -= (ev.clientX - drag.x) * 0.008; this.cam.pitch = Math.max(0.06, Math.min(1.5, this.cam.pitch + (ev.clientY - drag.y) * 0.006));
      drag = { x: ev.clientX, y: ev.clientY };
    });
    const end = () => { drag = null; };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); ev.stopPropagation(); this.cam.dist = Math.max(8, Math.min(260, this.cam.dist * Math.exp(ev.deltaY * 0.0012))); }, { passive: false });
    this.canvas.addEventListener('dblclick', () => this.setView(this.view));
  }

  /** Lazily: renderer, scene and the dynamic batches (triangles and lines with per-vertex colour and alpha). */
  init() {
    if (this.renderer) return;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#06080c'); this.scene.fog = new THREE.Fog('#06080c', 140, 420);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.5, 900);
    this.scene.add(new THREE.HemisphereLight('#9fb4ff', '#151820', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(40, 80, 20); this.scene.add(sun);
    const grid = new THREE.GridHelper(4000, 200, '#1a2030', '#10141c'); grid.position.y = -0.05; this.scene.add(grid);
    const batch = (max, Kind) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const mat = Kind === THREE.Mesh ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }) : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
      const o = new Kind(g, mat); o.frustumCulled = false; o.renderOrder = 2; this.scene.add(o); return o;
    };
    this.tris = batch(MAX_T, THREE.Mesh); this.lines = batch(MAX_L, THREE.LineSegments);
    this.boxGeo = new THREE.BoxGeometry(CAR.w, CAR.h, CAR.l); this.boxGeo.translate(0, CAR.h / 2, 0);
    this.edgeGeo = new THREE.EdgesGeometry(this.boxGeo);
    this.cars = [];
    this.sprites = new THREE.Group(); this.scene.add(this.sprites);
  }

  /** The road, built once per track: asphalt, kerbs striped red and white every 3 m, white edges. */
  buildRoad(track) {
    if (this.trackId === track.id && this.road) return;
    if (this.road) { this.scene.remove(this.road); this.road.traverse((o) => o.geometry?.dispose()); }
    this.trackId = track.id; this.road = new THREE.Group();
    const L = track.length, step = 3, N = Math.ceil(L / step), hw = track.halfWidth, kw = track.curbWidth ?? 1;
    const strip = (a, b, y, colorAt) => {
      const pos = [], cols = [];
      for (let k = 0; k < N; k++) {
        const p = track.at(k * step), q = track.at(((k + 1) % N) * step), c = colorAt(k);
        const P = (s, o) => [s.x + s.nx * o, y, s.z + s.nz * o];
        const quad = [P(p, a), P(p, b), P(q, b), P(p, a), P(q, b), P(q, a)];
        for (const v of quad) { pos.push(...v); cols.push(c.r, c.g, c.b); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); this.road.add(m);
    };
    const asphalt = col('#1d222b'), run = col('#0f1a14'), kr = col('#c0392b'), kw2 = col('#d9dde3');
    strip(-hw - kw - 5, hw + kw + 5, -0.03, () => run);
    strip(-hw, hw, -0.01, (k) => (k % 2 ? asphalt : tmp.copy(asphalt).offsetHSL(0, 0, 0.012).clone()));
    for (const sg of [-1, 1]) strip(sg * hw, sg * (hw + kw), 0, (k) => (k % 2 ? kr : kw2));
    const edge = [];
    for (let k = 0; k <= N; k++) for (const sg of [-1, 1]) { const p = track.at(k * step), q = track.at((k + 1) * step); edge.push(p.x + p.nx * hw * sg, 0.02, p.z + p.nz * hw * sg, q.x + q.nx * hw * sg, 0.02, q.z + q.nz * hw * sg); }
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
    this.road.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: '#8b93a3', transparent: true, opacity: 0.6 })));
    this.scene.add(this.road);
  }

  /** Cached canvas label, as a sprite that faces the camera. */
  label(text, color, scale = 1) {
    const key = text + '|' + color;
    let tex = this.labels.get(key);
    if (!tex) {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
      const g = cv.getContext('2d'); g.font = '700 30px "JetBrains Mono", monospace'; g.textBaseline = 'middle';
      const w = Math.min(250, g.measureText(text).width + 18);
      g.fillStyle = 'rgba(6,8,12,.78)'; g.fillRect(0, 10, w, 44); g.fillStyle = color; g.fillRect(0, 10, 4, 44); g.fillText(text, 10, 33);
      tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.userData.w = w;
      if (this.labels.size > 160) { for (const t of this.labels.values()) t.dispose(); this.labels.clear(); }
      this.labels.set(key, tex);
    }
    let sp = this.sprites.children[this.nSprite];
    if (!sp) { sp = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true })); sp.renderOrder = 5; sp.center.set(0, 0.5); this.sprites.add(sp); }
    sp.material.map = tex; sp.material.needsUpdate = true; sp.visible = true; this.nSprite++;
    const s = scale * Math.max(0.6, this.cam.dist / 34);
    sp.scale.set(4 * s, 1 * s, 1);
    return sp;
  }

  show(on) {
    this.on = on;
    if (on && !this.raf) { this.init(); const loop = () => { this.raf = this.on ? requestAnimationFrame(loop) : 0; if (this.on) this.frame(); }; this.raf = requestAnimationFrame(loop); }
  }
  /** Data from the panel's update (the lens model and the race); the scene itself is drawn every animation frame. */
  update(race, focus, model, teamColor, teamsById = {}) { this.race = race; this.focus = focus; this.model = model; this.teamColor = teamColor; this.teamsById = teamsById; }

  frame() {
    const race = this.race, car = race?.cars?.[this.focus];
    if (!car || !this.pane.offsetParent) return;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return;
    if (this.size !== W + 'x' + H) { this.size = W + 'x' + H; this.renderer.setSize(W, H, false); this.camera.aspect = W / H; this.camera.updateProjectionMatrix(); }
    this.buildRoad(race.track);
    const m = this.model, theme = col(m?.theme?.color ?? '#ffffff'), tone = col(toneColor(m?.tone));
    const T = this.tris.geometry.attributes, Lg = this.lines.geometry.attributes;
    let nt = 0, nl = 0; this.nSprite = 0;
    const tv = (x, y, z, c, a) => { if (nt >= MAX_T) return; T.position.array.set([x, y, z], nt * 3); T.color.array.set([c.r, c.g, c.b, a], nt * 4); nt++; };
    const lv = (x, y, z, c, a) => { if (nl >= MAX_L) return; Lg.position.array.set([x, y, z], nl * 3); Lg.color.array.set([c.r, c.g, c.b, a], nl * 4); nl++; };
    const seg = (p, q, c, a, y = 0.1) => { lv(p.x, p.y ?? y, p.z, c, a); lv(q.x, q.y ?? y, q.z, c, a); };
    const quad = (a, b, c, d, cl, al) => { tv(a.x, a.y, a.z, cl, al[0]); tv(b.x, b.y, b.z, cl, al[1]); tv(c.x, c.y, c.z, cl, al[2]); tv(a.x, a.y, a.z, cl, al[0]); tv(c.x, c.y, c.z, cl, al[2]); tv(d.x, d.y, d.z, cl, al[3]); };
    const side = (P, k) => { const q = P[Math.min(P.length - 1, k + 1)], o = P[Math.max(0, k - 1)], dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; };
    // A flat ribbon of width w along points P.
    const ribbon = (P, w, cf, af, y) => {
      for (let k = 1; k < P.length; k++) {
        const [ax, az] = side(P, k - 1), [bx, bz] = side(P, k), p = P[k - 1], q = P[k], h = w / 2, c = cf(p, k), a0 = af(k - 1), a1 = af(k);
        quad({ x: p.x + ax * h, y, z: p.z + az * h }, { x: q.x + bx * h, y, z: q.z + bz * h }, { x: q.x - bx * h, y, z: q.z - bz * h }, { x: p.x - ax * h, y, z: p.z - az * h }, c, [a0, a1, a1, a0]);
      }
    };
    const ring = (x, z, r, c, a, y = 0.12, n = 20) => { for (let k = 0; k < n; k++) { const t0 = k / n * Math.PI * 2, t1 = (k + 1) / n * Math.PI * 2; seg({ x: x + Math.cos(t0) * r, y, z: z + Math.sin(t0) * r }, { x: x + Math.cos(t1) * r, y, z: z + Math.sin(t1) * r }, c, a); } };
    const ghost = (x, z, yaw, c, a) => {
      const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx, hw = CAR.w / 2, hl = CAR.l / 2;
      const P = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([f, s]) => ({ x: x + fx * f + rx * s, z: z + fz * f + rz * s }));
      for (const y of [0.05, CAR.h]) for (let k = 0; k < 4; k++) seg({ ...P[k], y }, { ...P[(k + 1) % 4], y }, c, a);
      for (const p of P) seg({ ...p, y: 0.05 }, { ...p, y: CAR.h }, c, a * 0.6);
    };
    const yawOf = (P, k) => { k = Math.max(0, Math.min(P.length - 1, k)); const q = P[Math.min(P.length - 1, k + 1)], o = P[Math.max(0, k - 1)]; return Math.atan2(q.x - o.x, q.z - o.z); };

    // Cars nearby: boxes in team colour; the focused car outlined in its architecture colour.
    const near = race.cars.map((c, i) => ({ c, i, d: Math.hypot(c.x - car.x, c.z - car.z) })).filter((q) => q.d < 160 && !q.c.ghost).sort((a, b) => a.d - b.d).slice(0, 14);
    near.forEach((q, k) => {
      let o = this.cars[k];
      if (!o) { o = new THREE.Mesh(this.boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 })); o.add(new THREE.LineSegments(this.edgeGeo, new THREE.LineBasicMaterial({ color: '#000' }))); this.scene.add(o); this.cars[k] = o; }
      const ent = race.entries[q.i], c = this.teamsById?.[ent?.team?.id]?.color ?? ent?.team?.color ?? (q.i === this.focus ? this.teamColor : '#8a93a6');
      o.visible = true; o.position.set(q.c.x, 0, q.c.z); o.rotation.y = q.c.yaw ?? 0; o.material.color.set(c);
      o.children[0].material.color.set(q.i === this.focus ? m?.theme?.color ?? '#fff' : '#05070a');
      if (q.i !== this.focus) { const name = ent?.team?.short ?? `#${q.c.id}`; this.label(name, c, 0.7).position.set(q.c.x, CAR.h + 1.3, q.c.z); }
    });
    for (let k = near.length; k < this.cars.length; k++) this.cars[k].visible = false;

    const x = m?.extras ?? null, sc = m?.scope ?? null;
    // Wake cones behind cars ahead (strength fades along the cone).
    for (const r of x?.rivals ?? []) {
      const cn = r.cone ?? [];
      for (let k = 1; k < cn.length; k++) {
        const a = cn[k - 1], b = cn[k], c = col('#7fb6ff');
        quad({ x: a[0], y: 0.04, z: a[1] }, { x: b[0], y: 0.04, z: b[1] }, { x: b[2], y: 0.04, z: b[3] }, { x: a[2], y: 0.04, z: a[3] }, c, [a[4] * 0.18, b[4] * 0.18, b[4] * 0.18, a[4] * 0.18]);
        seg({ x: a[0], y: 0.06, z: a[1] }, { x: b[0], y: 0.06, z: b[1] }, c, 0.35 * b[4]); seg({ x: a[2], y: 0.06, z: a[3] }, { x: b[2], y: 0.06, z: b[3] }, c, 0.35 * b[4]);
      }
    }
    // Rival forecasts: car-width ribbon fading over the horizon, a ghost box where it ends.
    for (const r of x?.rivals ?? []) {
      const P = r.pts ?? [], n = P.length, kc = col(r.kind === 'alongside' ? toneColor('alongside') : r.kind === 'ahead' ? toneColor('follow') : toneColor('defend'));
      if (n < 2) continue;
      ribbon(P, CAR.w, () => kc, (k) => (r.focus ? 0.34 : 0.2) * (1 - k / n) + 0.03, 0.07);
      ghost(P[n - 1].x, P[n - 1].z, yawOf(P, n - 1), kc, r.focus ? 0.8 : 0.45);
    }
    // Options weighed: centre line per option, alpha by score (dashed when only a preview), gain label at its end.
    const opts = sc?.options ?? (m?.cands ?? []).filter((c) => Array.isArray(c.points)).map((c) => ({ kind: c.label, score: c.score, chosen: c.chosen, ok: true, pts: c.points }));
    if (opts.length) {
      const s0 = opts.map((o) => o.score).filter(Number.isFinite), lo = Math.min(...s0), hi = Math.max(...s0);
      for (const o of opts) {
        const P = o.pts ?? [], n = P.length; if (n < 2 || o.chosen) continue;
        const q = hi > lo ? (o.score - lo) / (hi - lo) : 1, c = o.feasible === false ? RED : o.ok ? theme : col('#9aa4b2');
        for (let k = 1; k < n; k++) if (!o.preview || k % 2) seg({ x: P[k - 1].x, y: 0.25, z: P[k - 1].z }, { x: P[k].x, y: 0.25, z: P[k].z }, c, (0.25 + 0.6 * q) * (1 - 0.6 * k / n));
        ring(P[n - 1].x, P[n - 1].z, 0.5, c, 0.7, 0.25, 10);
        this.label(`${o.kind} ${o.score >= 0 ? '+' : ''}${o.score.toFixed(1)} m`, o.ok ? m?.theme?.color ?? '#fff' : '#9aa4b2', 0.65).position.set(P[n - 1].x, 1.6, P[n - 1].z);
      }
    }
    // The path to be driven: a speed fence (height and colour = forecast speed), the wake glow under it, its footprint.
    const path = m?.path ?? null;
    if (path?.length > 1) {
      const n = path.length;
      for (let k = 1; k < n; k++) {
        const p = path[k - 1], q = path[k], vp = p.v ?? 0, vq = q.v ?? 0, c = speedColor(vq), hp = 0.25 + vp * 0.045, hq = 0.25 + vq * 0.045, fade = 1 - 0.7 * k / n;
        quad({ x: p.x, y: 0.2, z: p.z }, { x: q.x, y: 0.2, z: q.z }, { x: q.x, y: hq, z: q.z }, { x: p.x, y: hp, z: p.z }, c, [0.42 * fade, 0.42 * fade, 0.05, 0.05]);
        seg({ x: p.x, y: hp, z: p.z }, { x: q.x, y: hq, z: q.z }, c, 0.95 * fade);
        if ((q.wake ?? 0) > 0.08) { const g = col('#7fb6ff'); ring(q.x, q.z, 0.6 + q.wake, g, 0.5 * q.wake, 0.09, 12); }
      }
      ribbon(path, CAR.w, () => tone, (k) => 0.16 * (1 - k / n), 0.08);
      const e = path[n - 1]; this.label(`${Math.round((e.v ?? 0) * 3.6)} km/h @ ${(0.2 * (n - 1)).toFixed(1)} s`, '#ffffff', 0.6).position.set(e.x, 0.25 + (e.v ?? 0) * 0.045 + 1, e.z);
    }
    // ORACLE: braking gate and apex gate across the road, its own ghost where the forecast has it at the brake (and apex).
    if (sc) {
      const gate = (gp, c, text) => {
        if (!gp) return;
        const t = race.track.nearest(gp.x, gp.z), hw = race.track.halfWidth + 0.6, cx = gp.x - t.lateral * t.nx, cz = gp.z - t.lateral * t.nz;
        const a = { x: cx - t.nx * hw, z: cz - t.nz * hw }, b = { x: cx + t.nx * hw, z: cz + t.nz * hw };
        seg({ ...a, y: 0 }, { ...a, y: 3.2 }, c, 0.9); seg({ ...b, y: 0 }, { ...b, y: 3.2 }, c, 0.9); seg({ ...a, y: 3.2 }, { ...b, y: 3.2 }, c, 0.9);
        quad({ ...a, y: 0.03 }, { ...b, y: 0.03 }, { x: b.x + t.tx * 1.2, y: 0.03, z: b.z + t.tz * 1.2 }, { x: a.x + t.tx * 1.2, y: 0.03, z: a.z + t.tz * 1.2 }, c, [0.5, 0.5, 0.5, 0.5]);
        this.label(text, '#' + c.getHexString(), 0.75).position.set(b.x, 4, b.z);
      };
      gate(sc.brake, RED, `BRAKE ${sc.brake?.d.toFixed(0)} m`);
      gate(sc.apex, col('#c77dff'), `APEX · inside ${sc.inside > 0 ? 'R' : 'L'}`);
      const me = path?.length ? path : null;
      if (sc.atBrake && me) { ghost(sc.atBrake.x, sc.atBrake.z, yawOf(me, Math.round(sc.atBrake.t / 0.2)), RED, 0.9); }
      if (sc.atApex && me) { ghost(sc.atApex.x, sc.atApex.z, yawOf(me, Math.round(sc.atApex.t / 0.2)), col('#c77dff'), 0.9); }
      // The follow cap: a tether to the car it holds the distance to.
      const cb = sc.capBy, rc = cb && race.cars.find((c) => c.id === cb.id);
      if (rc) {
        const a = { x: car.x, y: 1.5, z: car.z }, b = { x: rc.x, y: 1.5, z: rc.z }, c = col('#ffb02e');
        for (let k = 0; k < 10; k += 2) seg({ x: a.x + (b.x - a.x) * k / 10, y: 1.5, z: a.z + (b.z - a.z) * k / 10 }, { x: a.x + (b.x - a.x) * (k + 1) / 10, y: 1.5, z: a.z + (b.z - a.z) * (k + 1) / 10 }, c, 0.95);
        this.label(`CAP ${cb.v != null ? Math.round(cb.v * 3.6) + ' km/h' : ''} · ${cb.lateral.toFixed(1)} m off`, '#ffb02e', 0.7).position.set((a.x + b.x) / 2, 2.6, (a.z + b.z) / 2);
      }
    }
    // Forecast contact.
    const k = x?.contact;
    if (k && Number.isFinite(k.x)) {
      const r = (1.3 + Math.min(3, k.closing ?? 0) * 0.35) * (1 + 0.25 * Math.sin(performance.now() / 90));
      ring(k.x, k.z, r, RED, 0.95, 0.3, 24); ring(k.x, k.z, r * 1.4, RED, 0.5, 0.3, 24);
      this.label(`CONTACT ${k.t ?? ''} s · ${k.closing ?? ''} m/s`, '#ff3b3b', 0.7).position.set(k.x, 2.4, k.z);
    }
    // The focused car's footprint ring in its tone.
    ring(car.x, car.z, 3.4, tone, 0.8, 0.06, 28);

    T.position.needsUpdate = T.color.needsUpdate = Lg.position.needsUpdate = Lg.color.needsUpdate = true;
    this.tris.geometry.setDrawRange(0, nt); this.lines.geometry.setDrawRange(0, nl);
    for (let i = this.nSprite; i < this.sprites.children.length; i++) this.sprites.children[i].visible = false;

    // Camera: orbit around the car, behind it in CHASE (heading followed smoothly), north-up-ish over it in TOP.
    const yaw = car.yaw ?? 0;
    const now = performance.now(), dt = Math.min(0.5, (now - (this.at ?? now)) / 1000); this.at = now;
    this.az = this.az == null ? yaw : this.az + Math.atan2(Math.sin(yaw - this.az), Math.cos(yaw - this.az)) * (1 - Math.exp(-dt * 5));
    const fwd = { x: Math.sin(this.az), z: Math.cos(this.az) }, look = { x: car.x + fwd.x * (this.view === 'top' ? 18 : 14), z: car.z + fwd.z * (this.view === 'top' ? 18 : 14) };
    this.target = look;
    const az = this.az + Math.PI + this.cam.yaw, cp = Math.cos(this.cam.pitch), d = this.cam.dist;
    this.camera.position.set(this.target.x + Math.sin(az) * cp * d, Math.sin(this.cam.pitch) * d + 0.5, this.target.z + Math.cos(az) * cp * d);
    this.camera.lookAt(this.target.x, 0, this.target.z);
    this.renderer.render(this.scene, this.camera);
    this.drawHud(m);
  }

  drawHud(m) {
    const now = performance.now();
    if (now - (this.hudAt ?? 0) < 120) return; this.hudAt = now;
    if (!m) { this.hud.innerHTML = ''; return; }
    const sc = m.scope, opt = (sc?.options ?? []).find((o) => o.chosen);
    this.hud.innerHTML = `<b style="color:${toneColor(m.tone)}">${String(m.intent ?? '—').toUpperCase()}</b><span>${m.sub ?? ''}</span>`
      + (sc ? `<span>${sc.brake ? `brake in ${sc.brake.d.toFixed(0)} m` : 'no brake ahead'}${sc.atBrake ? ` · ${sc.atBrake.t.toFixed(1)} s` : ''}${opt && opt.kind !== 'line' ? ` · holding ${opt.kind}` : ''}</span>` : '');
    const leg = [['#3ddc84', 'path · speed fence'], [m.theme?.color ?? '#fff', 'options'], ['#ffb02e', 'rival ahead'], ['#4f8cff', 'behind'], ['#7fb6ff', 'wake'], ['#ff3b3b', 'brake'], ['#c77dff', 'apex']];
    this.legend.innerHTML = leg.map(([c, t]) => `<i style="--c:${c}">${t}</i>`).join('');
  }
}
