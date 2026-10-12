"""Throughput of physics + the CUDA driving stack: every car in every environment is driven by its own executor.
  python gpu-sim/bench_executor.py --ref C:/pulse-store/parity/exec-v1 --envs 8192 [--dtype float32] [--ticks 600]
Environments are tiled from the reference's starting states and plans; reports car-steps/s for physics alone and
for physics + executors (plan decoding and the policy network are not included)."""
import argparse, json, os, sys, time
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(__file__))
from cuda_sim import CudaWorld
from cuda_executor import CudaExecutor, OUTPUTS

p = argparse.ArgumentParser()
p.add_argument('--ref', required=True)
p.add_argument('--envs', type=int, default=8192)
p.add_argument('--dtype', default='float32')
p.add_argument('--ticks', type=int, default=600)
a = p.parse_args()
dtype, dev = getattr(torch, a.dtype), 'cuda'
meta = json.load(open(os.path.join(a.ref, 'meta.json')))
fields, S, N, C, DT = meta['fields'], meta['steps'], meta['slots'], len(meta['cases']), meta['dt']
F = len(fields)
states = torch.from_numpy(np.fromfile(os.path.join(a.ref, 'states.f64'))).view(C, S + 1, N, F)[:, 0]
pick = [k % C for k in range(a.envs)]
cases = [meta['cases'][k] for k in pick]
MEDIUM = [1., 1., 90., .42, 1.65]
classes = [c['classIds'][j] if j < c['count'] else 'gt' for c in cases for j in range(N)]
names = sorted(set(classes))
w = CudaWorld(classes, a.envs, N, meta['trackGeometry'], dtype, [c['tempGrip'] for c in cases], [c['ambient'] for c in cases],
              torch.tensor([[j < c['count'] for j in range(N)] for c in cases]),
              [c['tyres'][j] if j < c['count'] else MEDIUM for c in cases for j in range(N)])
start = states[pick].reshape(a.envs * N, F)
w.load_state(start)
lanes = [e * N + j for e, c in enumerate(cases) for j in range(c['count'])]
x = CudaExecutor(w, meta['classes'], lanes, names)
x.reset()
plans = torch.tensor([c['plans'][0]['action'] for c in cases for j in range(c['count'])], dtype=dtype, device=dev)
x.plans.copy_(plans); x.plan_seq.fill_(1)
lane = torch.tensor(lanes, device=dev)
zero = torch.zeros(w.B, device=dev, dtype=dtype)
col = {k: i for i, k in enumerate(OUTPUTS)}


def run(ticks, drive):
    u = torch.zeros(w.B, 3, device=dev, dtype=dtype)
    torch.cuda.synchronize(); t0 = time.perf_counter()
    for t in range(ticks):
        if drive:
            x.wake.copy_(w.wake.clamp(max=.95)); x.prev_brake.copy_(u[:, 1])
            out = x.step(t * DT, DT)
            lon = (out[:, col['throttle']] - out[:, col['brake']]).clamp(-1, 1)
            u[lane, 0], u[lane, 1], u[lane, 2] = lon.clamp(min=0), (-lon).clamp(min=0), out[:, col['steer']]
        w.step(DT, u[:, 0], u[:, 1], u[:, 2], zero)
    torch.cuda.synchronize()
    return time.perf_counter() - t0


run(5, True)  # compile + warm
w.load_state(start); x.reset()
cars = len(lanes)
for drive in (False, True):
    w.load_state(start); x.reset()
    s = run(a.ticks, drive)
    print(f'{a.dtype} {a.envs} envs, {cars} cars, {a.ticks} ticks: {"physics + executors" if drive else "physics only      "} '
          f'{cars * a.ticks / s / 1e6:6.2f} M car-steps/s ({s / a.ticks * 1e3:.2f} ms/tick)')
dmg = w.state()[lane, fields.index('damage')]
print(f'after {a.ticks * DT:.0f} s driven: mean damage {dmg.mean().item():.3f}, cars over 10% {(dmg > .1).float().mean().item():.1%}')
