// SLIPSTREAM observation: pure function of the race state, shared by the training env (Node) and the browser seat.
// No Node APIs here. Any change alters what every exported policy expects: version checkpoints accordingly.
const TAU = Math.PI * 2;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// Observation layout (shared with the learner through the worker handshake).
export const ROAD_K = 24, ROAD_F = 6, RIVAL_N = 8, RIVAL_F = 13, EGO_F = 48;
export const OBS = EGO_F + ROAD_K * ROAD_F + RIVAL_N * RIVAL_F;
const RIVAL_RANGE = 160;

/** 1 m centreline table so observations never call track.at per sample. */
export function roadTable(track) {
  const n = Math.ceil(track.length), x = new Float32Array(n), z = new Float32Array(n), h = new Float32Array(n), k = new Float32Array(n), node = new Int32Array(n);
  for (let i = 0; i < n; i++) { const p = track.at(i); x[i] = p.x; z[i] = p.z; h[i] = p.heading; k[i] = p.curvature; node[i] = p.index; }
  // Curvature smoothed over ±6 m: the node curvature is a 3-point estimate and noisy.
  const ks = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let d = -6; d <= 6; d++) a += k[(i + d + n) % n]; ks[i] = a / 13; }
  return { n, x, z, h, k: ks, node };
}

/**
 * Fills o (Float32Array OBS) for one car. ctx: { car, road (roadTable), track, limit (half width + kerb), cars (whole field),
 * learnerIds (car ids driven by SLIPSTREAM), iface: { applied [2], appliedAge s, sent [2], pending 0/1 } }.
 */
export function observe(o, ctx) {
  const { car: c, road, track: trk, limit, cars, learnerIds, iface: a } = ctx, L = trk.length, n = road.n;
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
  // Ego frame: forward = (sin yaw, cos yaw), right-hand lateral = (cos yaw, -sin yaw).
  const fwd = (dx, dz) => dx * sy + dz * cy, lat = (dx, dz) => dx * cy - dz * sy;
  const si = Math.floor(((c.s % L) + L) % L) % n, head = road.h[si];
  let j = 0; const put = (v) => { o[j++] = Number.isFinite(v) ? v : 0; };
  // Ego dynamics and the interface state (what was actually applied and how stale it is).
  put(c.u / 50); put(c.v / 10); put(c.yawRate / 2); put(c.ax / 20); put(c.ay / 20); put(c.speed / 50);
  put(c.steering / (c.spec?.steeringLock ?? 0.5)); put(c.gear / 7); put(c.rpm / 9000);
  put(a.applied[0]); put(a.applied[1]); put(clamp(a.appliedAge * 5, 0, 3)); put(a.sent[0]); put(a.sent[1]); put(a.pending);
  put(c.lateral / trk.halfWidth); put((limit - (Math.abs(c.lateral) - (c.spec?.track ?? 1.72) / 2)) / 3);
  const he = wrapPi(c.yaw - head); put(Math.sin(he)); put(Math.cos(he));
  put(trk.halfWidth / 8); put((trk.curbWidth ?? 0) / 3);
  put(c.damage * 4); put(c.fuel / 80);
  for (const w of c.wheels) { const t = w.tyre; put(t.kappa ?? 0); put((t.alpha ?? 0) * 4); put(w.load / 6000); put((t.core - (t.optimum ?? 85)) / 30); put(t.wear * 2); }
  const zone = c.zone; put(zone === 'kerb' ? 1 : 0); put(zone === 'gravel' || zone === 'grass' ? 1 : 0);
  put(trk.wetness ?? 0); put((trk.tempGrip ?? 1) - 1);
  put(c.aero?.wake ?? 0); put(c.hybrid ? (c.hybrid.soc ?? 0) : 0);
  while (j < EGO_F) put(0);
  // Road ahead: centreline samples, denser near the car, reaching further with speed.
  const reach = 60 + 4.2 * Math.max(0, c.speed), water = trk.water;
  for (let i = 0; i < ROAD_K; i++) {
    const d = reach * ((i + 1) / ROAD_K) ** 1.6, q = Math.floor(c.s + d) % n, qi = (q + n) % n;
    const dx = road.x[qi] - c.x, dz = road.z[qi] - c.z, rh = wrapPi(road.h[qi] - c.yaw);
    let wet = 0;
    if (water?.live) { const b = road.node[qi] * 13; for (let l = 0; l < 13; l++) wet += water.depth[b + l]; wet /= 13; }
    put(fwd(dx, dz) / 100); put(lat(dx, dz) / 20); put(Math.sin(rh)); put(Math.cos(rh)); put(road.k[qi] * 30); put(wet);
  }
  // Rivals: nearest along the lap within range, ego frame.
  const near = [];
  for (const r of cars) {
    if (r === c) continue;
    const g = wrapPi(((r.s - c.s) / L) * TAU) * L / TAU;
    if (Math.abs(g) < RIVAL_RANGE) near.push([Math.abs(g), g, r]);
  }
  near.sort((p, q) => p[0] - q[0]);
  for (let i = 0; i < RIVAL_N; i++) {
    const p = near[i];
    if (!p) { for (let f = 0; f < RIVAL_F; f++) put(0); continue; }
    const [, g, r] = p, dx = r.x - c.x, dz = r.z - c.z, dvx = r.vx - c.vx, dvz = r.vz - c.vz, ry = wrapPi(r.yaw - c.yaw);
    put(1); put(fwd(dx, dz) / 50); put(lat(dx, dz) / 10); put(fwd(dvx, dvz) / 20); put(lat(dvx, dvz) / 10);
    put(Math.sin(ry)); put(Math.cos(ry)); put(g / 100); put(r.lateral / trk.halfWidth); put(r.speed / 50);
    put(r.damage * 4); put(r.ghost ? 1 : 0); put(learnerIds.includes(r.id) ? 1 : 0);
  }
}
