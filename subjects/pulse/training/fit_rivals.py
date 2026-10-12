"""Distil the real AI rivals (APEX, RAZOR, TEMPEST, Gemini v4) into plan-space policies for the GPU environment.

Recordings (tools/record-rivals.mjs) hold each rival's PULSE-schema observation from its own seat at 30 Hz. Labels
are hindsight plans in the executor's contract: the rival's realised offset from its class racing line 30/70/120 m
further along its own path (/ offsetMetres), and a speed cap from its speed 30 m on ((v - ceiling) / span). The GPU
executor then drives each rival along the intentions its real driver showed: lane choice, door closing, defence,
lifting in traffic. Request-context and strategy fields are masked (rivals have no request transport).
  python training/fit_rivals.py --records C:/pulse-store/rivals/r02 --bank C:/pulse-store/scenes/c186-train --out artifacts/rivals/r02-mlp
"""
import argparse, json, os, sys
from pathlib import Path
import numpy as np
import torch
from torch import nn
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from checkpoint_state import atomic_json

DRIVERS = ['apex', 'razor', 'tempest', 'gemini-supreme-v4']
MASK = list(range(10, 16)) + list(range(20, 24)) + list(range(34, 39))  # request context; laps/stint/tyre/pit call; compound (per env on GPU)
COLUMNS = 8


class RivalPolicy(nn.Module):
    def __init__(self, size, drivers=len(DRIVERS), width=256):
        super().__init__()
        self.size, self.drivers = size, drivers
        self.register_buffer('keep', torch.ones(size))
        self.keep[MASK] = 0
        self.net = nn.Sequential(nn.Linear(size + drivers, width), nn.ELU(), nn.Linear(width, width), nn.ELU(),
                                 nn.Linear(width, width), nn.ELU(), nn.Linear(width, 4), nn.Tanh())

    def forward(self, obs, driver):
        return self.net(torch.cat([obs * self.keep, nn.functional.one_hot(driver, self.drivers).to(obs.dtype)], 1))


def load_rivals(path):
    """A fitted rival policy on CUDA, with .names (driver ids) for GpuEnv(rivals=...)."""
    ck = torch.load(Path(path) / 'model.pt', map_location='cpu', weights_only=True)
    model = RivalPolicy(ck['size'], len(ck['drivers'])).cuda().eval()
    model.load_state_dict(ck['weights'], strict=True)
    model.names = ck['drivers']
    return model


def labels(rows, line_s, line_lat, length, contract):
    """rows of one rival in time order -> (plan labels [n, 4], valid [n])."""
    prog, s, lat, speed = rows[:, 4].astype(np.float64), rows[:, 5].astype(np.float64), rows[:, 6].astype(np.float64), rows[:, 7].astype(np.float64)
    ref = np.interp(np.mod(s, length), line_s, line_lat, period=length)
    e = lat - ref
    out, valid = np.zeros((len(rows), 4), np.float32), np.ones(len(rows), bool)
    for k, d in enumerate(contract['distances']):
        j = np.searchsorted(prog, prog + d)
        valid &= j < len(rows)
        j = np.minimum(j, len(rows) - 1)
        out[:, k] = np.clip(e[j] / contract['offsetMetres'], -1, 1)
    j = np.minimum(np.searchsorted(prog, prog + 30), len(rows) - 1)
    out[:, 3] = np.clip((speed[j] - contract['speedCeiling']) / contract['speedSpan'], -1, 0)
    return out, valid


