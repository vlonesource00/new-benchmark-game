// Kernels of the race layer (race.cuh) over a CudaWorld's state.
#include "race.cuh"

#define TRACK_ARGS const double* tx_, const double* tz_, const double* ts_, const double* ttx_, const double* ttz_, const double* tc_, \
  int count, double length, double half, double curb, double runoff, double barrier, double laneWidth
#define MAKE_TRACK Track t; t.x = tx_; t.z = tz_; t.s = ts_; t.tx = ttx_; t.tz = ttz_; t.curv = tc_; t.count = count; \
  t.length = length; t.half = half; t.curb = curb; t.runoff = runoff; t.barrier = barrier; t.laneWidth = laneWidth;

// controls: [B, 3] throttle, brake, steer of this tick. intent: [B, 2] deploy, harvest (NaN: none). hyMap per class: [offset, n] into maps (offset < 0: no hybrid).
extern "C" __global__ void hybrid(const real* Sv, int B, int slots, const int* cls, const int* hyMap, const float* maps, double length,
    const real* controls, double* energy, int* mode, const int* lapsLeft, const double* intent, double dt, real* force) {
  const int c = blockIdx.x * blockDim.x + threadIdx.x; if (c >= B) return;
  const int off = hyMap[2 * cls[c]];
  if (off < 0) { force[c] = 0; return; }
  force[c] = hybrid_one(Sv, B, slots, c, cls, maps + off, hyMap[2 * cls[c] + 1], length, (double)controls[3 * c], (double)controls[3 * c + 1],
    energy + c, mode + c, lapsLeft[c], dt, intent[2 * c], intent[2 * c + 1]);
}

extern "C" __global__ void stewards(const real* Sv, int B, const unsigned char* alive, TRACK_ARGS, unsigned char* stw, real* cleanT, real dt) {
  const int c = blockIdx.x * blockDim.x + threadIdx.x; if (c >= B || !alive[c]) return;
  MAKE_TRACK
  steward_one(Sv, B, c, t, stw, cleanT, dt);
}

// One observation per environment, of the car in lane egoLane[e].
// ctx: [E, 9] previous steer/longitudinal, held steer/longitudinal, dt, actionAge, lapsLeft, stintLaps, lapsToTyres.
extern "C" __global__ void observe(const real* Sv, int B, int slots, const int* cls, const double* classInfo, TRACK_ARGS,
    const float* rubber, int cells, const real* tempGrip, const int* node, const unsigned char* alive, const unsigned char* ghost,
    const unsigned char* flags, const double* energy, const unsigned char* stw, const real* wake, const real* tyres,
    const int* egoLane, int E, const real* ctx, const real* trackTemperature, const double* raceTime, const int* compound, real* raw) {
  const int e = blockIdx.x * blockDim.x + threadIdx.x; if (e >= E) return;
  MAKE_TRACK
  const int c = egoLane[e], env = c / slots;
  EgoContext x; const real* q = ctx + 9 * e;
  x.previous[0] = q[0]; x.previous[1] = q[1]; x.held[0] = q[2]; x.held[1] = q[3]; x.dt = q[4]; x.actionAge = q[5];
  x.lapsLeft = q[6]; x.stintLaps = q[7]; x.lapsToTyres = q[8]; x.trackTemperature = trackTemperature[env]; x.raceTime = (real)raceTime[env];
  x.compound = compound[env];
  observe_one(Sv, B, slots, c, cls, classInfo, t, rubber + (size_t)env * cells, tempGrip[env], node, alive, ghost, flags, energy, stw, wake,
    tyres, x, raw + (size_t)e * OBS_SIZE);
}

extern "C" __global__ void race_layout(int* out) { out[0] = OBS_SIZE; }
