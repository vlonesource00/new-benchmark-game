"""Parity of gpu_sim against the JS reference recorded by reference.mjs.
  python gpu-sim/parity.py --ref C:/pulse-store/parity/ref-smoke [--dtype float32]
Teacher-forced: every step starts from the exact JS state; reports the worst
per-field error after one step. Free-run: the port drives itself from the
first JS state with the recorded inputs; reports position/speed/yaw drift.
"""
import argparse, json, os, sys
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(__file__))
from gpu_sim import Track, Cars

p = argparse.ArgumentParser()
p.add_argument('--ref', required=True)
p.add_argument('--dtype', default='float64')
p.add_argument('--device', default='cuda')
p.add_argument('--top', type=int, default=15)
a = p.parse_args()
dtype = getattr(torch, a.dtype)
meta = json.load(open(os.path.join(a.ref, 'meta.json')))
F, S, C = len(meta['fields']), meta['steps'], len(meta['cases'])
states = torch.from_numpy(np.fromfile(os.path.join(a.ref, 'states.f64')).reshape(C, S + 1, F))
inputs = torch.from_numpy(np.fromfile(os.path.join(a.ref, 'inputs.f64')).reshape(C, S, len(meta['inputs']))).to(a.device, dtype)
track = Track(meta['trackGeometry'], a.device, dtype)
make = lambda: Cars([c['classId'] for c in meta['cases']], track, a.device, dtype,
                    [c['tempGrip'] for c in meta['cases']], [c['ambient'] for c in meta['cases']])
fields = meta['fields']
angle_cols = [fields.index('yaw')]
ref_dev = states.to(a.device, dtype)


def err(pred, truth):
    e = (pred - truth).abs()
    for k in angle_cols:
        d = pred[:, k] - truth[:, k]
        e[:, k] = torch.atan2(torch.sin(d), torch.cos(d)).abs()
    return e


def step(cars, t):
    u = inputs[:, t]
    cars.step(meta['dt'], u[:, 0], u[:, 1], u[:, 2], u[:, 3], u[:, 4])


# Teacher-forced one-step error (rubber evolves inside the port from forced states).
cars = make()
worst = torch.zeros(F, device=a.device, dtype=dtype)
where = torch.zeros(F, 2, dtype=torch.long)
scale = ref_dev.abs().amax((0, 1)).clamp(min=1e-9)
for t in range(S):
    cars.load_state(ref_dev[:, t], fields)
    step(cars, t)
    e = err(cars.state(fields), ref_dev[:, t + 1])
    m, i = e.max(0)
    better = m > worst
    worst = torch.where(better, m, worst)
    where[better.cpu(), 0] = i.cpu()[better.cpu()]
    where[better.cpu(), 1] = t
order = (worst / scale).argsort(descending=True)
print(f'teacher-forced one-step ({a.dtype}, {C} cases x {S} steps): worst absolute error, relative to field range')
for k in order[:a.top].tolist():
    print(f'  {fields[k]:22s} {worst[k].item():.3e}  rel {worst[k].item() / scale[k].item():.2e}  case {where[k, 0].item()} step {where[k, 1].item()}')

# Free run from the first JS state.
cars = make()
cars.load_state(ref_dev[:, 0], fields)
col = {f: k for k, f in enumerate(fields)}
report = {}
for t in range(S):
    step(cars, t)
    for sec in (1, 3, 10):
        if t + 1 == round(sec / meta['dt']):
            st, tr = cars.state(fields), ref_dev[:, t + 1]
            pos = torch.hypot(st[:, col['x']] - tr[:, col['x']], st[:, col['z']] - tr[:, col['z']])
            spd = (st[:, col['speed']] - tr[:, col['speed']]).abs()
            yaw = err(st, tr)[:, col['yaw']]
            report[sec] = {k: [v.median().item(), v.quantile(.9).item(), v.max().item()] for k, v in
                           [('position_m', pos), ('speed_mps', spd), ('yaw_rad', yaw)]}
print('free-run drift [median, p90, max]:')
for sec, r in report.items():
    print(f'  {sec:>2} s  ' + '  '.join(f'{k} {v[0]:.2e}/{v[1]:.2e}/{v[2]:.2e}' for k, v in r.items()))
