"""Rollout-cut regression at network level.  python learner/test_boundary.py

Cutting a stream of rows into rollouts must not change anything the learner sees: the bootstrap value at a cut (row T,
busy or not) must equal the value the next rollout computes for that same row, the carried memory must equal the
uncut stream's, and the update's sequence pass must reproduce collection's values and memory exactly.
"""
import numpy as np
import torch

from model import Slipstream
from ppo import collect_step

torch.manual_seed(0)
rng = np.random.default_rng(0)
layout = {'ego': 48, 'roadK': 24, 'roadF': 6, 'rivalN': 8, 'rivalF': 13}
D = 48 + 24 * 6 + 8 * 13
net = Slipstream(layout).double().eval()
N, L = 5, 90
X = torch.from_numpy(rng.normal(size=(L, N, D)))
X[:, :, 48 + 144::13] = torch.from_numpy((rng.random((L, N, 8)) < 0.4).astype(float))  # presence flags
first = torch.from_numpy((rng.random((L, N)) < 0.03).astype(float))
dec = torch.from_numpy((rng.random((L, N)) < 0.65).astype(float))
dec[first > 0] = 1
ok = True
with torch.no_grad():
    # One uncut stream.
    h, vs, hs = torch.zeros(N, 256, dtype=torch.float64), [], []
    for t in range(L):
        _, v, h = collect_step(net, X[t], h, first[t], dec[t])
        vs.append(v); hs.append(h)
    # Cut into rollouts of T = 30 (with T + 1 rows each, row T = bootstrap), several cuts land on busy rows.
    T, h, worst_v, worst_h, busy_cuts = 30, torch.zeros(N, 256, dtype=torch.float64), 0.0, 0.0, 0
    for s0 in range(0, L - T, T):
        h0 = h.clone()
        for t in range(T + 1):
            _, v, hn = collect_step(net, X[s0 + t], h, first[s0 + t], dec[s0 + t])
            worst_v = max(worst_v, (v - vs[s0 + t]).abs().max().item())
            if t == T:
                busy_cuts += int((dec[s0 + T] < 0.5).sum())
                break
            h = hn
        worst_h = max(worst_h, (h - hs[s0 + T - 1]).abs().max().item())
        # The update recomputes the same rollout as a sequence from h0.
        mu_s, v_s = net.sequence(X[s0:s0 + T], h0, first[s0:s0 + T], dec[s0:s0 + T])
        worst_v = max(worst_v, (v_s - torch.stack(vs[s0:s0 + T])).abs().max().item())
ok = worst_v < 1e-9 and worst_h < 1e-9 and busy_cuts > 0
print(f'cut vs uncut: max |dV| {worst_v:.2e}, max |dh| {worst_h:.2e}, busy cuts tested {busy_cuts}')
print('PASS' if ok else 'FAIL')
