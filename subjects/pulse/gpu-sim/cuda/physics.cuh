// One CUDA thread per car: a line-by-line transliteration of game/engine/sim
// vehicle.js, tyre.js and track.js (verified against the JS reference by
// gpu-sim/parity*.py). `real` is double for parity runs, float for training.
#pragma once

#define WING 6.0
#define TC_LEVEL 3.0
#define ABS_LEVEL 4.0
#define CAMBER (-0.035)
#define MAX_GEARS 8
#define PI_R 3.14159265358979323846

// State fields, in the order of gpu-sim/reference-fields.mjs (state is field-major: S[field * B + car]).
enum { X, Z, YAW, VX, VZ, YAWRATE, U, V, SPEED, AX, AY, ROLL, PITCH, HEAVE, STEERING, GEAR, RPM, SHIFT,
  FUEL, DAMAGE, IMPACT, S, LATERAL, CAR_FIELDS };
enum { OMEGA, COMPRESSION, LOAD, BRAKETEMP, WSTEER, KAPPA, ALPHA, FX, FY, SURF, CORE, INNER, OUTER, PRESSURE,
  WEAR, SLIPPOWER, UTIL, WHEEL_FIELDS };
#define WF(w, k) (CAR_FIELDS + (w) * WHEEL_FIELDS + (k))
#define FIELDS (CAR_FIELDS + 4 * WHEEL_FIELDS)

struct Spec {
  double mass, wheelbase, track, cg, frontWeight, yawInertia, radius, wheelInertia, maxTorque, finalDrive,
    steeringLock, area, cd, cl, brakeTorque, brakeBias, tyreGrip, frontAero, springFront, springRear, rearAero;
  double gears[MAX_GEARS]; int maxGear;
};

struct Track {
  const double *x, *z, *s, *tx, *tz, *curv; int count;
  double length, half, curb, runoff, barrier, laneWidth;
};

struct Point { real x, z, tx, tz, nx, nz, s, curvature, lateral; int index, node; };

__device__ __forceinline__ real clampr(real x, real a, real b) { return x < a ? a : x > b ? b : x; }
__device__ __forceinline__ real dampr(real a, real b, real rate, real dt) { return a + (b - a) * (1 - exp(-rate * dt)); }
__device__ __forceinline__ real rmax(real a, real b) { return fmax(a, b); }
__device__ __forceinline__ real rmin(real a, real b) { return fmin(a, b); }
__device__ __forceinline__ real signr(real x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }

__device__ Point track_at(const Track& t, real s, real offset) {
  const real L = t.length;
  s = fmod(fmod(s, L) + L, L);
  int lo = 0, hi = t.count - 1;
  while (lo < hi) { int mid = (lo + hi + 1) >> 1; if (t.s[mid] <= s) lo = mid; else hi = mid - 1; }
  const int nx_ = lo + 1 == t.count ? 0 : lo + 1;
  const real as = t.s[lo], ds = (lo == t.count - 1 ? L : t.s[nx_]) - as;
  const real u = clampr((s - as) / ds, 0, 1);
  const real tx = t.tx[lo] + (t.tx[nx_] - t.tx[lo]) * u, tz = t.tz[lo] + (t.tz[nx_] - t.tz[lo]) * u;
  const real mag = hypot(tx, tz), nx = tz / mag, nz = -tx / mag;
  Point p;
  p.x = t.x[lo] + (t.x[nx_] - t.x[lo]) * u + nx * offset;
  p.z = t.z[lo] + (t.z[nx_] - t.z[lo]) * u + nz * offset;
  p.tx = tx / mag; p.tz = tz / mag; p.nx = nx; p.nz = nz; p.s = s; p.index = lo; p.node = lo;
  p.curvature = t.curv[lo] + (t.curv[nx_] - t.curv[lo]) * u; p.lateral = 0;
  return p;
}

