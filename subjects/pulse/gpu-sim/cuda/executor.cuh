// PULSE driving stack, one CUDA thread per executor car: a line-by-line
// transliteration of pulse/src/plan-executor.mjs with the parts of INTERCEPT
// (course.js, observer.js, controller.js, axles.js) and APEX (line.js, model.js)
// that it executes under the c186 plan settings (line-kerb-v1 bounds, edgeRamp 30,
// live-body-speed-v1 nose guard, rolling-v1 origin, course-v1 feedback,
// reference-v1 join; no side guard). Checked by gpu-sim/parity_executor.py.
// Not ported because unreachable there: gearbox notches (APEX gearSeen is only
// written by APEX's own driver), wet tyres, pit/retired rivals, observer.motion.
#pragma once
#include "physics.cuh"

#define HALF_LENGTH 2.28
#define HALF_WIDTH 0.98
#define ROAD_BRAKE_LIMIT 18.0
#define MAX_SLOTS 8
#define MAX_WIN 112
#define INFINITY __longlong_as_double(0x7ff0000000000000LL)
#define NAN __longlong_as_double(0x7ff8000000000000LL)

// Class constants: the baked course after Line.load (geometry + locate).
enum { LPX, LPZ, LLEN, LH, LK, LKS, LDK, LLAT, LST, LINE_KEYS };
// Mutable lane arrays (Line LANE_KEYS without the unread `v`, plus st).
enum { KPX, KPZ, KLEN, KH, KK, KKS, KDK, KLAT, KVMAX, KVBRK, KST, LANE_KEYS };
// Per executor car: base vmax, vbrk; shadow (rebuild) vmax, vbrk; two lanes.
#define EX_ARRAYS (4 + 2 * LANE_KEYS)
// Options per class (opt[class * OPT_W + k]).
enum { O_MARGIN, O_JERK, O_PREVIEW, O_YAWGAIN, O_EVADEYAW, O_SLIDEGAIN, O_SLIDEBAND, O_STEERJERK, O_BRAKEEXP,
  O_THROTTLEALLOW, O_DRAGK, O_MASS, O_FRONTDRIVE, O_N, O_DS, OPT_W };
// Executor scalar state.
enum { R_CLOCK, R_GRIP, R_MARGIN, R_COMPILEDAT, R_AT, R_GOAL0, R_GOAL1, R_GOAL2, R_SPEED, R_COMP0, R_COMP1, R_COMP2,
  R_KC, R_ACCEL, R_COMPILES, R_HTIME, R_HV = R_HTIME + MAX_SLOTS, R_HBODY = R_HV + MAX_SLOTS, XR = R_HBODY + MAX_SLOTS };
enum { I_REBUILD, I_COUNTDOWN, I_SLOT, I_PATH, I_WIN0, I_WIN1, I_WI0, I_WI1, I_WN0, I_WN1, I_PROFSRC, I_PROFCOUNT,
  I_CURSOR, I_CPATH, I_SEQ, I_HVALID, I_HREF = I_HVALID + MAX_SLOTS, XI = I_HREF + MAX_SLOTS };
enum { OUT_STEER, OUT_THROTTLE, OUT_BRAKE, OUT_KC, OUT_ACCEL, OUT_GRIP, OUT_COMPILES, OUT_PATH, OUT_CURSOR, OUT_NOSECAP,
  OUT_TARGET, OUT_FEED, OUT_SOURCE, OUT_W };  // controller trace (INTERCEPT's energy rule reads target/feed/source)

__device__ __forceinline__ int lidx(int i, int N) { return ((i % N) + N) % N; }
__device__ __forceinline__ real angler(real a) { return atan2(sin(a), cos(a)); }
__device__ __forceinline__ real wrapr(real x, real L) { return fmod(fmod(x, L) + L, L); }
__device__ __forceinline__ real gapr(real s, real o, real L) { return wrapr(s - o + L / 2, L) - L / 2; }

