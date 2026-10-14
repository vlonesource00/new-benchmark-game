"""Migration check: a v1 checkpoint and its v2 migration, driven on the same v2 rows, must act identically when no
rival is in range (solo) and may differ only when one is (v2 now sees it).
  python learner/test_contract.py --ckpt runs/tt-e2/snap-30-ema.pt
"""
import argparse
import json
import os
import tempfile

import numpy as np
import torch

from contract import layout_of, migrate_v1_v2, obs_len
from model import Slipstream
from ppo import ROOT, SUBJECT, RunningNorm, binary_columns
from vecenv import VecEnv


def load(ck, dev):
    lay = layout_of(ck)
    net = Slipstream(lay).to(dev).eval()
    net.load_state_dict(ck['model'])
    norm = RunningNorm(obs_len(lay), binary_columns(lay))
    norm.load(ck['norm'])
    return net, norm, obs_len(lay)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--ticks', type=int, default=3000)
    a = ap.parse_args()
    dev = torch.device('cuda')
    ck = torch.load(os.path.join(SUBJECT, a.ckpt), map_location=dev, weights_only=False)
    v2 = migrate_v1_v2(ck, [n for n, _ in Slipstream(layout_of(ck)).named_parameters()])
    ok = True
    for name, learners in (('solo', 1), ('pack', 4)):
        cfg = {'worlds': 2, 'seed': 7, 'substeps': 4, 'statsEvery': 600, 'tracks': ['harbor-ring', 'desert'], 'weathers': ['clear'],
               'world': {'learners': learners, 'ai': [], 'classId': 'gt', 'lifetime': 1e9, 'fuel': 60, 'latency': {'min': 1, 'max': 6},
                         'episode': {'min': 1e9, 'max': 1e9}, 'starts': {'snapshot': 0, 'failure': 0, 'standing': 1}}}
        fd, p = tempfile.mkstemp(suffix='.json')
        with os.fdopen(fd, 'w') as f:
            json.dump(cfg, f)
        env = VecEnv(ROOT, p, 1)
        E, N = env.obs_dim, env.n
        (na, ma, Da), (nb, mb, Db) = load(ck, dev), load(v2, dev)
        ha = hb = torch.zeros(N, na.hidden, device=dev)
        row, worst, worst_solo_rows, seen = env.reset(), 0.0, 0.0, 0
        with torch.no_grad():
            for _ in range(a.ticks):
                fi, de = torch.from_numpy(row[:, E + 3].copy()).to(dev), torch.from_numpy(row[:, E + 4].copy()).to(dev)
                mu_a, _, ha = na.step(torch.from_numpy(ma(row[:, :Da])).to(dev), ha, fi, de)
                mu_b, _, hb = nb.step(torch.from_numpy(mb(row[:, :Db])).to(dev), hb, fi, de)
                d = (mu_a - mu_b).abs().max(1).values.cpu().numpy()
                riv = row[:, Db - 8 * 13:Db:13].max(1) > 0.5  # v2 presence flags
                seen += int(riv.sum())
                worst = max(worst, float(d.max()))
                if (~riv).any():
                    worst_solo_rows = max(worst_solo_rows, float(d[~riv].max()))
                row = env.step(mu_a.cpu().numpy())
        env.close(); os.remove(p)
        good = worst_solo_rows < 1e-5 and (name == 'pack' or worst < 1e-5)
        ok &= good
        print(f'{"PASS" if good else "FAIL"} {name}: obs {E}, v1 reads {Da}, v2 reads {Db}; max |dmu| no rival {worst_solo_rows:.2e}, '
              f'any {worst:.2e}; rival-in-range rows {seen}')
    print('ALL PASS' if ok else 'FAILED')


if __name__ == '__main__':
    main()