// Nearest node within +-window of `guess` (global when guess < 0); equals the JS grid search near the road.
__device__ Point track_nearest(const Track& t, real x, real z, int guess, int window) {
  int best = 0; real bd = (real)1e30;
  if (guess < 0) { for (int i = 0; i < t.count; i++) { real dx = t.x[i] - x, dz = t.z[i] - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } } }
  else for (int k = -window; k <= window; k++) {
    int i = ((guess + k) % t.count + t.count) % t.count; real dx = t.x[i] - x, dz = t.z[i] - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  const real along = (x - t.x[best]) * t.tx[best] + (z - t.z[best]) * t.tz[best];
  Point p = track_at(t, t.s[best] + along, 0);
  p.lateral = (x - p.x) * p.nx + (z - p.z) * p.nz; p.node = best;
  return p;
}

struct Surface { Point p; real grip, bump, resistance; int cell; bool asphalt; };

__device__ Surface track_surface(const Track& t, real x, real z, const float* rubber, real tempGrip, int guess, int window) {
  Surface o; o.p = track_nearest(t, x, z, guess, window);
  const real lat = o.p.lateral, l = fabs(lat);
  int lane = (int)floor((lat + t.half) / t.laneWidth); lane = lane < 0 ? 0 : lane > 12 ? 12 : lane;
  o.cell = o.p.index * 13 + lane;
  const real rub = (real)rubber[o.cell];
  o.asphalt = l < t.half;
  const bool kerb = !o.asphalt && l < t.half + t.curb, gravel = !o.asphalt && !kerb && l < t.half + t.curb + t.runoff - 1;
  const real base = o.asphalt ? 1.0 : kerb ? .88 : gravel ? .52 : .42;
  o.grip = base * (1 + rub * .10) * tempGrip;
  o.bump = kerb ? .028 + sin(o.p.s * 4) * .012 : 0;
  o.resistance = gravel ? .09 : (!o.asphalt && !kerb) ? .06 : .013;
  return o;
}

struct Tyre { real kappa, alpha, fx, fy, surf, core, inner, outer, pressure, wear, slipPower, util; };

// Compound parameters (race.fitTyres): gripScale, wearScale, optimum, heat, coldPressure. Dry road (wet = 0).
struct Compound { real gripScale, wearScale, optimum, heat, cold; };

__device__ void tyre_force(Tyre& y, real vx, real vy, real omega, real load, real grip, real h, real radius, real ambient, const Compound& k) {
  const real speed = rmax(fabs(vx), (real)2.5);
  y.kappa = dampr(y.kappa, clampr((omega * radius - vx) / speed, -2, 2), speed / .32, h);
  y.alpha = dampr(y.alpha, atan2(vy, speed), speed / .45, h);
  const real wg = 1 - .10 * y.wear - 1.2 * pow(rmax(y.wear - .72, (real)0), (real)2);
  const real tg = 1.48 * clampr(1 - pow((y.core - k.optimum) / 105, (real)2), .65, 1) * clampr(1 - fabs(y.pressure - 2.15) * .13, .8, 1)
    * clampr(1 - .13 * log(rmax(load / 3300, (real).1)), .68, 1.18) * wg * k.gripScale;
  const real peak = rmax(grip * load * tg, (real)0);
  const real sx = y.kappa * 10.5, sy = tan(clampr(y.alpha, -1.2, 1.2)) * 8.6, slip = hypot(sx, sy);
  const real shape = tanh(slip) * (1 - .16 * clampr((slip - 1.4) / 5, 0, 1));
  real fx = slip > .00001 ? peak * shape * sx / slip : 0;
  real fy = (slip > .00001 ? -peak * shape * sy / slip : 0) - CAMBER * load * .035;
  if (load < 1) { fx = 0; fy = 0; }
  y.fx = fx; y.fy = fy;
  y.util = peak > 0 ? hypot(fx, fy) / peak : 0;
  const real sp = clampr(fabs(fx * (omega * radius - vx)) + fabs(fy * vy), 0, 180000);
  y.slipPower = sp;
  const real rolling = load * fabs(vx) * .012, cooling = (y.surf - ambient) * (46 + fabs(vx) * 2.2);
  y.surf = clampr(y.surf + (sp * .55 * k.heat + rolling - cooling - (y.surf - y.core) * 75) / 6000 * h, ambient, 210);
  y.core = clampr(y.core + ((y.surf - y.core) * 75 + rolling * .3 - (y.core - ambient) * 4) / 18000 * h, ambient, 170);
  y.inner = y.surf + fabs(CAMBER) * 75; y.outer = y.surf - fabs(CAMBER) * 45;
  y.pressure = (k.cold + 1.01325) * ((y.core + 273.15) / (ambient + 273.15)) - 1.01325;
  y.wear = clampr(y.wear + k.wearScale * sp * h * 1.7e-10 * (1 + rmax(y.surf - 115, (real)0) / 35), 0, 1);
}