// track.at(s).heading: atan2 of the interpolated (unnormalised) tangent, as JS.
__device__ real track_heading(const Track& t, real s) {
  const real L = t.length; s = fmod(fmod(s, L) + L, L);
  int lo = 0, hi = t.count - 1;
  while (lo < hi) { int mid = (lo + hi + 1) >> 1; if (t.s[mid] <= s) lo = mid; else hi = mid - 1; }
  const int nx_ = lo + 1 == t.count ? 0 : lo + 1;
  const real as = t.s[lo], ds = (lo == t.count - 1 ? L : t.s[nx_]) - as, u = clampr((s - as) / ds, 0, 1);
  return atan2(t.tx[lo] + (t.tx[nx_] - t.tx[lo]) * u, t.tz[lo] + (t.tz[nx_] - t.tz[lo]) * u);
}
__device__ int track_index(const Track& t, real s) {
  const real L = t.length; s = fmod(fmod(s, L) + L, L);
  int lo = 0, hi = t.count - 1;
  while (lo < hi) { int mid = (lo + hi + 1) >> 1; if (t.s[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}

// ---- APEX CarModel -------------------------------------------------------------------------------
// ggv[class]: [nLat, offLat, nBrake, offBrake, nDrive, offDrive, nSteer, offSteer, strideSteer, nBeta, offBeta, strideBeta, ...data]
// (offsets from the start of the class block; tables are [x, y] pairs).
struct Model { const double* g; real grip, margin, dragK; };
__device__ real table(const double* t, int n, real x) {
  if (x <= t[0]) return t[1];
  for (int i = 1; i < n; i++) if (x <= t[2 * i]) {
    const real x0 = t[2 * i - 2], y0 = t[2 * i - 1], x1 = t[2 * i], y1 = t[2 * i + 1];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return t[2 * n - 1];
}
#define GT(k) (m.g + (int)m.g[k])
__device__ real m_latbase(const Model& m, real v) { return table(GT(1), (int)m.g[0], v); }
__device__ real m_lat(const Model& m, real v) { return m_latbase(m, v) * m.grip * m.margin; }
__device__ real m_brake(const Model& m, real v) { return table(GT(3), (int)m.g[2], v) * (.2 + .8 * m.grip) * m.margin; }
__device__ real m_drive(const Model& m, real v) { return table(GT(5), (int)m.g[4], v) * (.25 + .75 * m.grip); }
__device__ real m_dfshare(const Model& m, real v) { return clampr(1 - m_latbase(m, 20) / m_latbase(m, rmax(20, v)), 0, .7); }
__device__ real m_wakespeed(const Model& m, real v, real wake) { return wake > 0 ? sqrt(1 - .16 * rmin(.95, wake) * m_dfshare(m, v)) : 1; }
__device__ real m_mapfor(const Model& m, int which, real ay, real v) {
  // Rows of stride w: [v, length, values...] (the APEX maps have a different length per speed).
  const int n = (int)m.g[which ? 9 : 6], w = (int)m.g[which ? 11 : 8]; const double* maps = m.g + (int)m.g[which ? 10 : 7];
  const real a = fabs(ay) / rmax(.3, m.grip);
  int i = 1; while (i < n - 1 && maps[i * w] < v) i++;
  const double *r0 = maps + (i - 1) * w, *r1 = maps + i * w;
  const real v0 = r0[0], v1 = r1[0], t = clampr((v - v0) / (v1 - v0), 0, 1);
  real out[2];
  for (int q = 0; q < 2; q++) {
    const double* row = q ? r1 : r0; const double* mm = row + 2; const int len = (int)row[1]; const real k = a - 1;
    if (k <= 0) out[q] = mm[0] * rmax(0, a);
    else { const int j = (int)rmin((real)(len - 2), floor(k)); out[q] = mm[j] + (mm[j + 1] - mm[j]) * rmin(1.5, k - j); }
  }
  return signr(ay) * (out[0] * (1 - t) + out[1] * t);
}
#define steerFor(m, ay, v) m_mapfor(m, 0, ay, v)
#define betaFor(m, ay, v) m_mapfor(m, 1, ay, v)

// ---- APEX Line ------------------------------------------------------------------------------------
struct Path { const real *px, *pz, *len, *h, *ks, *lat, *vmax, *vbrk; int N; real ds, steerJerk, cap; int id; };
struct Cur { int i; real f, e, d2; };

__device__ Cur path_closest(const Path& p, real x, real z, int hint, int span) {
  const int N = p.N; real best = INFINITY; int bi = 0;
  if (hint < 0) { for (int i = 0; i < N; i++) { const real dx = p.px[i] - x, dz = p.pz[i] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = i; } } }
  else for (int d = -6; d <= span; d++) { const int i = lidx(hint + d, N); const real dx = p.px[i] - x, dz = p.pz[i] - z, dd = dx * dx + dz * dz; if (dd < best) { best = dd; bi = i; } }
  int i = bi, j = lidx(bi + 1, N);
  real ux = p.px[j] - p.px[i], uz = p.pz[j] - p.pz[i], L2 = ux * ux + uz * uz, f = ((x - p.px[i]) * ux + (z - p.pz[i]) * uz) / rmax(1e-9, L2);
  if (f < 0) { j = i; i = lidx(bi - 1, N); ux = p.px[j] - p.px[i]; uz = p.pz[j] - p.pz[i]; L2 = ux * ux + uz * uz; f = ((x - p.px[i]) * ux + (z - p.pz[i]) * uz) / rmax(1e-9, L2); }
  f = clampr(f, 0, 1);
  real L = sqrt(L2); if (L == 0) L = 1;
  Cur c; c.i = i; c.f = f; c.e = ((x - p.px[i]) * uz - (z - p.pz[i]) * ux) / L; c.d2 = best;
  return c;
}
// sample(a, i, f, ahead) of array a (capped elementwise by cap: the speed profile view).
__device__ real path_sample(const Path& p, const real* a, int i, real f, real ahead, real cap = INFINITY) {
  real d = f * p.len[i] + ahead;
  while (d >= p.len[i]) { d -= p.len[i]; i = lidx(i + 1, p.N); }
  while (d < 0) { i = lidx(i - 1, p.N); d += p.len[i]; }
  const real t = d / rmax(1e-9, p.len[i]);
  return rmin(a[i], cap) * (1 - t) + rmin(a[lidx(i + 1, p.N)], cap) * t;
}
__device__ real path_heading(const Path& p, int i, real f) { const real h0 = p.h[i]; return h0 + angler(p.h[lidx(i + 1, p.N)] - h0) * f; }

// Line.speeds via speedsGen (no notches): vmax and the braking envelope vbrk. Returns the generator's yield count.
__device__ int speeds_full(const real* ks, const real* len, const real* dk, real* vmax, real* vb, int N, const Model& m, real J, real pb) {
  int work = 0, Y = 0; const real top = 95;
  for (int i = 0; i < N; i++) {
    const real ak = fabs(ks[i]); real s = top;
    if (ak > 1e-6) { s = rmin(top, sqrt(m_lat(m, 40) / ak)); for (int it = 0; it < 5; it++) s = rmin(top, sqrt(m_lat(m, s) / ak)); }
    if (J > 0 && dk[i] > 1e-7) s = rmin(s, cbrt(J / dk[i]));
    vmax[i] = s;
    work += ak > 1e-6 ? 3 : 1; if (work >= 1000) { work = 0; Y++; }
  }
  int start = 0; for (int i = 1; i < N; i++) if (vmax[i] < vmax[start]) start = i;
  for (int q = 0; q < 4 * N; q++) if (++work >= 1000) { work = 0; Y++; }   // the unread `v` passes
  for (int i = 0; i < N; i++) vb[i] = vmax[i];
  for (int pass = 0; pass < 2; pass++) for (int j = 0; j < N; j++) {
    const int i = ((start - j) % N + N) % N, pv = i == 0 ? N - 1 : i - 1; const real sp = vb[i];
    const real r = rmin(1, sp * sp * fabs(ks[i]) / m_lat(m, sp));
    const real b = m_brake(m, sp) * pow(1 - pow(r, pb), 1 / pb), t = sqrt(sp * sp + 2 * len[pv] * rmax(.5, b));
    if (t < vb[pv]) vb[pv] = t;
    if (++work >= 1000) { work = 0; Y++; }
  }
  return Y;
}

// ---- lane arrays ----------------------------------------------------------------------------------
struct Ex { real* base; int N; const real* C; };   // C: class constants [LINE_KEYS][N]
__device__ __forceinline__ real* bvmax(const Ex& x) { return x.base; }
__device__ __forceinline__ real* bvbrk(const Ex& x) { return x.base + x.N; }
__device__ __forceinline__ real* svmax(const Ex& x) { return x.base + 2 * x.N; }
__device__ __forceinline__ real* svbrk(const Ex& x) { return x.base + 3 * x.N; }
__device__ __forceinline__ real* lane(const Ex& x, int l, int k) { return x.base + (4 + l * LANE_KEYS + k) * x.N; }
__device__ __forceinline__ const real* cst(const Ex& x, int k) { return x.C + k * x.N; }
// Base value of a lane key at station i.
__device__ real base_key(const Ex& x, int k, int i) {
  switch (k) { case KPX: return cst(x, LPX)[i]; case KPZ: return cst(x, LPZ)[i]; case KLEN: return cst(x, LLEN)[i]; case KH: return cst(x, LH)[i];
    case KK: return cst(x, LK)[i]; case KKS: return cst(x, LKS)[i]; case KDK: return cst(x, LDK)[i]; case KLAT: return cst(x, LLAT)[i];
    case KVMAX: return bvmax(x)[i]; case KVBRK: return bvbrk(x)[i]; default: return cst(x, LST)[i]; }
}
__device__ Path base_path(const Ex& x, real ds) {
  Path p; p.px = cst(x, LPX); p.pz = cst(x, LPZ); p.len = cst(x, LLEN); p.h = cst(x, LH); p.ks = cst(x, LKS); p.lat = cst(x, LLAT);
  p.vmax = bvmax(x); p.vbrk = bvbrk(x); p.N = x.N; p.ds = ds; p.steerJerk = NAN; p.cap = INFINITY; p.id = 0; return p;
}
__device__ Path lane_path(const Ex& x, int l, real ds) {
  Path p; p.px = lane(x, l, KPX); p.pz = lane(x, l, KPZ); p.len = lane(x, l, KLEN); p.h = lane(x, l, KH); p.ks = lane(x, l, KKS);
  p.lat = lane(x, l, KLAT); p.vmax = lane(x, l, KVMAX); p.vbrk = lane(x, l, KVBRK); p.N = x.N; p.ds = ds; p.steerJerk = 180; p.cap = INFINITY; p.id = 1 + l; return p;
}
__device__ void geometry_range(const Ex& x, int l, int a, int count) {
  const int N = x.N; real *px = lane(x, l, KPX), *pz = lane(x, l, KPZ), *len = lane(x, l, KLEN), *h = lane(x, l, KH), *k = lane(x, l, KK),
    *ks = lane(x, l, KKS), *dk = lane(x, l, KDK);
  for (int c = -1; c <= count + 1; c++) {
    const int i = lidx(a + c, N), j = i + 1 == N ? 0 : i + 1, p = i == 0 ? N - 1 : i - 1;
    const real abx = px[i] - px[p], abz = pz[i] - pz[p], bcx = px[j] - px[i], bcz = pz[j] - pz[i];
    const real lab = hypot(abx, abz), lbc = hypot(bcx, bcz), lac = hypot(px[j] - px[p], pz[j] - pz[p]);
    len[i] = lbc; h[i] = atan2(px[j] - px[p], pz[j] - pz[p]);
    k[i] = 2 * (abz * bcx - abx * bcz) / rmax(1e-9, lab * lbc * lac);
  }
  for (int c = 0; c <= count; c++) { const int i = lidx(a + c, N), p = i == 0 ? N - 1 : i - 1, j = i + 1 == N ? 0 : i + 1; ks[i] = .25 * k[p] + .5 * k[i] + .25 * k[j]; }
  for (int c = 1; c < count; c++) { const int i = lidx(a + c, N), p = (i - 3 + N) % N, q = (i + 3) % N; dk[i] = fabs(ks[q] - ks[p]) / rmax(1e-6, 6 * len[i]); }
}

// ---- car view ------------------------------------------------------------------------------------
struct CarView { real x, z, yaw, vx, vz, yawRate, u, v, speed, ax, ay, fuel, alpha[4], kappa[4], load[4], core[4], pressure[4], wear[4]; };
__device__ CarView car_view(const real* S, int B, int c) {
  #define F_(k) S[(k) * B + c]
  CarView o; o.x = F_(X); o.z = F_(Z); o.yaw = F_(YAW); o.vx = F_(VX); o.vz = F_(VZ); o.yawRate = F_(YAWRATE); o.u = F_(U); o.v = F_(V);
  o.speed = F_(SPEED); o.ax = F_(AX); o.ay = F_(AY); o.fuel = F_(FUEL);
  for (int w = 0; w < 4; w++) { o.alpha[w] = F_(WF(w, ALPHA)); o.kappa[w] = F_(WF(w, KAPPA)); o.load[w] = F_(WF(w, LOAD)); o.core[w] = F_(WF(w, CORE));
    o.pressure[w] = F_(WF(w, PRESSURE)); o.wear[w] = F_(WF(w, WEAR)); }
  #undef F_
  return o;
}
// tyre.js tyreGrip.
__device__ real tyre_grip(real core, real optimum, real pressure, real wear, real gripScale, real load) {
  const real wg = 1 - .10 * wear - 1.2 * pow(rmax(wear - .72, (real)0), (real)2);
  return 1.48 * clampr(1 - pow((core - optimum) / 105, (real)2), .65, 1) * clampr(1 - fabs(pressure - 2.15) * .13, .8, 1)
    * clampr(1 - .13 * log(rmax(.1, load / 3300)), .68, 1.18) * wg * gripScale;
}
// APEX liveGrip(car).grip.
__device__ real live_grip(const CarView& car, const real* tyre) {
  real axle[2] = { 2, 2 };
  for (int n = 0; n < 4; n++) {
    const real load = car.load[n] > 100 ? car.load[n] : 3300;
    const real g = tyre_grip(car.core[n], tyre[2], car.pressure[n], car.wear[n], tyre[0], load) / tyre_grip(tyre[2], tyre[2], 2.15, 0, 1, load);
    const int a = n < 2 ? 0 : 1; if (g < axle[a]) axle[a] = g;
  }
  return rmin(axle[0], axle[1]);
}

// ---- INTERCEPT Observer --------------------------------------------------------------------------
struct Rival { int c; real ds, d, vd, ax, decel, along, across; bool physical, hazard; };
struct Me { real d, h; };

// ---- INTERCEPT axles / controller ----------------------------------------------------------------
struct Axles { real use, share, front, rear, spin, beta, reserve; };
__device__ Axles axle_state(const CarView& car, const Model& m, real kp, bool frontDrive) {
  Axles a; const real v = rmax(2, car.speed), physical = m_lat(m, v) / rmax(.6, m.margin);
  a.use = clampr(rmax(fabs(v * v * kp), fabs(car.ay) * .9) / rmax(1, physical), 0, 1);
  real lat[4]; for (int w = 0; w < 4; w++) lat[w] = tan(rmin(1.2, fabs(car.alpha[w]))) * 8.6;
  a.front = rmax(lat[0], lat[1]); a.rear = rmax(lat[2], lat[3]);
  const int d = frontDrive ? 0 : 2; a.spin = rmax(fabs(car.kappa[d]), fabs(car.kappa[d + 1]));
  a.beta = atan2(car.v, rmax(2, car.u));
  const real expected = betaFor(m, car.ay, v), slipError = fabs(a.beta - expected);
  const real yawError = rmax(0, fabs(car.yawRate) - fabs(car.ay / v) - .13);
  const real risk = rmax(rmax(rmax(0, a.rear - 2.45) * .7, rmax(0, a.rear - a.front - .65) * .85),
    rmax(rmax(0, slipError - .075) * 4, rmax(0, yawError - .07) * 1.7));
  a.share = sqrt(rmax(0, 1 - pow(a.use, (real)3))); a.reserve = clampr(1 - risk, .16, 1);
  return a;
}

struct Nose { real cap, brake; int blocker; bool hazard; };
// noseConstraint(car, observer, model, {lateralEscape: true}): the body ray only (no path).
__device__ Nose nose_constraint(const CarView& car, const real* S, int B, const Rival* list, int count, const Model& m, const real* prevBrake) {
  Nose n; n.cap = INFINITY; n.brake = 0; n.blocker = -1; n.hazard = false;
  const real sy = sin(car.yaw), cy = cos(car.yaw), v = rmax(0, car.speed);
  for (int q = 0; q < count; q++) {
    const Rival& r = list[q]; if (!r.physical) continue;
    const real rx = S[X * B + r.c], rz = S[Z * B + r.c], ryaw = S[YAW * B + r.c], rvx = S[VX * B + r.c], rvz = S[VZ * B + r.c];
    const real dx = rx - car.x, dz = rz - car.z, forward = dx * sy + dz * cy, across = dx * cy - dz * sy;
    if (forward < .08 || forward > rmax(28, v * .9)) continue;
    const real delta = angler(ryaw - car.yaw), halfAcross = fabs(cos(delta)) * HALF_WIDTH + fabs(sin(delta)) * HALF_LENGTH;
    const real lateralClosing = (rvx - car.vx) * cy - (rvz - car.vz) * sy, predicted = across + lateralClosing * .16;
    if (fabs(across) > HALF_WIDTH + halfAcross + .12 && fabs(predicted) > HALF_WIDTH + halfAcross + .12) continue;
    const real halfAlong = fabs(cos(delta)) * HALF_LENGTH + fabs(sin(delta)) * HALF_WIDTH;
    const real otherV = rvx * sy + rvz * cy, closing = rmax(0, v - otherV), room = forward - HALF_LENGTH - halfAlong - .65;
    const real ownBrake = rmax(3, m_brake(m, v) * .75);
    const real deceleration = rmax(rmax(0, -r.ax), m_brake(m, rmax(5, otherV)) * prevBrake[r.c] * .8);
    if (closing < .7 && !r.hazard && room > 1.2 && deceleration < 2) continue;
    const real escapeTime = rmin(1.1, deceleration > 2 ? (sqrt(closing * closing + 2 * deceleration * rmax(0, room)) - closing) / deceleration
      : rmax(0, room) / rmax(.5, closing));
    const real escapeAcross = across + lateralClosing * escapeTime;
    if (!r.hazard && room > rmax(1.2, closing * .45) && fabs(lateralClosing) > 1 && across * escapeAcross > 0
      && fabs(escapeAcross) > HALF_WIDTH + halfAcross + .45) continue;
    const real leadStop = pow(rmax(0, otherV), (real)2) * (deceleration > 2 ? rmin(1, ownBrake / deceleration) : 1);
    const real usableRoom = rmax(0, room - (deceleration > 2 ? closing * .15 + .5 * deceleration * pow((real).15, (real)2) : 0));
    const real safe = sqrt(leadStop + 2 * ownBrake * usableRoom);
    if (safe < n.cap) { n.cap = safe; n.blocker = r.c; n.hazard = r.hazard; }
    if (room < closing * .18) n.brake = rmax(n.brake, clampr(closing / rmax(2, room + 2), 0, 1));
  }
  return n;
}

// ---- the executor step ---------------------------------------------------------------------------
struct ExArgs {
  const real* S; int B, slots; const int* cls; const real* lineC; const double* ggv; int ggvW; const double* opt;
  const real* tyres; const real* tempGrip; const unsigned char* alive; const unsigned char* ghost; const int* node;
  const real* prevBrake; const real* wake; const int* exLane; real* ex; double* xr; int* xi;
};

__device__ Model model_of(const ExArgs& A, int k, const double* xr) {
  Model m; m.g = A.ggv + k * A.ggvW; m.grip = xr[R_GRIP]; m.margin = xr[R_MARGIN]; m.dragK = A.opt[k * OPT_W + O_DRAGK]; return m;
}

__device__ void executor_init_one(const ExArgs& A, const Track& t, int e) {
  const int c = A.exLane[e], env = c / A.slots, k = A.cls[c]; const double* o = A.opt + k * OPT_W;
  const int N = (int)o[O_N]; double* xr = A.xr + e * XR; int* xi = A.xi + e * XI;
  Ex x; x.N = N; x.base = A.ex + (size_t)e * EX_ARRAYS * N; x.C = A.lineC + (size_t)k * LINE_KEYS * N;
  const CarView car = car_view(A.S, A.B, c);
  xr[R_GRIP] = live_grip(car, A.tyres + c * 5) * A.tempGrip[env]; xr[R_MARGIN] = o[O_MARGIN];
  const Model m = model_of(A, k, xr);
  speeds_full(cst(x, LKS), cst(x, LLEN), cst(x, LDK), bvmax(x), bvbrk(x), N, m, o[O_JERK], o[O_BRAKEEXP]);
  for (int l = 0; l < 2; l++) for (int key = 0; key < LANE_KEYS; key++) { real* d = lane(x, l, key); for (int i = 0; i < N; i++) d[i] = base_key(x, key, i); }
  xr[R_CLOCK] = 99; xr[R_COMPILEDAT] = -INFINITY; xr[R_AT] = 0; xr[R_GOAL0] = xr[R_GOAL1] = xr[R_GOAL2] = 0; xr[R_SPEED] = 95;
  xr[R_COMP0] = xr[R_COMP1] = xr[R_COMP2] = 0; xr[R_KC] = NAN; xr[R_ACCEL] = 0; xr[R_COMPILES] = 0;
  xi[I_REBUILD] = 0; xi[I_COUNTDOWN] = 0; xi[I_SLOT] = 0; xi[I_PATH] = -1; xi[I_WIN0] = xi[I_WIN1] = 0; xi[I_PROFSRC] = -1; xi[I_PROFCOUNT] = 0;
  xi[I_CURSOR] = -1; xi[I_CPATH] = -1; xi[I_SEQ] = 0;
  for (int s = 0; s < MAX_SLOTS; s++) xi[I_HVALID + s] = 0;
}

__device__ real quintic_(real ao, real as, real ac, real bo, real bs, real bc, real length, real distance) {
  const real u = clampr(distance / length, 0, 1), a1 = as * length, a2 = .5 * ac * length * length;
  const real Aq = bo - ao - a1 - a2, Bq = bs * length - a1 - 2 * a2, Cq = bc * length * length - 2 * a2;
  return ao + u * (a1 + u * (a2 + u * (10 * Aq - 4 * Bq + .5 * Cq + u * (-15 * Aq + 7 * Bq - Cq + u * (6 * Aq - 3 * Bq + .5 * Cq)))));
}

// PlanExecutor.compile (rolling-v1 origin, reference-v1 join, line-kerb-v1 bounds, edgeBlend 0, no side guard).
__device__ void compile_route(const ExArgs& A, const Track& t, const Ex& x, real ds, const Model& m, const double* o,
    const CarView& car, real mass, const Cur& cur, const real* offsets, double* xr, int* xi) {
  const int N = x.N, i0 = cur.i; const Path base = base_path(x, ds);
  const real start = cur.f * base.len[i0], beta = atan2(car.v, rmax(2, car.u));
  real joinOffset = cur.e, slope = clampr(tan(angler(car.yaw + beta - path_heading(base, cur.i, cur.f))), -.35, .35);
  const real velocityCurvature = (car.ay * cos(beta) - car.ax * sin(beta)) / rmax(64, car.speed * car.speed);
  real curvature = clampr(velocityCurvature - base.ks[i0], -.006, .006);
  if (isfinite(xr[R_COMPILEDAT])) {
    const Path cp = xi[I_PATH] < 0 ? base : lane_path(x, xi[I_PATH], ds);
    const int next = lidx(i0 + 1, N); const real f = cur.f, h = path_heading(base, i0, f);
    const real dx = (cp.px[i0] - base.px[i0]) * (1 - f) + (cp.px[next] - base.px[next]) * f;
    const real dz = (cp.pz[i0] - base.pz[i0]) * (1 - f) + (cp.pz[next] - base.pz[next]) * f;
    joinOffset = dx * cos(h) - dz * sin(h);
    slope = clampr(tan(angler(path_heading(cp, i0, f) - h)), -.35, .35);
    curvature = clampr(cp.ks[i0] * (1 - f) + cp.ks[next] * f - base.ks[i0] * (1 - f) - base.ks[next] * f, -.006, .006);
  }
  // Knots: join, the three plan offsets at 30/70/120 m, rejoin at 240 m.
  const real dist[5] = { 0, 30, 70, 120, 240 }, val[5] = { joinOffset, offsets[0], offsets[1], offsets[2], 0 };
  real ps[5], pc[5]; ps[0] = slope; pc[0] = curvature; ps[4] = 0; pc[4] = 0;
  for (int i = 1; i < 4; i++) {
    const real before = (val[i] - val[i - 1]) / (dist[i] - dist[i - 1]), after = (val[i + 1] - val[i]) / (dist[i + 1] - dist[i]);
    ps[i] = before * after > 0 ? clampr(2 * before * after / (before + after), -.25, .25) : 0;
    pc[i] = clampr(2 * (after - before) / (dist[i + 1] - dist[i - 1]), -.008, .008);
  }
  int n = (int)rmin((real)(N - 22), ceil((dist[4] + start) / ds)); if (n > MAX_WIN - 1) n = MAX_WIN - 1;
  real shift[MAX_WIN], corr[MAX_WIN], along[MAX_WIN];
  int segment = 0; real travelled = 0;
  const real asphalt = t.half - 1.12, kerb = t.half + t.curb - .15;
  for (int j = 0; j <= n; j++) {
    const real xx = travelled - start;
    while (segment < 3 && xx > dist[segment + 1]) segment++;
    const real offset = xx < 0 ? joinOffset + slope * xx + .5 * curvature * xx * xx
      : quintic_(val[segment], ps[segment], pc[segment], val[segment + 1], ps[segment + 1], pc[segment + 1], dist[segment + 1] - dist[segment], xx - dist[segment]);
    const int i = lidx(i0 + j, N); const real h = base.h[i];
    const Point q = track_nearest(t, base.px[i] + cos(h) * offset, base.pz[i] - sin(h) * offset, track_index(t, cst(x, LST)[i]), 16);
    const real upper = clampr(base.lat[i], asphalt, kerb), lower = clampr(-base.lat[i], asphalt, kerb);
    const real projection = rmax(.3, cos(angler(h - track_heading(t, q.s))));
    const real bounded = rmin(-rmin(-q.lateral, lower), upper);
    shift[j] = offset; corr[j] = (q.lateral - bounded) / projection; along[j] = xx;
    travelled += base.len[i];
  }
  // edgeRamp 30: raised-cosine dilation of each edge's corrections.
  real outer[MAX_WIN], inner[MAX_WIN];
  for (int j = 0; j <= n; j++) { outer[j] = rmax(0, corr[j]); inner[j] = rmin(0, corr[j]); }
  const real ramp = 30;
  for (int j = 0; j <= n; j++) for (int mm = 0; mm <= n; mm++) {
    const real c = corr[mm], d = fabs(along[j] - along[mm]);
    if (c == 0 || d >= ramp) continue;
    const real eased = c * (.5 + .5 * cos(PI_R * d / ramp)) * clampr(along[j] / ramp, 0, 1);
    if (c > 0) outer[j] = rmax(outer[j], eased); else inner[j] = rmin(inner[j], eased);
  }
  for (int j = 0; j <= n; j++) shift[j] -= outer[j] + inner[j];
  const int l = xi[I_SLOT]; xi[I_SLOT] = 1 - l;
  if (xi[I_WIN0 + l]) { const int wi0 = xi[I_WI0 + l], wn = xi[I_WN0 + l];
    for (int key = 0; key < LANE_KEYS; key++) { real* d = lane(x, l, key); for (int j = -14; j <= wn + 16; j++) { const int i = lidx(wi0 + j, N); d[i] = base_key(x, key, i); } } }
  // laneWindow(shift, i0, n, lane)
  for (int key = 0; key < KST; key++) { real* d = lane(x, l, key); for (int c = -14; c <= n + 16; c++) { const int i = lidx(i0 + c, N); d[i] = base_key(x, key, i); } }
  real *lpx = lane(x, l, KPX), *lpz = lane(x, l, KPZ), *llat = lane(x, l, KLAT), *lst = lane(x, l, KST);
  for (int j = 0; j <= n; j++) { const int i = lidx(i0 + j, N); const real h = base.h[i];
    lpx[i] = base.px[i] + cos(h) * shift[j]; lpz[i] = base.pz[i] - sin(h) * shift[j]; llat[i] = base.lat[i] + shift[j]; }
  for (int c = 1; c <= 8; c++) { const int i = lidx(i0 - c, N); const real h = base.h[i];
    lpx[i] = base.px[i] + cos(h) * shift[0]; lpz[i] = base.pz[i] - sin(h) * shift[0]; llat[i] = base.lat[i] + shift[0]; }
  geometry_range(x, l, i0 - 10, n + 12);
  xi[I_WIN0 + l] = 1; xi[I_WI0 + l] = i0; xi[I_WN0 + l] = n;
  // Preserve the body's incoming derivatives behind the join.
  real behind = -start;
  for (int j = 1; j <= 10; j++) {
    const int i = lidx(i0 - j, N); behind -= base.len[i];
    const real offset = joinOffset + slope * behind + .5 * curvature * behind * behind, h = base.h[i];
    lpx[i] = base.px[i] + cos(h) * offset; lpz[i] = base.pz[i] - sin(h) * offset; llat[i] = base.lat[i] + offset;
  }
  geometry_range(x, l, i0 - 12, n + 14);
  for (int j = -8; j <= n; j++) { const int i = lidx(i0 + j, N);
    const Point q = track_nearest(t, lpx[i], lpz[i], track_index(t, cst(x, LST)[i]), 16); lst[i] = q.s; llat[i] = q.lateral; }
  // speedsWindow(model, i0, n, 95, base.vbrk[i0 + n], {mass, brakeExp, jerk: 0, notch: false})
  const real pb = o[O_BRAKEEXP], top = 95, vEnd = base.vbrk[lidx(i0 + n, N)];
  real *ks = lane(x, l, KKS), *len = lane(x, l, KLEN), *vmax = lane(x, l, KVMAX), *vb = lane(x, l, KVBRK);
  for (int c = 0; c <= n; c++) {
    const int i = lidx(i0 + c, N); const real ak = fabs(ks[i]); real s = top;
    if (ak > 1e-6) { s = rmin(top, sqrt(m_lat(m, 40) / ak)); for (int it = 0; it < 4; it++) s = rmin(top, sqrt(m_lat(m, s) / ak)); }
    vmax[i] = s; vb[i] = s;
  }
  const int iE = lidx(i0 + n, N); vb[iE] = rmin(vb[iE], vEnd);
  for (int c = n; c > 0; c--) {
    const int i = lidx(i0 + c, N), pv = lidx(i0 + c - 1, N); const real sp = vb[i], r = rmin(1, sp * sp * fabs(ks[i]) / m_lat(m, sp));
    const real b = m_brake(m, sp) * pow(1 - pow(r, pb), 1 / pb), tt = sqrt(sp * sp + 2 * len[pv] * rmax(.5, b));
    if (tt < vb[pv]) vb[pv] = tt;
  }
  xi[I_PATH] = l; xi[I_PROFSRC] = -1;
}

__device__ void executor_step_one(const ExArgs& A, const Track& t, int e, double time, double dt, const real* plan, int planSeq, double planAt, real* out) {
  const int c = A.exLane[e], env = c / A.slots, k = A.cls[c]; const double* o = A.opt + k * OPT_W;
  const int N = (int)o[O_N]; const real ds = o[O_DS]; double* xr = A.xr + e * XR; int* xi = A.xi + e * XI;
  Ex x; x.N = N; x.base = A.ex + (size_t)e * EX_ARRAYS * N; x.C = A.lineC + (size_t)k * LINE_KEYS * N;
  const CarView car = car_view(A.S, A.B, c);
  const real mass = o[O_MASS] + car.fuel * .75;
  // commit(action, sequence, at): decodePlan.
  if (planSeq != xi[I_SEQ]) {
    for (int q = 0; q < 3; q++) xr[R_GOAL0 + q] = clampr(plan[q], -1, 1) * 6;
    xr[R_SPEED] = 95 + clampr(plan[3], -1, 0) * 70; xi[I_SEQ] = planSeq; xr[R_AT] = planAt;
  }
  // Course.tick: refresh every 0.25 s; a profile rebuild lands after the generator's yields, two per tick.
  xr[R_CLOCK] += dt;
  if (xr[R_CLOCK] > .25) {
    xr[R_CLOCK] = 0;
    const real g = live_grip(car, A.tyres + c * 5) * A.tempGrip[env], mg = o[O_MARGIN];
    if (!(fabs(g - xr[R_GRIP]) < .007 && fabs(mg - xr[R_MARGIN]) < .004)) {
      xr[R_GRIP] = g; xr[R_MARGIN] = mg;
      if (!xi[I_REBUILD]) {
        const Model m = model_of(A, k, xr);
        const int Y = speeds_full(cst(x, LKS), cst(x, LLEN), cst(x, LDK), svmax(x), svbrk(x), N, m, o[O_JERK], o[O_BRAKEEXP]);
        xi[I_REBUILD] = 1; xi[I_COUNTDOWN] = Y / 2;
      }
    }
  }
  if (xi[I_REBUILD]) {
    if (xi[I_COUNTDOWN] == 0) { for (int i = 0; i < N; i++) { bvmax(x)[i] = svmax(x)[i]; bvbrk(x)[i] = svbrk(x)[i]; } xi[I_REBUILD] = 0; }
    else xi[I_COUNTDOWN]--;
  }
  const Model m = model_of(A, k, xr);
  // Observer.update (reference = the base course).
  const Path base = base_path(x, ds);
  const Point meP = track_nearest(t, car.x, car.z, A.node[c], 16);
  Me me; me.d = meP.lateral; me.h = track_heading(t, meP.s);
  Rival list[MAX_SLOTS]; int count = 0;
  for (int s = 0; s < A.slots; s++) {
    const int oc = env * A.slots + s;
    if (oc == c || !A.alive[oc] || (A.ghost[oc] && A.ghost[c])) continue;
    #define O_(f) A.S[(f) * A.B + oc]
    const Point q = track_nearest(t, O_(X), O_(Z), A.node[oc], 16); const real dsr = gapr(q.s, meP.s, t.length);
    if (fabs(dsr) > rmax(140, car.speed * 3.5) && hypot(O_(X) - car.x, O_(Z) - car.z) > 100) continue;
    const real h = track_heading(t, q.s), psi = angler(O_(YAW) - h), v = O_(VX) * sin(h) + O_(VZ) * cos(h);
    const real vd = O_(VX) * cos(h) - O_(VZ) * sin(h);
    const bool old = xi[I_HVALID + s]; const double elapsed = old ? time - xr[R_HTIME + s] : 0;
    const real ax = elapsed > .008 && elapsed < .5 ? clampr((v - xr[R_HV + s]) / elapsed, -ROAD_BRAKE_LIMIT, 8) : 0;
    const real bodySpeed = hypot(O_(VX), O_(VZ));
    const real decel = elapsed > .008 && elapsed < .5 && old ? clampr((xr[R_HBODY + s] - bodySpeed) / elapsed, 0, 60) : 0;
    const bool off = fabs(q.lateral) > t.half + .8, reenter = off && q.lateral * vd < -.4;
    const bool physical = !off || reenter || fabs(q.lateral - meP.lateral) < 3;
    bool eligible = !off && v >= 7 && fabs(psi) < .65;
    bool hazard = fabs(psi) > .65 || v < 7 || (!eligible && physical);
    const int span = (int)rmax(14, ceil(rmax(0, elapsed) * O_(SPEED) / ds) + 8);
    Cur rc = path_closest(base, O_(X), O_(Z), old ? xi[I_HREF + s] : -1, span);
    if (rc.d2 > 225) rc = path_closest(base, O_(X), O_(Z), -1, 14);
    const real h2 = path_heading(base, rc.i, rc.f), referenceSpeed = O_(VX) * sin(h2) + O_(VZ) * cos(h2), coursePsi = angler(O_(YAW) - h2);
    if (fabs(coursePsi) < .65 && referenceSpeed >= 7) { eligible = !off; hazard = !eligible && physical; }
    Rival r; r.c = oc; r.ds = dsr; r.d = q.lateral; r.vd = vd; r.ax = ax; r.decel = decel; r.physical = physical; r.hazard = hazard;
    r.along = fabs(cos(psi)) * HALF_LENGTH + fabs(sin(psi)) * HALF_WIDTH; r.across = fabs(cos(psi)) * HALF_WIDTH + fabs(sin(psi)) * HALF_LENGTH;
    int p = count++; while (p > 0 && fabs(list[p - 1].ds) > fabs(r.ds)) { list[p] = list[p - 1]; p--; } list[p] = r;   // stable sort by |ds|
    xi[I_HVALID + s] = 1; xr[R_HTIME + s] = time; xr[R_HV + s] = v; xr[R_HBODY + s] = bodySpeed; xi[I_HREF + s] = rc.i;
    #undef O_
  }
  // Route renewal and compile.
  const Cur cur = path_closest(base, car.x, car.z, -1, 14);
  const double age = fmax(0., time - xr[R_AT]); const real offs[3] = { xr[R_GOAL0], xr[R_GOAL1], xr[R_GOAL2] };
  bool changed = false; for (int q = 0; q < 3; q++) changed |= fabs(offs[q] - xr[R_COMP0 + q]) > .18;
  const double elapsed = time - xr[R_COMPILEDAT]; const bool renew = xi[I_PATH] >= 0 && elapsed > .25 && age < .1;
  if ((changed || renew) && elapsed >= .05) {
    if (fabs(offs[0]) < .12 && fabs(offs[1]) < .12 && fabs(offs[2]) < .12 && fabs(cur.e) < .3) xi[I_PATH] = -1;
    else compile_route(A, t, x, ds, m, o, car, mass, cur, offs, xr, xi);
    for (int q = 0; q < 3; q++) xr[R_COMP0 + q] = offs[q];
    xr[R_COMPILEDAT] = time; xr[R_COMPILES] += 1;
  }
  const bool onLane = xi[I_PATH] >= 0;
  Path path = onLane ? lane_path(x, xi[I_PATH], ds) : base;
  const real speed = xr[R_SPEED];
  if (speed < (real)95 - (real).1) {
    if (xi[I_PROFSRC] != path.id) { xi[I_PROFCOUNT]++; xi[I_PROFSRC] = path.id; }
    path.cap = speed; path.id = 3 + xi[I_PROFCOUNT];
  }
  const Nose nose = nose_constraint(car, A.S, A.B, list, count, m, A.prevBrake);
  // Controller.step with course-v1 feedback (lane options: steerJerk 180).
  const real oSteerJerk = onLane ? 180 : o[O_STEERJERK], v = rmax(.5, car.speed);
  Cur cc = path_closest(path, car.x, car.z, path.id == xi[I_CPATH] ? xi[I_CURSOR] : -1, 14);
  if (cc.d2 > 225) cc = path_closest(path, car.x, car.z, -1, 14);
  xi[I_CURSOR] = cc.i; xi[I_CPATH] = path.id;
  const bool emergency = path.steerJerk > oSteerJerk; const real preview = emergency ? rmin(.08, o[O_PREVIEW]) : o[O_PREVIEW];
  const real kp = path_sample(path, path.ks, cc.i, cc.f, v * preview), heading = path_heading(path, cc.i, cc.f);
  const Axles ax = axle_state(car, m, kp, o[O_FRONTDRIVE] != 0); const real psi = angler(car.yaw + ax.beta - heading);
  const real look = emergency ? clampr(.15 * v + 6, 9, 19) : clampr(.32 * v + 7, 9, 32), fb = (emergency ? .65 : .45) * m_lat(m, v) / (v * v);
  real kk = kp + clampr(-2 * psi / look - cc.e / (look * look), -fb, fb);
  if (isfinite(xr[R_KC])) { const real delta = rmax(oSteerJerk, rmin(240, isnan(path.steerJerk) ? oSteerJerk : path.steerJerk)) * rmax(0, dt) / (v * v);
    kk = xr[R_KC] + clampr(kk - xr[R_KC], -delta, delta); }
  xr[R_KC] = kk;
  const real ay = signr(kk) * rmin(fabs(v * v * kk), .98 * m_lat(m, v) / rmax(.6, m.margin));
  const real betaError = ax.beta - betaFor(m, ay, v), slide = signr(betaError) * rmax(0, fabs(betaError) - o[O_SLIDEBAND]);
  const real evade = isnan(o[O_EVADEYAW]) ? rmin(.3, (real)o[O_YAWGAIN]) : (real)o[O_EVADEYAW];
  real steer = clampr(steerFor(m, ay, v) + (emergency ? evade : (real)o[O_YAWGAIN]) * (ay / rmax(2, v) - car.yawRate)
    + (emergency ? rmin(1.6, (real)o[O_SLIDEGAIN]) : (real)o[O_SLIDEGAIN]) * slide, -1, 1);
  for (int q = 0; q < count; q++) {
    const Rival& r = list[q];
    if (!r.physical || fabs(r.ds) > HALF_LENGTH + r.along + .8) continue;
    const real dir = signr(r.d - me.d), room = fabs(r.d - me.d) - HALF_WIDTH - r.across;
    const real drift = dir * (car.vx * cos(me.h) - car.vz * sin(me.h) - r.vd);
    if (room < .25 && drift > .35 && fabs(me.d - dir * .5) < t.half - 1.1) steer -= dir * clampr((drift - .35) * .045, 0, .18);
  }
  // longitudinalDemand(path, cursor, v, model, {cap: nose.cap, wake})
  const real wake = A.wake[c], look1 = v * .1, look2 = rmax(4, v * .25);
  real target = path_sample(path, path.vbrk, cc.i, cc.f, look1, path.cap), next = path_sample(path, path.vbrk, cc.i, cc.f, look1 + look2, path.cap);
  int source = 0;   // 0 profile, 1 wake, 2 nose
  if (wake > .05) {
    const real brake = m_brake(m, v) * (1 - .16 * rmin(.95, wake) * m_dfshare(m, v));
    const real reach = rmin(220, v * v / rmax(4, 2 * brake) + look2);
    for (real xx = ds; xx <= reach; xx += ds * 2) {
      const real vc = path_sample(path, path.vmax, cc.i, cc.f, xx, path.cap), limit = vc * m_wakespeed(m, vc, wake), dist = rmax(0, xx - look1);
      const real env1 = sqrt(limit * limit + 2 * brake * dist), env2 = sqrt(limit * limit + 2 * brake * rmax(0, dist - look2));
      if (env1 < target) { target = env1; source = 1; } next = rmin(next, env2);
    }
  }
  if (nose.cap < target) { target = nose.cap; source = 2; }
  next = rmin(next, nose.cap);
  const real feed = (next * next - target * target) / (2 * look2), error = target - v;
  real acc = feed + error * 2.7;
  if (error > .65) acc = rmax(acc, m_drive(m, v) * (error > 2 ? 1 : .65));
  if (source != 2 && error > -.15 && feed > -.7) acc = rmax(.4, acc);
  acc = clampr(acc, -m_brake(m, v), rmax(.5, m_drive(m, v)));
  const real rate = acc < xr[R_ACCEL] ? 100 : 85;
  xr[R_ACCEL] += clampr(acc - xr[R_ACCEL], -rate * dt, rate * dt);
  // allocate(acceleration, v, model, axles, options)
  real throttle = 0, brake = 0; int reason = 0;   // 0 demand, 1 brake-reserve, 2 blocked-nose, 3 other caps
  const real accel = xr[R_ACCEL];
  if (accel >= -.2) {
    const real drive = rmax(.5, m_drive(m, v)), drag = m.dragK * v * v + .13;
    throttle = clampr((accel + drag) / rmax(.5, drive + drag), 0, 1);
    const real limit = rmax(.25, ax.share * o[O_THROTTLEALLOW]);
    if (throttle > limit) { throttle = limit; reason = 3; }
    const real spinCap = clampr(1 - 3 * rmax(0, ax.spin - .28), .25, 1), safe = rmin(ax.reserve, spinCap);
    if (throttle > safe) { throttle = safe; reason = 3; }
  } else {
    brake = clampr(-accel / rmax(2, m_brake(m, v)), 0, 1);
    const real available = rmax(.12, ax.share * 1.15) * ax.reserve;
    if (brake > available) { brake = available; reason = 1; }
  }
  const real urgent = nose.blocker >= 0 && nose.hazard && emergency ? rmin(nose.brake, rmax(.12, ax.share * 1.15) * ax.reserve) : nose.brake;
  if (urgent > brake) { throttle = 0; brake = urgent; reason = 2; }
  if (reason == 1 && source == 2) {
    const real allocated = throttle * (m_drive(m, v) + m.dragK * v * v + .13) - (m.dragK * v * v + .13) - brake * m_brake(m, v);
    xr[R_ACCEL] = rmax(xr[R_ACCEL], allocated);
  }
  out[OUT_STEER] = clampr(steer, -1, 1); out[OUT_THROTTLE] = throttle; out[OUT_BRAKE] = brake; out[OUT_KC] = xr[R_KC];
  out[OUT_ACCEL] = xr[R_ACCEL]; out[OUT_GRIP] = xr[R_GRIP]; out[OUT_COMPILES] = xr[R_COMPILES]; out[OUT_PATH] = xi[I_PATH];
  out[OUT_CURSOR] = xi[I_CURSOR]; out[OUT_NOSECAP] = isfinite(nose.cap) ? nose.cap : -1;
  out[OUT_TARGET] = target; out[OUT_FEED] = feed; out[OUT_SOURCE] = source;
}
