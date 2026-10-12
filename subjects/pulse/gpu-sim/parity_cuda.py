"""Parity of the CUDA kernels against a JS reference (single-car reference.mjs or
reference-pack.mjs), plus throughput.
  python gpu-sim/parity_cuda.py --ref C:/pulse-store/parity/pack-v1 [--dtype float32]"""
import argparse, json, os, sys, time
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(__file__))
from cuda_sim import CudaWorld

p = argparse.ArgumentParser()
p.add_argument('--ref', required=True)
p.add_argument('--dtype', default='float64')
p.add_argument('--top', type=int, default=8)
p.add_argument('--bench', type=int, default=0, help='environments for a throughput run (0: skip)')
a = p.parse_args()
dtype, dev = getattr(torch, a.dtype), 'cuda'
meta = json.load(open(os.path.join(a.ref, 'meta.json')))
fields, S, C = meta['fields'], meta['steps'], len(meta['cases'])
F = len(fields)
pack = 'slots' in meta
N = meta['slots'] if pack else 1
load = lambda name: torch.from_numpy(np.fromfile(os.path.join(a.ref, name + '.f64'))).to(dev, dtype)
states = load('states').view(C, S + 1, N, F)
inputs = load('inputs').view(C, S, N, -1)
if pack:
    active = torch.tensor([[j < c['count'] for j in range(N)] for c in meta['cases']])
    classes = [c['classIds'][j] if j < c['count'] else 'gt' for c in meta['cases'] for j in range(N)]
else:
    active = torch.ones(C, 1, dtype=torch.bool)
    classes = [c['classId'] for c in meta['cases']]
mask = active.reshape(-1).to(dev)
make = lambda: CudaWorld(classes, C, N, meta['trackGeometry'], dtype, [c['tempGrip'] for c in meta['cases']],
                         [c['ambient'] for c in meta['cases']], active)
yaw = fields.index('yaw')


def step(w, t):
    u = inputs[:, t].reshape(C * N, -1)
    if pack:
        return w.step(meta['dt'], u[:, 0], u[:, 1], u[:, 2], u[:, 3])
    return w.step(meta['dt'], u[:, 0], u[:, 1], u[:, 2], u[:, 4], wake=u[:, 3])


def err(pred, truth):
    e = (pred - truth).abs()
    d = pred[:, yaw] - truth[:, yaw]
    e[:, yaw] = torch.atan2(torch.sin(d), torch.cos(d)).abs()
    return e[mask]


w = make()
w.lay_rubber = meta.get('rubber', True)
worst = torch.zeros(F, device=dev, dtype=dtype)
scale = states.reshape(-1, F).abs().amax(0).clamp(min=1e-9)
miss = 0
contacts = load('contacts').view(C, S) if pack else None
for t in range(S):
    w.load_state(states[:, t].reshape(C * N, F))
    closing = step(w, t)
    if pack:
        miss += ((closing > 0).sum(1) != contacts[:, t]).sum().item()
    worst = torch.maximum(worst, err(w.state(), states[:, t + 1].reshape(C * N, F)).amax(0))
order = (worst / scale).argsort(descending=True)
print(f'CUDA teacher-forced ({a.dtype}, {C} envs x {N} slots, {S} steps)' + (f', contact-count mismatches {miss}' if pack else ''))
for k in order[:a.top].tolist():
    print(f'  {fields[k]:22s} {worst[k].item():.3e}  rel {worst[k].item() / scale[k].item():.2e}')
w = make()
w.lay_rubber = meta.get('rubber', True)
w.load_state(states[:, 0].reshape(C * N, F))
col = {f: k for k, f in enumerate(fields)}
for t in range(S):
    step(w, t)
    if t + 1 in (120, 360, 1200):
        st, tr = w.state()[mask], states[:, t + 1].reshape(C * N, F)[mask]
        pos = torch.hypot(st[:, col['x']] - tr[:, col['x']], st[:, col['z']] - tr[:, col['z']])
        print(f'  free-run {(t + 1) / 120:>4.0f} s  position median {pos.median().item():.2e} p90 {pos.quantile(.9).item():.2e} max {pos.max().item():.2e} m')

if a.bench:
    E = a.bench
    src = states[:, 0].reshape(C * N, F)
    idx = torch.arange(E * N) % (C * N)
    bw = CudaWorld([classes[i] for i in idx.tolist()], E, N, meta['trackGeometry'], dtype, active=active.reshape(-1)[idx].view(E, N))
    bw.load_state(src[idx.to(dev)])
    u = torch.full((E * N,), .6, device=dev, dtype=dtype); z = torch.zeros_like(u)
    for _ in range(20): bw.step(1 / 120, u, z, z, z)
    torch.cuda.synchronize(); t0 = time.time()
    for _ in range(200): bw.step(1 / 120, u, z, z, z)
    torch.cuda.synchronize(); dt = (time.time() - t0) / 200
    print(f'throughput {a.dtype}: {E} envs x {N} slots, {dt * 1e3:.3f} ms/tick, {E * N / dt / 1e6:.1f} M car-steps/s, {E / dt / 120:.0f} env-seconds/s')
