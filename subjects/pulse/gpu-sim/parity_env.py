"""Parity of the GPU race layer (cuda_race.RaceLayer + CudaWorld flags) against reference-env.mjs, which
records the real scenario harness (EnduranceRace) on generated-field cases.
  python gpu-sim/parity_env.py --ref C:/pulse-store/parity/env-smoke [--dtype float32]
Teacher-forced: every tick the world state is the reference's; hybrid energy/mode, steward memory and rubber
run free. Checks hybrid force/energy/mode, ABS/TC flags, wakes and every decision's observation.
Exits 1 when a gate fails."""
import argparse, json, os, sys
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(__file__))
from cuda_sim import CudaWorld
from cuda_race import RaceLayer, MODES, COMPOUNDS

p = argparse.ArgumentParser()
p.add_argument('--ref', required=True)
p.add_argument('--dtype', default='float64')
p.add_argument('--max-obs', type=float, default=None, help='largest normalised observation error (default 1e-6 float64, 2e-3 float32)')
p.add_argument('--max-flips', type=float, default=None, help='share of observations allowed beyond --max-obs (default 0 f64, 2e-3 f32)')
a = p.parse_args()
dtype, dev = getattr(torch, a.dtype), 'cuda'
f64 = dtype == torch.float64
max_obs = a.max_obs if a.max_obs is not None else (1e-6 if f64 else 2e-3)
max_flips = a.max_flips if a.max_flips is not None else (0 if f64 else 2e-3)
meta = json.load(open(os.path.join(a.ref, 'meta.json')))
fields, S, N, DT, TK = meta['fields'], meta['steps'], meta['slots'], meta['dt'], meta['tick']
cases = [c for c in meta['cases'] if not c.get('rescued')]
keep = [k for k, c in enumerate(meta['cases']) if not c.get('rescued')]
C, F, T = len(cases), len(fields), len(TK)
ofields = meta['observation']['fields']; O = len(ofields)
load = lambda name: torch.from_numpy(np.fromfile(os.path.join(a.ref, name + '.f64')))
states = load('states').view(len(meta['cases']), S + 1, N, F)[keep].to(dev, dtype)
ticks = load('ticks').view(len(meta['cases']), S, N, T)[keep].to(dev, torch.float64)
obs_all = load('observations').view(-1, O)
starts = np.cumsum([0] + [len(d) for d in meta['decisions']])
col = {k: i for i, k in enumerate(TK)}

classes = [c['cars'][j]['classId'] if j < c['count'] else 'gt' for c in cases for j in range(N)]
names = sorted(set(classes))
MEDIUM = [1., 1., 90., .42, 1.65]
active = torch.tensor([[j < c['count'] for j in range(N)] for c in cases])
w = CudaWorld(classes, C, N, meta['trackGeometry'], dtype, [c['tempGrip'] for c in cases], [c['ambient'] for c in cases], active,
              [c['cars'][j]['tyre'] if j < c['count'] else MEDIUM for c in cases for j in range(N)])
w.rubber.copy_(torch.tensor([c['rubber'] for c in cases], dtype=torch.float32))
race = RaceLayer(w, names, meta['classes'])
for k, c in enumerate(cases):
    for j, car in enumerate(c['cars']):
        b = k * N + j
        if car['hybrid']: race.energy[b] = car['hybrid']['energy']; race.mode[b] = MODES.index(car['hybrid']['mode'])
        race.laps_left[b] = car['laps'] - car['lap'] + 1
        st = car['steward']; race.stw[b], race.stw[w.B + b], race.stw[2 * w.B + b] = int(st['moving']), int(st['off']), int(st['spun'])
        race.clean[b] = st['clean']
ego = torch.arange(C, device=dev, dtype=torch.int32) * N
track_temp = torch.tensor([c['trackTemperature'] for c in cases], dtype=dtype, device=dev)
compound = torch.tensor([COMPOUNDS.index(c['cars'][0]['compound']) for c in cases], dtype=torch.int32, device=dev)
ego0 = [c['cars'][0] for c in cases]
laps0 = torch.tensor([c['laps'] - c['lap'] + 1 for c in ego0], dtype=dtype, device=dev)
stint0 = torch.tensor([c['stintLaps'] for c in ego0], dtype=dtype, device=dev)
tyres0 = torch.tensor([c['nextTyreLap'] - c['lap'] if c['nextTyreLap'] is not None else c['laps'] - c['lap'] + 1 for c in ego0], dtype=dtype, device=dev)
scale = torch.tensor([f['scale'] for f in ofields], dtype=torch.float64)

