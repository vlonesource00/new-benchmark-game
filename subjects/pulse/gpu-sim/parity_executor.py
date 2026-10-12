"""Parity of the CUDA driving stack (cuda_executor.CudaExecutor) against reference-executor.mjs.
  python gpu-sim/parity_executor.py --ref C:/pulse-store/parity/exec-smoke [--dtype float32]
1. Teacher-forced: every tick the world state is the reference's; the executor's own state (course profile,
   lanes, observer history, controller memory) runs free. Compares its controls and internals per tick.
2. Closed loop: physics + executor run free from the first state (rivals replay their recorded inputs);
   reports the executor car's position drift.
Exits 1 when a gate fails."""
import argparse, json, os, sys
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(__file__))
from cuda_sim import CudaWorld
from cuda_executor import CudaExecutor, OUTPUTS

p = argparse.ArgumentParser()
p.add_argument('--ref', required=True)
p.add_argument('--dtype', default='float64')
p.add_argument('--max-control', type=float, default=None, help='largest steer/throttle/brake error (default 1e-9 float64, 2e-2 float32)')
p.add_argument('--max-discrete', type=int, default=None, help='allowed compile/path/cursor mismatch ticks (default 0 float64)')
p.add_argument('--max-flips', type=float, default=None, help='share of ticks whose controls differ by more than --max-control (default 0 float64, 1e-3 float32)')
p.add_argument('--max-drift', type=float, default=None, help='closed-loop position drift gate in m: max over cases (float64, default 1e-6), median (float32, default 1e-2)')
a = p.parse_args()
dtype, dev = getattr(torch, a.dtype), 'cuda'
f64 = dtype == torch.float64
max_control = a.max_control if a.max_control is not None else (1e-9 if f64 else 2e-2)
max_discrete = a.max_discrete if a.max_discrete is not None else (0 if f64 else 10 ** 9)
max_flips = a.max_flips if a.max_flips is not None else (0 if f64 else 1e-3)
max_drift = a.max_drift if a.max_drift is not None else (1e-6 if f64 else 1e-2)
meta = json.load(open(os.path.join(a.ref, 'meta.json')))
fields, S, N, C, DT = meta['fields'], meta['steps'], meta['slots'], len(meta['cases']), meta['dt']
F, O = len(fields), len(OUTPUTS)
load = lambda name: torch.from_numpy(np.fromfile(os.path.join(a.ref, name + '.f64'))).to(dev, dtype)
states, inputs = load('states').view(C, S + 1, N, F), load('inputs').view(C, S, N, 4)
outputs, wakes = load('outputs').view(C, S, O), load('wakes').view(C, S, N)
active = torch.tensor([[j < c['count'] for j in range(N)] for c in meta['cases']])
classes = [c['classIds'][j] if j < c['count'] else 'gt' for c in meta['cases'] for j in range(N)]
names = sorted(set(classes))
MEDIUM = [1., 1., 90., .42, 1.65]
tyres = [c['tyres'][j] if j < c['count'] else MEDIUM for c in meta['cases'] for j in range(N)]
lanes = [k * N for k in range(C)]

# Plan in force at every tick: [C, S] index into the case's plan list.
plan_rows = torch.zeros(C, S, 4, dtype=dtype); plan_seq = torch.zeros(C, S, dtype=torch.int32); plan_at = torch.zeros(C, S, dtype=torch.float64)
for k, c in enumerate(meta['cases']):
    j = -1
    for t in range(S):
        while j + 1 < len(c['plans']) and c['plans'][j + 1]['tick'] <= t: j += 1
        if j >= 0:
            pl = c['plans'][j]; plan_rows[k, t] = torch.tensor(pl['action'], dtype=dtype); plan_seq[k, t] = pl['sequence']; plan_at[k, t] = pl['tick'] * DT
plan_rows, plan_seq, plan_at = plan_rows.to(dev), plan_seq.to(dev), plan_at.to(dev)


def make():
    w = CudaWorld(classes, C, N, meta['trackGeometry'], dtype, [c['tempGrip'] for c in meta['cases']],
                  [c['ambient'] for c in meta['cases']], active, tyres)
    w.load_state(states[:, 0].reshape(C * N, F))
    x = CudaExecutor(w, meta['classes'], lanes, names)
    return w, x


def commit(x, t):
    x.plans.copy_(plan_rows[:, t]); x.plan_seq.copy_(plan_seq[:, t]); x.plan_at.copy_(plan_at[:, t])


