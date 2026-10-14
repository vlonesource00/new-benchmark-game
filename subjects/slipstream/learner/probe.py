"""Episode probe: run a checkpoint on one worker and report how episodes start and end.

  python learner/probe.py --ckpt runs/tt-a1/model.pt --config configs/tt-smoke.json [--ticks 3000] [--det]
"""
import argparse
import json
import os
from collections import Counter, defaultdict

import numpy as np
import torch

from model import Slipstream
from ppo import ROOT, SUBJECT, RunningNorm, binary_columns
from vecenv import VecEnv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--config', required=True)
    ap.add_argument('--ticks', type=int, default=3000)
    ap.add_argument('--det', action='store_true')
    ap.add_argument('--workers', type=int, default=1)
    a = ap.parse_args()
    dev = torch.device('cuda')
    env = VecEnv(ROOT, os.path.abspath(os.path.join(SUBJECT, a.config)), a.workers)
    ck = torch.load(os.path.join(SUBJECT, a.ckpt), map_location=dev, weights_only=False)
    net = Slipstream(env.layout).to(dev)
    net.load_state_dict(ck['model'])
    norm = RunningNorm(env.obs_dim, binary_columns(env.layout))
    norm.load(ck['norm'])
    D, N = env.obs_dim, env.n
    row = env.reset()
    h = torch.zeros(N, net.hidden, device=dev)
    ep = [defaultdict(list) for _ in range(N)]
    out = []
    with torch.no_grad():
        for t in range(a.ticks):
            x = torch.from_numpy(norm(row[:, :D])).to(dev)
            first = torch.from_numpy(row[:, D + 3].copy()).to(dev)
            mu, v, h = net.step(x, h, first, torch.from_numpy(row[:, D + 4].copy()).to(dev))
            act = mu if a.det else mu + net.log_std.exp() * torch.randn_like(mu)
            act = act.cpu().numpy()
            for i in range(N):
                if row[i, D + 3] > 0.5:
                    ep[i] = defaultdict(list)
                e = ep[i]
                e['speed'].append(float(row[i, 5] * 50))
                e['pedal'].append(float(np.clip(act[i, 1], -1, 1)))
                e['steer'].append(float(np.clip(act[i, 0], -1, 1)))
                e['lat'].append(float(row[i, 15]))
                e['v'].append(float(v[i]))
                if row[i, D + 1] > 0.5 or row[i, D + 2] > 0.5:
                    sp = e['speed']
                    out.append({'end': 'done' if row[i, D + 1] > 0.5 else 'trunc', 'len': len(sp), 'v0': round(sp[0], 1), 'vmax': round(max(sp), 1),
                                'vlast': round(sp[-1], 1), 'pedal_last2s': round(float(np.mean(e['pedal'][-60:])), 2),
                                'steer_last2s': round(float(np.mean(np.abs(e['steer'][-60:]))), 2), 'lat_last': round(e['lat'][-1], 2),
                                'slow_from': next((k for k in range(len(sp) - 1, -1, -1) if sp[k] > 2), -1), 'v_last': round(e['v'][-1], 2)})
            row = env.step(act)
    import time; time.sleep(0.5)
    why = Counter()
    for rec in env.take_stats():
        why.update({f"w{rec.get('w')}:{k}": c for k, c in rec.get('why', {}).items()})
    print('worker why:', dict(why))
    env.close()
    stuck = [o for o in out if o['end'] == 'done' and o['vlast'] < 2]
    print(json.dumps({'episodes': len(out), 'stuck': len(stuck), 'ends': Counter(o['end'] for o in out)}))
    print('standing-start stuck (v0<1):', sum(o['v0'] < 1 for o in stuck), ' never moved (vmax<2):', sum(o['vmax'] < 2 for o in stuck))
    for o in stuck[:14]:
        print(o)


if __name__ == '__main__':
    main()