def load(records, bank):
    meta = json.load(open(Path(bank) / 'meta.json'))
    contract, length = meta['planContract'], meta['trackGeometry']['length']
    lines = {c: (np.array(v['line']['st']), np.array(v['line']['lat'])) for c, v in meta['classes'].items()}
    data = []
    for f in sorted(Path(records).glob('*.json')):
        m = json.load(open(f))
        if m['format'] != 'pulse-rival-record-v2':
            continue
        if abs(m['trackLength'] - length) > 1e-3:
            raise ValueError('Recording track differs from the bank')
        a = np.fromfile(f.with_suffix('.f32'), dtype=np.float32).reshape(-1, m['width'])
        for r in m['rivals']:
            x = a[a[:, 0] == r['index']]
            if len(x) < 60 or r['driver'] not in DRIVERS:
                continue
            if r['hazard']:  # scripted from stopAt on: only the driver's own driving before it
                x = x[x[:, 1] < r['stopAt'] - .5]
                if len(x) < 60:
                    continue
            y, ok = labels(x, *lines[r['classId']], length, contract)
            data.append({'case': m['case'], 'driver': DRIVERS.index(r['driver']), 'obs': x[ok, COLUMNS:], 'y': y[ok]})
    return data, contract


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--records', required=True); p.add_argument('--bank', required=True); p.add_argument('--out', required=True)
    p.add_argument('--steps', type=int, default=20000); p.add_argument('--lr', type=float, default=1e-3); p.add_argument('--seed', type=int, default=1)
    a = p.parse_args()
    out = Path(a.out)
    if out.exists():
        raise ValueError('Preserve ' + str(out))
    torch.manual_seed(a.seed); rng = np.random.default_rng(a.seed)
    data, contract = load(a.records, a.bank)
    cases = sorted({d['case'] for d in data}); rng.shuffle(cases)
    held = set(cases[:max(1, len(cases) // 10)])
    def stack(part):
        xs = [d for d in data if (d['case'] in held) == part]
        return (torch.from_numpy(np.concatenate([d['obs'] for d in xs])).cuda(), torch.from_numpy(np.concatenate([d['y'] for d in xs])).cuda(),
                torch.cat([torch.full((len(d['obs']),), d['driver'], dtype=torch.long) for d in xs]).cuda())
    (xt, yt, dt), (xv, yv, dv) = stack(False), stack(True)
    model = RivalPolicy(xt.shape[1]).cuda()
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, a.steps)
    def evaluate():
        model.eval()
        with torch.no_grad():
            err = (model(xv, dv) - yv).abs()
        model.train()
        res = {'mae': [round(v, 4) for v in err.mean(0).tolist()],
               'metres': [round(v * contract['offsetMetres'], 3) for v in err[:, :3].mean(0).tolist()], 'speedKmh': round(err[:, 3].mean().item() * contract['speedSpan'] * 3.6, 2)}
        res['byDriver'] = {DRIVERS[k]: round(err[dv == k, :3].mean().item() * contract['offsetMetres'], 3) for k in range(len(DRIVERS)) if (dv == k).any()}
        return res
    base = {'metresPredictZero': [round(v * contract['offsetMetres'], 3) for v in yv[:, :3].abs().mean(0).tolist()]}
    print(json.dumps({'train': len(xt), 'held': len(xv), 'heldCases': len(held), **base}), flush=True)
    for step in range(1, a.steps + 1):
        i = torch.randint(len(xt), (2048,), device='cuda')
        loss = (model(xt[i], dt[i]) - yt[i]).square().mean()
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if step % 5000 == 0 or step == a.steps:
            print(json.dumps({'step': step, 'loss': round(loss.item(), 5), 'held': evaluate()}), flush=True)
    out.mkdir(parents=True)
    torch.save({'format': 'pulse-rival-policy-v1', 'weights': model.state_dict(), 'size': xt.shape[1], 'drivers': DRIVERS, 'mask': MASK}, out / 'model.pt')
    atomic_json(out / 'metadata.json', {'records': a.records, 'bank': a.bank, 'drivers': DRIVERS, 'mask': MASK, 'contract': contract,
                                        'train': len(xt), 'held': len(xv), 'heldCases': sorted(held), 'evaluation': evaluate(), **base, 'arguments': vars(a)})


if __name__ == '__main__':
    main()
