// Kernels for the PULSE driving stack (executor.cuh), one thread per executor car.
#include "executor.cuh"

#define TRACK_ARGS const double* tx_, const double* tz_, const double* ts_, const double* ttx_, const double* ttz_, const double* tc_, \
  int count, double length, double half, double curb, double runoff, double barrier, double laneWidth
#define MAKE_TRACK Track t; t.x = tx_; t.z = tz_; t.s = ts_; t.tx = ttx_; t.tz = ttz_; t.curv = tc_; t.count = count; \
  t.length = length; t.half = half; t.curb = curb; t.runoff = runoff; t.barrier = barrier; t.laneWidth = laneWidth;
#define EX_PARAMS const real* S, int B, int slots, const int* cls, const real* lineC, const double* ggv, int ggvW, const double* opt, \
  const real* tyres, const real* tempGrip, const unsigned char* alive, const unsigned char* ghost, const int* node, \
  const real* prevBrake, const real* wake, const int* exLane, int E, real* ex, double* xr, int* xi
#define MAKE_ARGS ExArgs A = { S, B, slots, cls, lineC, ggv, ggvW, opt, tyres, tempGrip, alive, ghost, node, prevBrake, wake, exLane, ex, xr, xi };

extern "C" __global__ void executor_layout(int* out) { out[0] = XR; out[1] = XI; out[2] = EX_ARRAYS; out[3] = OUT_W; out[4] = OPT_W; out[5] = LINE_KEYS; }

extern "C" __global__ void executor_init(EX_PARAMS, TRACK_ARGS) {
  const int e = blockIdx.x * blockDim.x + threadIdx.x; if (e >= E) return;
  MAKE_TRACK MAKE_ARGS
  executor_init_one(A, t, e);
}

// plans: [E, 4] the accepted action, planSeq: [E] its sequence, planAt: [E] its time. out: [E, OUT_W].
extern "C" __global__ void executor_step(EX_PARAMS, TRACK_ARGS, double time, double dt, const real* plans, const int* planSeq,
    const double* planAt, real* out) {
  const int e = blockIdx.x * blockDim.x + threadIdx.x; if (e >= E) return;
  MAKE_TRACK MAKE_ARGS
  executor_step_one(A, t, e, time, dt, plans + e * 4, planSeq[e], planAt[e], out + e * OUT_W);
}
