// Kernels for a batch of race environments (E envs x N slots, lane = env * N + slot).
// The tick follows core/race.js: wakes from pre-tick positions, each car's physics,
// then the engine's pairwise collisions in i<j order (one thread per environment,
// so the JS sequence is reproduced exactly).
#include "physics.cuh"

#define SPEC_WIDTH (21 + MAX_GEARS + 1)

__device__ Spec load_spec(const double* table, int k) {
  const double* p = table + k * SPEC_WIDTH; Spec s;
  s.mass = p[0]; s.wheelbase = p[1]; s.track = p[2]; s.cg = p[3]; s.frontWeight = p[4]; s.yawInertia = p[5]; s.radius = p[6];
  s.wheelInertia = p[7]; s.maxTorque = p[8]; s.finalDrive = p[9]; s.steeringLock = p[10]; s.area = p[11]; s.cd = p[12]; s.cl = p[13];
  s.brakeTorque = p[14]; s.brakeBias = p[15]; s.tyreGrip = p[16]; s.frontAero = p[17]; s.springFront = p[18]; s.springRear = p[19]; s.rearAero = p[20];
  for (int g = 0; g < MAX_GEARS; g++) s.gears[g] = p[21 + g];
  s.maxGear = (int)p[21 + MAX_GEARS];
  return s;
}

#define TRACK_ARGS const double* tx_, const double* tz_, const double* ts_, const double* ttx_, const double* ttz_, const double* tc_, \
  int count, double length, double half, double curb, double runoff, double barrier, double laneWidth
#define MAKE_TRACK Track t; t.x = tx_; t.z = tz_; t.s = ts_; t.tx = ttx_; t.tz = ttz_; t.curv = tc_; t.count = count; \
  t.length = length; t.half = half; t.curb = curb; t.runoff = runoff; t.barrier = barrier; t.laneWidth = laneWidth;

// inputs: [B, 5] throttle, brake, steer, wake, hybridForce. rubber: [envs, cells] float32. tyres: [B, 5] compound.
// slot < 0: every car at once. slot >= 0: only that slot of every environment; launching slots 0..N-1 in turn
// reproduces race.js exactly, where a car reads the rubber laid earlier in the same tick by the cars before it.
extern "C" __global__ void step_cars(real* S, int B, int slots, const int* cls, const double* specs, TRACK_ARGS,
    float* rubber, int cells, const real* inputs, const real* tempGrip, const real* ambient, const unsigned char* alive,
    int layRubber, int* node, const real* tyres, real dt, int slot) {
  const int n = blockIdx.x * blockDim.x + threadIdx.x;
  if (slot >= 0 ? n >= B / slots : n >= B) return;
  const int c = slot >= 0 ? n * slots + slot : n;
  MAKE_TRACK
  const Spec sp = load_spec(specs, cls[c]); const int env = c / slots;
  const real* in = inputs + c * 5, *ty = tyres + c * 5;
  const Compound k = { ty[0], ty[1], ty[2], ty[3], ty[4] };
  vehicle_step(S, B, c, sp, t, rubber + (size_t)env * cells, dt, in[0], in[1], in[2], in[3], in[4], tempGrip[env], ambient[env],
    alive[c] != 0, layRubber != 0, node + c, k);
}

// Global nearest node of every car (start of an episode).
extern "C" __global__ void locate(const real* S, int B, TRACK_ARGS, int* node) {
  const int c = blockIdx.x * blockDim.x + threadIdx.x; if (c >= B) return;
  MAKE_TRACK
  node[c] = track_nearest(t, S[X * B + c], S[Z * B + c], -1, 0).node;
}