failures = []
# 1. Teacher-forced.
w, x = make(); x.reset()
got = torch.zeros(C, S, O, dtype=dtype, device=dev)
for t in range(S):
    w.load_state(states[:, t].reshape(C * N, F))
    if t:
        x.prev_brake.copy_(inputs[:, t - 1, :, 1].reshape(-1)); x.wake.copy_(wakes[:, t - 1].reshape(-1).clamp(max=.95))
    commit(x, t)
    got[:, t] = x.step(t * DT, DT)[:, :O]
col = {k: i for i, k in enumerate(OUTPUTS)}
err = (got - outputs).abs()
print(f'executor teacher-forced ({a.dtype}, {C} cases, {S} ticks):')
for k in OUTPUTS:
    e = err[..., col[k]]
    if k in ('compiles', 'path', 'cursor'):
        bad = (e > .5).sum().item()
        print(f'  {k:13s} mismatched ticks {bad}')
        if bad > max_discrete: failures.append(f'{k} mismatched on {bad} ticks')
    else:
        print(f'  {k:13s} max {e.max().item():.3e}')
first = (err[..., [col['steer'], col['throttle'], col['brake']]].amax(-1) > max_control) | (err[..., [col['compiles'], col['path'], col['cursor']]].amax(-1) > .5)
for k in range(C):
    bad = first[k].nonzero()
    if len(bad):
        t = bad[0].item()
        print(f'  case {k} first divergence tick {t}: got {[round(v, 6) for v in got[k, t].tolist()]}')
        print(f'  {"":>{len(str(k)) + 5}} reference                {[round(v, 6) for v in outputs[k, t].tolist()]}')
# float32 rounding can flip the controller's own thresholds (drive kick, brake/throttle split) for a tick or two.
control = err[..., [col['steer'], col['throttle'], col['brake']]].amax(-1)
flips = (control > max_control).double().mean().item()
print(f'  controls beyond {max_control:.0e}: {flips:.2e} of ticks (p99.9 error {torch.quantile(control.flatten().double().cpu(), .999).item():.2e})')
if flips > max_flips: failures.append(f'control flips {flips:.2e} > {max_flips:.0e}')

# 2. Closed loop: the executor drives slot 0, rivals replay their recorded inputs.
w, x = make(); x.reset()
ex_lane = torch.tensor(lanes, device=dev)
drift = {}
for t in range(S):
    if t:
        # The executor's own executed brake from the previous tick (rivals: their recorded one).
        x.prev_brake.copy_(u[:, 1]); x.wake.copy_(w.wake.clamp(max=.95))
    commit(x, t)
    out = x.step(t * DT, DT)
    u = inputs[:, t].reshape(C * N, 4).clone()
    lon = (out[:, col['throttle']] - out[:, col['brake']]).clamp(-1, 1)
    u[ex_lane, 0], u[ex_lane, 1], u[ex_lane, 2] = lon.clamp(min=0), (-lon).clamp(min=0), out[:, col['steer']].clamp(-1, 1)
    w.step(DT, u[:, 0], u[:, 1], u[:, 2], u[:, 3])
    if t + 1 in (120, 360, 600, 1200, 2400):
        st, tr = w.state()[ex_lane], states[:, t + 1, 0]
        pos = torch.hypot(st[:, fields.index('x')] - tr[:, fields.index('x')], st[:, fields.index('z')] - tr[:, fields.index('z')])
        worst = pos.argmax().item(); dmg = states[worst, :, :, fields.index('damage')].amax(-1)
        hit = (dmg[1:] > dmg[:-1]).nonzero(); drift[t + 1] = (pos.max() if f64 else pos.median()).item()
        print(f'  closed loop {(t + 1) * DT:>4.0f} s  executor position median {pos.median().item():.2e} max {pos.max().item():.2e} m'
              f' (case {worst}, first reference contact {hit[0].item() * DT if len(hit) else None} s)')
# Closed-loop drift: float64 must track the reference exactly (max over cases, every checkpoint); float32
# rounding drifts chaotically after contacts, so its gate is the median.
for tick, d in drift.items():
    if d > max_drift: failures.append(f'closed-loop {"max" if f64 else "median"} drift {d:.2e} m > {max_drift:.0e} at {tick * DT:.0f} s')
print('PASS' if not failures else 'FAIL: ' + '; '.join(failures))
sys.exit(1 if failures else 0)
