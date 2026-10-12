"""Multi-car parity of gpu_sim.World against reference-pack.mjs.
  python gpu-sim/parity_pack.py --ref C:/pulse-store/parity/pack-smoke [--dtype float32]"""
import argparse, json, os, sys
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(__file__))
from gpu_sim import Track, World

p = argparse.ArgumentParser()
p.add_argument('--ref', required=True)
p.add_argument('--dtype', default='float64')
p.add_argument('--device', default='cuda')
p.add_argument('--top', type=int, default=10)
a = p.parse_args()
dtype, dev = getattr(torch, a.dtype), a.device
meta = json.load(open(os.path.join(a.ref, 'meta.json')))
fields, S, N, C = meta['fields'], meta['steps'], meta['slots'], len(meta['cases'])
F = len(fields)
load = lambda name, *shape: torch.from_numpy(np.fromfile(os.path.join(a.ref, name + '.f64')).reshape(*shape)).to(dev, dtype)
states, inputs = load('states', C, S + 1, N * F).view(C, S + 1, N, F), load('inputs', C, S, N, 4)
wakes, contacts = load('wakes', C, S, N), load('contacts', C, S)
active = torch.tensor([[j < c['count'] for j in range(N)] for c in meta['cases']], device=dev)
classes = [c['classIds'][j] if j < c['count'] else 'gt' for c in meta['cases'] for j in range(N)]
track = Track(meta['trackGeometry'], dev, dtype)
make = lambda: rubber(World(classes, C, N, track, dev, dtype, [c['tempGrip'] for c in meta['cases']], [c['ambient'] for c in meta['cases']], active))
yaw = fields.index('yaw')


def rubber(w):
    w.cars.lay_rubber = meta.get('rubber', True)
    return w


mask = active.reshape(-1)


def err(pred, truth):
    e = (pred - truth).abs()
    d = pred[:, yaw] - truth[:, yaw]
    e[:, yaw] = torch.atan2(torch.sin(d), torch.cos(d)).abs()
    return e[mask]


def step(w, t):
    u = inputs[:, t].reshape(C * N, 4)
    return w.step(meta['dt'], u[:, 0], u[:, 1], u[:, 2], u[:, 3])


w = make()
worst = torch.zeros(F, device=dev, dtype=dtype)
wake_err, contact_miss = 0., 0
scale = states.reshape(-1, F).abs().amax(0).clamp(min=1e-9)
for t in range(S):
    w.cars.load_state(states[:, t].reshape(C * N, F), fields)
    wake_err = max(wake_err, (w.wakes().view(C, N) - wakes[:, t])[active].abs().max().item())
    closing = step(w, t)
    contact_miss += ((closing > 0).sum(1) != contacts[:, t]).sum().item()
    worst = torch.maximum(worst, err(w.cars.state(fields), states[:, t + 1].reshape(C * N, F)).amax(0))
order = (worst / scale).argsort(descending=True)
print(f'pack teacher-forced ({a.dtype}, {C} packs, {int(active.sum())} cars, {S} steps): wake error {wake_err:.2e}, '
      f'contact-count mismatches {contact_miss} of {int(contacts.sum())} contact ticks')
for k in order[:a.top].tolist():
    print(f'  {fields[k]:22s} {worst[k].item():.3e}  rel {worst[k].item() / scale[k].item():.2e}')
w = make()
w.cars.load_state(states[:, 0].reshape(C * N, F), fields)
col = {f: k for k, f in enumerate(fields)}
for t in range(S):
    step(w, t)
    if t + 1 in (120, 360, 1200):
        st, tr = w.cars.state(fields)[mask], states[:, t + 1].reshape(C * N, F)[mask]
        pos = torch.hypot(st[:, col['x']] - tr[:, col['x']], st[:, col['z']] - tr[:, col['z']])
        print(f'  free-run {(t + 1) / 120:>4.0f} s  position median {pos.median().item():.2e} p90 {pos.quantile(.9).item():.2e} max {pos.max().item():.2e} m')