err = {k: torch.zeros(C, dtype=torch.float64, device=dev) for k in ['force', 'energy', 'wake']}
mode_bad = flag_bad = 0
obs_err = []  # (case, tick, normalised error vector)
held = torch.zeros(C, 2, dtype=dtype, device=dev)
for t in range(S):
    w.load_state(states[:, t].reshape(C * N, F))
    u = ticks[:, t].reshape(C * N, T)
    alive = active.reshape(-1).to(dev)
    if t:
        w.wake.copy_(ticks[:, t - 1, :, col['wake']].reshape(-1))
    else:
        w.wake.zero_()
    # Decisions observed before this tick's step.
    rows = [(k, starts[keep[k]] + i) for k in range(C) for i, d in enumerate(meta['decisions'][keep[k]]) if d['tick'] == t]
    if rows:
        ks = [k for k, _ in rows]
        ref = obs_all[[r for _, r in rows]].to(dev)
        ctx = torch.zeros(C, 9, dtype=dtype, device=dev)
        ctx[:, 0:2] = 0; ctx[ks, 0] = ref[:, 10].to(dtype); ctx[ks, 1] = ref[:, 11].to(dtype)
        ctx[:, 2:4] = held; ctx[ks, 4] = ref[:, 14].to(dtype); ctx[ks, 5] = ref[:, 15].to(dtype)
        crossed = laps0 - race.laps_left.view(C, N)[:, 0].to(dtype)
        ctx[:, 6] = laps0 - crossed; ctx[:, 7] = stint0 + crossed; ctx[:, 8] = (tyres0 - crossed).clamp(min=0)
        race_time = torch.tensor([c['raceTime'] + t * DT for c in cases], dtype=torch.float64, device=dev)
        raw = race.observe(ego, ctx, track_temp, race_time, compound)[ks].double()
        e = ((raw - ref) / scale.to(dev)).abs()
        for i, k in enumerate(ks): obs_err.append((k, t, e[i]))
    controls = u[:, 0:3].to(dtype).contiguous()
    race.intent.copy_(torch.stack([u[:, col['intentDeploy']], u[:, col['intentHarvest']]], 1))
    force = race.hybrid(controls, DT)
    err['force'] = torch.maximum(err['force'], torch.nan_to_num((force.double() - u[:, col['hybridForce']]).abs() * alive).view(C, N).amax(1))
    err['energy'] = torch.maximum(err['energy'], torch.nan_to_num((race.energy - u[:, col['energy']]).abs() * alive).view(C, N).amax(1))
    has = u[:, col['mode']] >= 0
    mode_bad += ((race.mode.double() != u[:, col['mode']]) & has & alive).sum().item()
    w.step(DT, controls[:, 0], controls[:, 1], controls[:, 2], u[:, col['hybridForce']].to(dtype))
    err['wake'] = torch.maximum(err['wake'], torch.nan_to_num((w.wake.double() - u[:, col['wake']]).abs() * alive).view(C, N).amax(1))
    flags = w.flags.double()
    ref_flags = u[:, col['abs']] + 2 * u[:, col['tc']]
    flag_bad += ((flags != ref_flags) & alive).sum().item()
    held = torch.stack([u.view(C, N, T)[:, 0, col['steer']], u.view(C, N, T)[:, 0, col['throttle']] - u.view(C, N, T)[:, 0, col['brake']]], 1).to(dtype)
    w.load_state(states[:, t + 1].reshape(C * N, F))
    race.stewards(DT)
    # Laps: the reference's lap counter is observed through lapsLeft; follow s crossings of the line.
    s0, s1 = states[:, t, :, fields.index('s')].reshape(-1), states[:, t + 1, :, fields.index('s')].reshape(-1)
    race.laps_left -= ((s1 < s0 - meta['trackGeometry']['length'] / 2) & alive).int()

failures = []
print(f'race layer teacher-forced ({a.dtype}, {C} cases, {S} ticks):')
for k in err:
    print(f'  {k:8s} max {err[k].max().item():.3e}  worst case {err[k].argmax().item()}')
print(f'  mode mismatched car-ticks {mode_bad}, ABS/TC flag mismatched car-ticks {flag_bad}')
if f64 and (err['force'].max() > 1e-6 or err['energy'].max() > 1e-3 or mode_bad or flag_bad): failures.append('hybrid/flags')
E = torch.stack([e for _, _, e in obs_err]).cpu()
worst = E.amax(0)
print(f'  observations {len(obs_err)}: max normalised error {worst.max().item():.3e}')
for i in worst.argsort(descending=True)[:8].tolist():
    if worst[i] <= max_obs: break
    bad = (E[:, i] > max_obs).nonzero()[:, 0]
    k, t, _ = obs_err[bad[0].item()]
    print(f'    {ofields[i]["name"]:28s} max {worst[i].item():.3e}  rows {len(bad)}  first case {k} tick {t}')
flips = (E > max_obs).any(1).double().mean().item()
print(f'  observations beyond {max_obs:.0e}: {flips:.2e}')
if flips > max_flips: failures.append(f'observation flips {flips:.2e}')
print('PASS' if not failures else 'FAIL: ' + '; '.join(failures))
sys.exit(1 if failures else 0)