// wake[c] for every car (vehicle.js wakes), from positions before the tick.
extern "C" __global__ void wakes(const real* S, int B, int slots, const unsigned char* alive, real* wake) {
  const int c = blockIdx.x * blockDim.x + threadIdx.x; if (c >= B) return;
  const int base = c / slots * slots; real w = 0;
  for (int k = 0; k < slots; k++) {
    const int o = base + k; if (o == c || !alive[o]) continue;
    const real dx = S[X * B + c] - S[X * B + o], dz = S[Z * B + c] - S[Z * B + o], yo = S[YAW * B + o];
    const real behind = -(dx * sin(yo) + dz * cos(yo)), lateral = fabs(dx * cos(yo) - dz * sin(yo));
    if (behind > 1.5 && behind < 110) {
      const real cone = 2.4 + behind * 0.050;
      if (lateral < cone) { const real taper = 1 - (lateral / cone) * (lateral / cone); w = rmax(w, exp(-behind / 55) * taper); }
    }
  }
  wake[c] = w;
}

// vehicle.js collisions for one environment per thread. closing: [envs, pairs] (0 where no contact).
extern "C" __global__ void collisions(real* S, int B, int slots, int envs, const int* cls, const double* specs,
    const unsigned char* alive, const unsigned char* ghost, real* closingOut) {
  const int e = blockIdx.x * blockDim.x + threadIdx.x; if (e >= envs) return;
  const int pairs = slots * (slots - 1) / 2; int pair = 0;
  for (int i = 0; i < slots; i++) for (int j = i + 1; j < slots; j++, pair++) {
    const int a = e * slots + i, b = e * slots + j;
    closingOut[e * pairs + pair] = 0;
    if (!alive[a] || !alive[b]) continue;
    #define A_(k) S[(k) * B + a]
    #define B_(k) S[(k) * B + b]
    const real dx = B_(X) - A_(X), dz = B_(Z) - A_(Z);
    if (dx * dx + dz * dz > 28 || (ghost[a] && ghost[b])) continue;
    const real ar[2] = { cos(A_(YAW)), -sin(A_(YAW)) }, af[2] = { sin(A_(YAW)), cos(A_(YAW)) };
    const real br[2] = { cos(B_(YAW)), -sin(B_(YAW)) }, bf[2] = { sin(B_(YAW)), cos(B_(YAW)) };
    const real* axes[4] = { ar, af, br, bf };
    real depth = (real)1e30, nx = 0, nz = 0; bool separated = false;
    for (int k = 0; k < 4; k++) {
      const real* ax = axes[k];
      #define DOT(v) fabs(ax[0] * v[0] + ax[1] * v[1])
      const real proj = dx * ax[0] + dz * ax[1];
      const real overlap = 0.98 * (DOT(ar) + DOT(br)) + 2.28 * (DOT(af) + DOT(bf)) - fabs(proj);
      #undef DOT
      if (overlap <= 0) { separated = true; break; }
      if (overlap < depth) { depth = overlap; const real sign = proj > 0 ? 1 : proj < 0 ? -1 : 1; nx = ax[0] * sign; nz = ax[1] * sign; }
    }
    if (separated) continue;
    const real ma = specs[cls[a] * SPEC_WIDTH], mb = specs[cls[b] * SPEC_WIDTH];
    const real shareA = mb / (ma + mb), shareB = ma / (ma + mb);
    A_(X) -= nx * depth * shareA; A_(Z) -= nz * depth * shareA; B_(X) += nx * depth * shareB; B_(Z) += nz * depth * shareB;
    const real closing = (A_(VX) - B_(VX)) * nx + (A_(VZ) - B_(VZ)) * nz;
    if (closing > 0) {
      const real impulse = closing * 1.1 / (1 / ma + 1 / mb);
      const real dA = ma == mb ? closing * .55 : impulse / ma, dB = ma == mb ? closing * .55 : impulse / mb;
      A_(VX) -= nx * dA; A_(VZ) -= nz * dA; B_(VX) += nx * dB; B_(VZ) += nz * dB;
      A_(DAMAGE) = clampr(A_(DAMAGE) + closing * 0.003, 0, 1); B_(DAMAGE) = clampr(B_(DAMAGE) + closing * 0.003, 0, 1);
      A_(IMPACT) = B_(IMPACT) = clampr(closing / 12, 0, 1);
      closingOut[e * pairs + pair] = closing;
    }
    #undef A_
    #undef B_
  }
}