// One physics tick of one car (Vehicle.step). Reads and writes its state column; lays rubber with atomics.
__device__ void vehicle_step(real* Sv, int B, int c, const Spec& sp, const Track& t, float* rubber, real dt,
    real throttleIn, real brakeIn, real steerIn, real wake, real hybridForce, real tempGrip, real ambient, bool alive, bool layRubber, int* node, const Compound& compound) {
  #define F_(k) Sv[(k) * B + c]
  real x = F_(X), z = F_(Z), yaw = F_(YAW), vx = F_(VX), vz = F_(VZ), yawRate = F_(YAWRATE);
  real ax = F_(AX), ay = F_(AY), roll = F_(ROLL), pitch = F_(PITCH), heave = F_(HEAVE), steering = F_(STEERING);
  int gear = (int)llrint((double)F_(GEAR));
  real rpm = F_(RPM), shiftTimer = F_(SHIFT), fuel = F_(FUEL), damage = F_(DAMAGE), impact = F_(IMPACT);
  real omega[4], compression[4], loadw[4], brakeTemp[4], wsteer[4]; Tyre ty[4];
  for (int w = 0; w < 4; w++) {
    omega[w] = F_(WF(w, OMEGA)); compression[w] = F_(WF(w, COMPRESSION)); brakeTemp[w] = F_(WF(w, BRAKETEMP));
    Tyre& y = ty[w];
    y.kappa = F_(WF(w, KAPPA)); y.alpha = F_(WF(w, ALPHA)); y.surf = F_(WF(w, SURF)); y.core = F_(WF(w, CORE));
    y.pressure = F_(WF(w, PRESSURE)); y.wear = F_(WF(w, WEAR)); y.slipPower = F_(WF(w, SLIPPOWER));
    y.fx = F_(WF(w, FX)); y.fy = F_(WF(w, FY)); y.inner = F_(WF(w, INNER)); y.outer = F_(WF(w, OUTER)); y.util = F_(WF(w, UTIL));
  }
  const real cy = cos(yaw), sy = sin(yaw);
  const real u = vx * sy + vz * cy, v = vx * cy - vz * sy, speed = hypot(u, v);
  steering = dampr(steering, clampr(steerIn, -1, 1) * sp.steeringLock, 12, dt);
  real throttle = fuel > 0 ? clampr(throttleIn, 0, 1) : 0;
  const real brake = clampr(brakeIn, 0, 1);
  shiftTimer = rmax(shiftTimer - dt, (real)0);
  const real ratio = sp.gears[gear] * sp.finalDrive;
  const real target = clampr(fabs(u) / sp.radius * ratio * 9.5493, 1100 + throttle * 1500, 8300);
  rpm = dampr(rpm, target, 20, dt);
  const bool up = rpm > 7450;
  for (int pass = 0; pass < 2; pass++) {
    const bool want = pass == 0 ? up : (!up && rpm < 3450 && gear > 1);
    if (!want) continue;
    int next = gear + (pass == 0 ? 1 : -1); if (next < 1) next = 1; if (next > sp.maxGear) next = sp.maxGear;
    const real r2 = fabs(u) / sp.radius * sp.gears[next] * sp.finalDrive * 60 / (2 * PI_R);
    if (shiftTimer <= 0 && !(r2 > 8100) && next != gear) { gear = next; shiftTimer = .11; }
  }
  if (shiftTimer > 0 || rpm > 8100) throttle = 0;
  const real mass = sp.mass + fuel * .75, q = .5 * 1.225 * u * u, ride = .066 - heave;
  const real platform = clampr(1 - fabs(pitch) * 1.4 - rmax(.03 - ride, (real)0) * 14, .55, 1);
  const real downforce = q * sp.area * (sp.cl + (WING - 6) * .11) * platform * (1 - wake * .16);
  const real drag = q * sp.area * (sp.cd + (WING - 6) * .013) * (1 - wake * .42) * (1 + damage * .2);
  const real longT = clampr(ax, -22, 18) * mass * sp.cg / sp.wheelbase, latT = clampr(ay, -25, 25) * mass * sp.cg / sp.track;
  const real frontLoad = mass * 9.81 * sp.frontWeight - longT + downforce * sp.frontAero;
  const real rearLoad = mass * 9.81 * (1 - sp.frontWeight) + longT + downforce * sp.rearAero;
  const Surface center = track_surface(t, x, z, rubber, tempGrip, *node, 16);
  *node = center.p.node;
  real fx = 0, fz = -drag * signr(u), moment = -yawRate * 130;
  const real torqueCurve = clampr(1 - pow((rpm - 5500) / 6700, (real)2), .45, 1);
  const real drive = throttle * sp.maxTorque * torqueCurve * ratio * .91 * (1 - damage * .28);
  const real rearSlip = rmax(ty[2].kappa, ty[3].kappa);
  const real tc = clampr(1 - rmax(rearSlip - (.14 - TC_LEVEL * .009), (real)0) * TC_LEVEL * .7, .18, 1);
  for (int i = 0; i < 4; i++) {
    const bool front = i < 2;
    const real wxo = (i % 2 == 0 ? -1 : 1) * sp.track / 2, wzo = front ? (1 - sp.frontWeight) * sp.wheelbase : -sp.frontWeight * sp.wheelbase;
    wsteer[i] = 0;
    if (front && fabs(steering) > .0001) wsteer[i] = atan(sp.wheelbase / (sp.wheelbase / tan(steering) - wxo));
    const real ws = wsteer[i];
    const real wx = x + wxo * cy + wzo * sy, wz = z - wxo * sy + wzo * cy;
    const Surface su = track_surface(t, wx, wz, rubber, tempGrip, center.p.node, 12);
    const real axle = front ? frontLoad : rearLoad;
    const real targetLoad = rmax(axle / 2 - signr(wxo) * latT * (front ? .52 : .48), (real)0);
    const real spring = front ? sp.springFront : sp.springRear;
    const real targetComp = clampr(targetLoad / spring + su.bump * .3, 0, .12);
    compression[i] = dampr(compression[i], targetComp, 24, dt);
    const real load = rmax(targetLoad + (targetComp - compression[i]) * 16000, (real)0);
    loadw[i] = load;
    const real cs = cos(ws), sn = sin(ws);
    const real lvx = v + yawRate * wzo, lvz = u - yawRate * wxo;
    const real tvx = lvz * cs + lvx * sn, tvy = lvx * cs - lvz * sn;
    const real absF = speed > 3 ? clampr(1 + rmin(ty[i].kappa + .13, (real)0) * (4 + ABS_LEVEL), .06, 1) : 1;
    const real bias = front ? sp.brakeBias : 1 - sp.brakeBias;
    const real brakeTorque = brake * sp.brakeTorque * bias * absF;
    real wheelDrive = 0;
    if (!front) {
      const real diff = clampr((omega[i ^ 1] - omega[i]) * 12, -130, 130);
      const real engineBrake = throttle < .02 ? signr(u) * 22 * ratio : 0;
      wheelDrive = (drive + hybridForce * sp.radius) * tc * .5 + diff - engineBrake;
    }
    const real grip = su.grip * sp.tyreGrip;
    real avgFx = 0, avgFy = 0; const real h = dt / 4;
    for (int k = 0; k < 4; k++) {
      tyre_force(ty[i], tvx, tvy, omega[i], load, grip, h, sp.radius, ambient, compound);
      const real unbraked = omega[i] + (wheelDrive - ty[i].fx * sp.radius) / sp.wheelInertia * h;
      const real brakeStep = brakeTorque / sp.wheelInertia * h;
      omega[i] = clampr(signr(unbraked) * rmax(fabs(unbraked) - brakeStep, (real)0), -300, 520);
      avgFx += ty[i].fx / 4; avgFy += ty[i].fy / 4;
    }
    const real forceX = avgFy * cs + avgFx * sn, forceZ = avgFx * cs - avgFy * sn;
    fx += forceX; fz += forceZ - su.resistance * load * tanh(u * 2);
    moment += forceX * wzo - forceZ * wxo;
    brakeTemp[i] = clampr(brakeTemp[i] + (brakeTorque * fabs(omega[i]) * .00009 - (brakeTemp[i] - 24) * (.02 + speed * .0007)) * dt, 24, 1000);
    if (su.asphalt && load >= 10 && alive && layRubber) {
      const float cur = rubber[su.cell];
      const float next = (float)fmin(fmax((double)cur + (double)(dt * (.0005 + rmin(ty[i].slipPower, (real)30000) * .0000001)), 0.0), 1.0);
      atomicAdd(&rubber[su.cell], next - cur);
    }
  }
  ax = dampr(ax, fz / mass, 16, dt); ay = dampr(ay, fx / mass, 16, dt);
  vx += (fx * cy + fz * sy) / mass * dt; vz += (-fx * sy + fz * cy) / mass * dt;
  yawRate = clampr(yawRate + moment / sp.yawInertia * dt, -3, 3);
  if (speed < .6 && throttle < .02) { const real k = exp(-15 * dt); vx *= k; vz *= k; yawRate *= k; }
  yaw = yaw + yawRate * dt; yaw = atan2(sin(yaw), cos(yaw));
  x += vx * dt; z += vz * dt;
  roll = dampr(roll, clampr(ay * .0035, -.09, .09), 8, dt);
  pitch = dampr(pitch, clampr(-ax * .0028, -.06, .07), 9, dt);
  heave = dampr(heave, downforce / 310000, 10, dt);
  fuel = rmax(fuel - (.0007 + throttle * rpm / 7500 * .0045) * dt, (real)0);
  impact *= exp(-4 * dt);
  const real lat = center.p.lateral;
  if (fabs(lat) > t.barrier) {
    const real side = signr(lat), nx = center.p.nx, nz = center.p.nz, out = (vx * nx + vz * nz) * side, pen = fabs(lat) - t.barrier;
    x -= nx * side * pen; z -= nz * side * pen;
    if (out > 0) { vx -= nx * side * out * 1.1; vz -= nz * side * out * 1.1; damage = clampr(damage + out * .005, 0, 1); impact = clampr(out / 15, 0, 1); }
  }
  F_(X) = x; F_(Z) = z; F_(YAW) = yaw; F_(VX) = vx; F_(VZ) = vz; F_(YAWRATE) = yawRate; F_(U) = u; F_(V) = v; F_(SPEED) = speed;
  F_(AX) = ax; F_(AY) = ay; F_(ROLL) = roll; F_(PITCH) = pitch; F_(HEAVE) = heave; F_(STEERING) = steering; F_(GEAR) = gear;
  F_(RPM) = rpm; F_(SHIFT) = shiftTimer; F_(FUEL) = fuel; F_(DAMAGE) = damage; F_(IMPACT) = impact; F_(S) = center.p.s; F_(LATERAL) = lat;
  for (int w = 0; w < 4; w++) {
    F_(WF(w, OMEGA)) = omega[w]; F_(WF(w, COMPRESSION)) = compression[w]; F_(WF(w, LOAD)) = loadw[w]; F_(WF(w, BRAKETEMP)) = brakeTemp[w];
    F_(WF(w, WSTEER)) = wsteer[w];
    const Tyre& y = ty[w];
    F_(WF(w, KAPPA)) = y.kappa; F_(WF(w, ALPHA)) = y.alpha; F_(WF(w, FX)) = y.fx; F_(WF(w, FY)) = y.fy; F_(WF(w, SURF)) = y.surf;
    F_(WF(w, CORE)) = y.core; F_(WF(w, INNER)) = y.inner; F_(WF(w, OUTER)) = y.outer; F_(WF(w, PRESSURE)) = y.pressure;
    F_(WF(w, WEAR)) = y.wear; F_(WF(w, SLIPPOWER)) = y.slipPower; F_(WF(w, UTIL)) = y.util;
  }
  #undef F_
}
