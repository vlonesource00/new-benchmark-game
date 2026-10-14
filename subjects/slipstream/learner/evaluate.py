"""Time-trial evaluation: uninterrupted runs, deterministic policy, reply latency on, laps scored by the game.

  python learner/evaluate.py --ckpt runs/tt-a3/model.pt [--config configs/eval-solo.json] [--laps 3]

Each world runs one learner from a standing start with no horizon; the first (partial) lap is invalid by
construction, then every lap is judged by the game's own timing (purple/green/yellow = clean).
A wreck (terminal episode end) restarts that car from a standing start and is counted per track.
Stops when every track has `--laps` clean laps, or at --max-sim seconds.
"""
import argparse
import json
import os
from collections import defaultdict

import numpy as np
import torch

from contract import layout_of, obs_len
from model import Slipstream
from ppo import ROOT, SUBJECT, RunningNorm, binary_columns
from vecenv import VecEnv

REF = {'harbor-ring': 61.05, 'solenne': 59.18, 'alpine': 71.23, 'desert': 77.22, 'nurburgring': 512.02}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--config', default='configs/eval-solo.json')
    ap.add_argument('--laps', type=int, default=3)
    ap.add_argument('--max-sim', type=float, default=1800)
    a = ap.parse_args()
    dev = torch.device('cuda')
    env = VecEnv(ROOT, os.path.abspath(os.path.join(SUBJECT, a.config)), 1)
    ck = torch.load(os.path.join(SUBJECT, a.ckpt), map_location=dev, weights_only=False)
    lay = layout_of(ck)  # the checkpoint's own input contract: it reads only its own columns
    net = Slipstream(lay).to(dev).eval()
    net.load_state_dict(ck['model'])
    norm = RunningNorm(obs_len(lay), binary_columns(lay))
    norm.load(ck['norm'])
    D, N = env.obs_dim, env.n
    tracks = [w['track'] for w in env.hs[0]['worlds'] for _ in range(w['agents'])]
    laps, inc, why, wl = defaultdict(list), 0, defaultdict(int), []
    row = env.reset()
    h = torch.zeros(N, net.hidden, device=dev)
    wrecks = np.zeros(N, int)
    ticks = int(a.max_sim * 30)
    with torch.no_grad():
        for t in range(ticks):
            wrecks += (row[:, D + 1] > 0.5)
            x = torch.from_numpy(norm(row[:, :obs_len(lay)])).to(dev)
            mu, _, h = net.step(x, h, torch.from_numpy(row[:, D + 3].copy()).to(dev), torch.from_numpy(row[:, D + 4].copy()).to(dev))
            row = env.step(mu.cpu().numpy())
            if t % 300 == 299:
                for s in env.take_stats():
                    inc += s.get('inc', 0)
                    for k, c in s.get('why', {}).items():
                        why[k] += c
                    wl += s.get('wrecks', [])
                    for trk, ls in s.get('laps', {}).items():
                        laps[trk] += ls
                if all(len(laps[trk]) >= a.laps for trk in tracks):
                    break
    env.close()
    out = {'ckpt': a.ckpt, 'sim_s': round((t + 1) / 30, 1), 'incidents': inc, 'ends': dict(why), 'wreck_sites': sorted(wl), 'tracks': {}}
    for trk in dict.fromkeys(tracks):
        ls = laps.get(trk, [])
        best = min(ls) if ls else None
        out['tracks'][trk] = {'clean_laps': len(ls), 'best': best, 'median': float(np.median(ls)) if ls else None,
                              'ref': REF.get(trk), 'gap_pct': round(100 * (best / REF[trk] - 1), 2) if best and trk in REF else None,
                              'wrecks': int(sum(wrecks[i] for i, x in enumerate(tracks) if x == trk))}
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
