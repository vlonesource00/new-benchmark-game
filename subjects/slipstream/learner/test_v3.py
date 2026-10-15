"""Contract v2 -> v3 migration test: a migrated network (plain or MoE) computes exactly what the v2 network did, on v3
rows whose race-context block holds arbitrary values (its new inputs have zero weights; float rounding aside), and its
optimizer state loads.
  python learner/test_v3.py --ckpt runs/tt-sn4/snap-20-ema.pt [--ckpt runs/tt-moe4a/final-ema.pt ...]
"""
import argparse
import os

import numpy as np
import torch

from contract import V3, layout_of, migrate_v2_v3, obs_len
from model import Slipstream, SlipstreamMoE
from ppo import SUBJECT, RunningNorm, binary_columns, opt_names


def build(ck):
    lay = layout_of(ck)
    net = (SlipstreamMoE(lay) if 'moe' in ck else Slipstream(lay)).eval()
    net.load_state_dict(ck['model'])
    norm = RunningNorm(obs_len(lay), binary_columns(lay))
    norm.load(ck['norm'])
    return net, norm, obs_len(lay)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', action='append', required=True)
    ap.add_argument('--steps', type=int, default=300)
    a = ap.parse_args()
    ok = True
    for path in a.ckpt:
        ck = torch.load(os.path.join(SUBJECT, path), map_location='cpu', weights_only=False)
        v3 = migrate_v2_v3(ck, opt_names(layout_of(ck), ck))
        (n2, z2, D2), (n3, z3, D3) = build(ck), build(v3)
        assert D3 == obs_len(V3) and D3 > D2
        if 'opt' in v3:  # Adam state shapes match the migrated parameters
            opt = torch.optim.Adam([p for p in n3.parameters() if p.requires_grad], lr=1e-4)
            opt.load_state_dict(v3['opt'])
        rng = np.random.default_rng(1)
        raw = (z2.mean + np.sqrt(z2.var) * rng.normal(size=(a.steps, D2))).astype(np.float32)
        raw[:, binary_columns(layout_of(ck))] = (rng.random((a.steps, 8)) < 0.5)
        extra = rng.integers(-1, 2, size=(a.steps, D3 - D2)).astype(np.float32)  # arbitrary race context
        raw3 = np.concatenate([raw, extra], 1)
        h2, h3 = torch.zeros(1, n2.hidden), torch.zeros(1, n3.hidden)
        worst = 0.0
        with torch.no_grad():
            for t in range(a.steps):
                f, d = torch.tensor([1.0 if t == 0 else 0.0]), torch.tensor([1.0 if t % 3 else 0.0])
                m2, v2, h2 = n2.step(torch.from_numpy(z2(raw[t:t + 1])), h2, f, d)
                m3, v3_, h3 = n3.step(torch.from_numpy(z3(raw3[t:t + 1])), h3, f, d)
                worst = max(worst, (m2 - m3).abs().max().item(), (v2 - v3_).abs().max().item(), (h2 - h3).abs().max().item())
        passed = worst < 1e-4  # zero-weight columns change only the float summation order of the input layers
        ok &= passed
        print(f"{'PASS' if passed else 'FAIL'} {path} ({'moe' if 'moe' in ck else 'plain'}) v2 {D2} -> v3 {D3} cols, max |diff| {worst:.2e}")
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
