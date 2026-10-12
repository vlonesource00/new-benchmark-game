// Race layer around the physics for PULSE training scenes: GTP hybrid deployment
// (game/core/hybrid.js with race.js's AI deploy calls), steward hazard memory for
// local yellows (game/core/stewards.js), and PULSE's public observation
// (src/schema.mjs observe + src/schema-v2.mjs conditioning). Checked against the
// real scenario harness by gpu-sim/parity_env.py.
#pragma once
#include "physics.cuh"

#define HY_CAPACITY 3.0e6
#define HY_REGEN_KW 300.0
#define HY_EFFICIENCY 0.86
#define TANK_LITRES 60.0
enum { MODE_BUILD, MODE_BALANCED, MODE_ATTACK, MODE_QUAL };
struct DeployMode { double kw, from, lift, floor, target; };  // target < 0: none
__device__ DeployMode deploy_mode(int m) {
  switch (m) {
    case MODE_QUAL: return { 120, 8, 0, 1, -1 };
    case MODE_ATTACK: return { 95, 14, 40, 1, -1 };
    case MODE_BUILD: return { 20, 45, 130, 1, -1 };
    default: return { 85, 25, 80, .15, .55 };
  }
}
__device__ __forceinline__ double clamp01(double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
__device__ __forceinline__ real wrapr(real x, real n) { return fmod(fmod(x, n) + n, n); }
__device__ __forceinline__ real angler(real a) { return atan2(sin(a), cos(a)); }

// aiDeployMode (race session, no caution) then hybridStep for one car. Gaps are to same-class rivals, pre-step.
// Returns the motor force; energy and mode are updated in place.
__device__ real hybrid_one(const real* Sv, int B, int slots, int c, const int* cls, const float* map, int mapN, double length,
    double throttle, double brake, double* energy, int* mode, int lapsLeft, double dt, double intentDeploy, double intentHarvest) {
  const int base = c / slots * slots;
  double ahead = 1e300, behind = 1e300;  // no same-class rival: Infinity in JS
  for (int k = 0; k < slots; k++) {
    const int o = base + k; if (o == c || cls[o] != cls[c]) continue;
    const double d = fmod(fmod((double)Sv[S * B + o] - (double)Sv[S * B + c], length) + length, length);
    if (d > 0) { ahead = fmin(ahead, d); behind = fmin(behind, length - d); }
  }
  double E = *energy, soc = E / HY_CAPACITY;
  const bool fight = ahead < 40 || behind < 25;
  const bool spend = (lapsLeft <= 1 && soc > .08) || (lapsLeft <= 2 && soc > .45) || soc > .9;
  const bool low = soc < (*mode == MODE_BUILD ? .35 : .2);
  *mode = spend || (fight && soc > .3) ? MODE_ATTACK : low && !fight && lapsLeft > 1 ? MODE_BUILD : MODE_BALANCED;
  // A valid driver intent (car.intent: APEX, INTERCEPT's energy strategy) replaces the dial: ATTACK power scaled by
  // `deploy`, lift-off regen between the ATTACK and BUILD figures, no deploy map.
  const bool intent = intentDeploy == intentDeploy && intentDeploy >= 0;
  DeployMode m = deploy_mode(*mode);
  if (intent) { const double h = clamp01(intentHarvest == intentHarvest ? intentHarvest : .5); m = { 95 * clamp01(intentDeploy), 14, 40 + 90 * h, 1, -1 }; }
  const double v = fmax(0.0, (double)Sv[U * B + c]);
  const int gear = (int)llrint((double)Sv[GEAR * B + c]);
  double deploy = 0, regen = 0, lift = 0;
  if (throttle > .8 && v > m.from && gear >= 2 && E > 0) {
    const double s = (double)Sv[S * B + c];
    const double at = map && !intent ? (double)map[(int)floor(fmod(fmod(s, length) + length, length) / length * mapN) % mapN] : 1;
    const double surplus = m.target < 0 ? 0 : clamp01((soc - m.target - .1) / .3), floor_ = m.floor + (1 - m.floor) * .7 * surplus;
    const double where = floor_ + (1 - floor_) * at;
    const double level = m.target < 0 ? 1 : fmax(.15, fmin(1.0, .6 + 1.6 * (soc - m.target)));
    const double ease = m.target < 0 ? 1 : clamp01((v - m.from) / 12 + .25);
    deploy = m.kw * 1000 * throttle * where * level * ease * clamp01(soc / .04);
  }
  const double fade = clamp01((v - 8) / 14);
  if (brake > .05) regen = HY_REGEN_KW * 1000 * fmin(1.0, brake * 2.5) * fade;
  else if (throttle < .05) lift = m.lift * 1000 * fade;
  if (E >= HY_CAPACITY) regen = lift = 0;
  *energy = fmax(0.0, fmin(HY_CAPACITY, E + ((regen + lift) * HY_EFFICIENCY - deploy) * dt));
  return (real)((deploy - lift) / fmax(v, 12.0));
}

// Steward memory per car after the tick (stewards.step): moving / off / spun with the 2 s clean re-arm.
__device__ void steward_one(const real* Sv, int B, int c, const Track& t, unsigned char* stw, real* cleanT, real dt) {
  unsigned char &moving = stw[c], &off = stw[B + c], &spun = stw[2 * B + c]; real& clean_ = cleanT[c];
  const real speed = Sv[SPEED * B + c], lat = fabs(Sv[LATERAL * B + c]), kerb = t.half + t.curb;
  if (speed > 25) moving = 1;
  const Point near = track_at(t, Sv[S * B + c], 0);
  const real slip = fabs(angler(Sv[YAW * B + c] - atan2(near.tx, near.tz)));
  const bool clean = lat < kerb && slip < .45 && speed > 10;
  clean_ = clean ? clean_ + dt : 0;
  if (clean_ > 2) off = spun = 0;
  if (!off && lat > kerb + 1.0) off = 1;
  if (!spun && speed > 4 && slip > 1.25) spun = 1;
}
__device__ __forceinline__ bool steward_hazard(const unsigned char* stw, int B, int o, real speed) {
  return stw[o] && (stw[2 * B + o] || (stw[B + o] && speed < 15) || speed < 6);
}

// Observation sizes (schema v1 + v2 conditioning).
#define OBS_EGO1 39
#define OBS_EGO 44
#define OBS_TYRE 8
#define OBS_ROAD 12
#define OBS_PREVIEW 12
#define OBS_RIVAL 18
#define OBS_RIVALS 8
#define OBS_SIZE (OBS_EGO + 4 * OBS_TYRE + OBS_PREVIEW * OBS_ROAD + OBS_RIVALS * OBS_RIVAL)
#define MAX_SLOTS_OBS 8

// Per-environment race context for the observing car.
struct EgoContext { real previous[2], held[2], dt, actionAge, lapsLeft, stintLaps, lapsToTyres, trackTemperature, raceTime; int compound; };

// observe() for the car in lane c. classInfo per class: [gtp, halfWidth, halfLength, track].
__device__ void observe_one(const real* Sv, int B, int slots, int c, const int* cls, const double* classInfo, const Track& t,
    const float* rubber, real tempGrip, const int* node, const unsigned char* alive, const unsigned char* ghost, const unsigned char* flags,
    const double* energy, const unsigned char* stw, const real* wakeIn, const real* tyres, const EgoContext& x, real* raw) {
  #define G(k, car) Sv[(k) * B + (car)]
  const Point at = track_nearest(t, G(X, c), G(Z, c), node[c], 16);
  const real heading = atan2(at.tx, at.tz), psi = angler(G(YAW, c) - heading);
  const real cx = G(X, c), cz = G(Z, c), vx = G(VX, c), vz = G(VZ, c), speed = G(SPEED, c);
  const real vf = vx * at.tx + vz * at.tz, vs = vx * at.nx + vz * at.nz;
  const double* ci = classInfo + 4 * cls[c];
  const int base = c / slots * slots;
  // Local yellow: a hazard (another car stopped/spun/crawling) within 300 m ahead; meatball damage outranks it.
  bool yellow = false;
  if (x.raceTime >= 5 && G(DAMAGE, c) < .35)
    for (int k = 0; k < slots; k++) {
      const int o = base + k; if (o == c || !alive[o]) continue;
      if (!steward_hazard(stw, B, o, G(SPEED, o))) continue;
      const real ahead = wrapr(G(S, o) - G(S, c), t.length);
      if (ahead > 0 && ahead < 300) { yellow = true; break; }
    }
  int n = 0;
  raw[n++] = speed; raw[n++] = vf; raw[n++] = vs; raw[n++] = sin(psi); raw[n++] = cos(psi); raw[n++] = G(YAWRATE, c);
  raw[n++] = G(AX, c); raw[n++] = G(AY, c); raw[n++] = at.lateral; raw[n++] = G(STEERING, c);
  raw[n++] = x.previous[0]; raw[n++] = x.previous[1]; raw[n++] = x.held[0]; raw[n++] = x.held[1]; raw[n++] = x.dt; raw[n++] = x.actionAge;
  raw[n++] = G(FUEL, c) / TANK_LITRES; raw[n++] = ci[0] > 0 ? (real)(energy[c] / HY_CAPACITY) : 0; raw[n++] = G(DAMAGE, c); raw[n++] = ci[0];
  raw[n++] = x.lapsLeft; raw[n++] = x.stintLaps; raw[n++] = x.lapsToTyres; raw[n++] = 0;
  raw[n++] = 0; raw[n++] = yellow ? 1 : 0; raw[n++] = 0; raw[n++] = 0; raw[n++] = 0;
  raw[n++] = clampr(wakeIn[c], 0, .95); raw[n++] = 0; raw[n++] = x.trackTemperature; raw[n++] = flags[c] & 1 ? 1 : 0; raw[n++] = flags[c] & 2 ? 1 : 0;
  for (int k = 0; k < 5; k++) raw[n++] = k == x.compound ? 1 : 0;
  // v2 conditioning.
  const real phase = at.s / t.length * (real)(2 * PI_R), cp_ = cos(psi), sp_ = sin(psi);
  raw[n++] = sin(phase); raw[n++] = cos(phase);
  raw[n++] = speed < 1 ? 0 : atan2(vs * cp_ - vf * sp_, vf * cp_ + vs * sp_);
  raw[n++] = psi;
  raw[n++] = t.half + t.curb - ci[3] / 2 - fabs(at.lateral);
  for (int w = 0; w < 4; w++) {
    raw[n++] = G(WF(w, CORE), c) - tyres[c * 5 + 2]; raw[n++] = G(WF(w, WEAR), c); raw[n++] = G(WF(w, LOAD), c); raw[n++] = G(WF(w, ALPHA), c);
    raw[n++] = G(WF(w, KAPPA), c); raw[n++] = G(WF(w, OMEGA), c); raw[n++] = G(WF(w, SLIPPOWER), c); raw[n++] = G(WF(w, BRAKETEMP), c);
  }
  const real PREVIEW[OBS_PREVIEW] = { 0, .15, .3, .5, .75, 1, 1.3, 1.7, 2.2, 2.8, 3.5, 4.2 };
  for (int k = 0; k < OBS_PREVIEW; k++) {
    const real distance = PREVIEW[k] * fmax(15, speed);
    const Point p = track_at(t, at.s + distance, 0);
    const real dx = p.x - cx, dz = p.z - cz;
    const Point l = track_at(t, p.s, -t.half * .65), r = track_at(t, p.s, t.half * .65);
    const Surface middle = track_surface(t, p.x, p.z, rubber, tempGrip, p.index, 4);
    (void)l; (void)r;  // dry road: no water to sample at the side points
    const real h = angler(atan2(p.tx, p.tz) - heading);
    raw[n++] = distance; raw[n++] = dx * at.nx + dz * at.nz; raw[n++] = dx * at.tx + dz * at.tz; raw[n++] = sin(h); raw[n++] = cos(h);
    raw[n++] = p.curvature; raw[n++] = 0; raw[n++] = t.half; raw[n++] = middle.grip; raw[n++] = 0; raw[n++] = 0; raw[n++] = 0;
  }
  // Rivals: priority = |forward| + 2|right| - 30 when ahead and closing; ties by car id (slot).
  int id[MAX_SLOTS_OBS]; real pri[MAX_SLOTS_OBS]; int m = 0;
  for (int k = 0; k < slots; k++) {
    const int o = base + k; if (o == c || !alive[o] || ghost[o]) continue;
    const real dx = G(X, o) - cx, dz = G(Z, o) - cz, right = dx * at.nx + dz * at.nz, forward = dx * at.tx + dz * at.tz;
    if (hypot(right, forward) > 250) continue;
    const real relF = (G(VX, o) - vx) * at.tx + (G(VZ, o) - vz) * at.tz;
    const real p = fabs(forward) + fabs(right) * 2 - (forward > 0 && relF < 0 ? 30 : 0);
    int j = m++;
    while (j > 0 && (pri[j - 1] > p)) { pri[j] = pri[j - 1]; id[j] = id[j - 1]; j--; }
    pri[j] = p; id[j] = k;
  }
  for (int i = 0; i < OBS_RIVALS; i++) {
    if (i >= m) { for (int f = 0; f < OBS_RIVAL; f++) raw[n++] = 0; continue; }
    const int o = base + id[i];
    const Point p = track_nearest(t, G(X, o), G(Z, o), node[o], 16);
    const real dx = G(X, o) - cx, dz = G(Z, o) - cz;
    const real g = fmod(p.s - at.s + t.length * 1.5, t.length) - t.length * .5;
    const double* oi = classInfo + 4 * cls[o];
    const real hdg = angler(G(YAW, o) - heading);
    raw[n++] = 1; raw[n++] = g; raw[n++] = dx * at.nx + dz * at.nz; raw[n++] = dx * at.tx + dz * at.tz;
    raw[n++] = (G(VX, o) - vx) * at.tx + (G(VZ, o) - vz) * at.tz; raw[n++] = (G(VX, o) - vx) * at.nx + (G(VZ, o) - vz) * at.nz;
    raw[n++] = sin(hdg); raw[n++] = cos(hdg); raw[n++] = G(YAWRATE, o); raw[n++] = G(SPEED, o);
    raw[n++] = oi[0]; raw[n++] = fabs(p.lateral) > t.half + .8 ? 1 : 0; raw[n++] = G(SPEED, o) < 5 ? 1 : 0; raw[n++] = 0; raw[n++] = 0;
    raw[n++] = G(DAMAGE, o); raw[n++] = oi[1]; raw[n++] = oi[2];
  }
  #undef G
}
