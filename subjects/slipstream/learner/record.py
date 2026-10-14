"""Record a replay for the viewer: one world, a checkpoint driving its learner seats, real AIs optional.

  python learner/record.py --ckpt runs/tt-a4/model.pt --track alpine [--ai intercept,apex] [--learners 1]
                           [--seconds 300] [--start standing|random|failure] [--stochastic] [--name alpine-1]

Writes runs/<run>/replays/<name>.json: track geometry, every car per decision tick (game state and the
controls actually applied), and per learner the policy's raw action, value estimate, reward and episode flags.
"""
import argparse
import json
import os
import tempfile

import numpy as np
import torch

from model import Slipstream
from ppo import ROOT, SUBJECT, RunningNorm, binary_columns
from vecenv import VecEnv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--track', default='harbor-ring')
    ap.add_argument('--ai', default='')
    ap.add_argument('--learners', type=int, default=1)
    ap.add_argument('--seconds', type=float, default=300)
    ap.add_argument('--weather', default='clear')
    ap.add_argument('--seed', type=int, default=11)
    ap.add_argument('--standing', type=float, default=1.0)
    ap.add_argument('--stochastic', action='store_true')
    ap.add_argument('--name', default='')
    a = ap.parse_args()
    ck_path = os.path.join(SUBJECT, a.ckpt)
    run_dir = os.path.dirname(ck_path)
    name = a.name or f'{a.track}-{os.path.splitext(os.path.basename(a.ckpt))[0]}'
    out_dir = os.path.join(run_dir, 'replays')
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{name}.json')
    raw_path = out_path + '.raw'
    cfg = {'worlds': 1, 'seed': a.seed, 'substeps': 4, 'statsEvery': 100000, 'tracks': [a.track], 'weathers': [a.weather], 'record': raw_path,
           'world': {'learners': a.learners, 'ai': [x for x in a.ai.split(',') if x], 'classId': 'gt', 'lifetime': 100000,
                     'latency': {'min': 1, 'max': 6, 'longP': 0.03, 'longMin': 8, 'longMax': 30},
                     'episode': {'min': 100000, 'max': 100000}, 'starts': {'snapshot': 0, 'standing': a.standing}}}
    fd, cfg_path = tempfile.mkstemp(suffix='.json', dir=out_dir)
    with os.fdopen(fd, 'w') as f:
        json.dump(cfg, f)
    dev = torch.device('cuda')
    env = VecEnv(ROOT, cfg_path, 1)
    ck = torch.load(ck_path, map_location=dev, weights_only=False)
    net = Slipstream(env.layout).to(dev).eval()
    net.load_state_dict(ck['model'])
    norm = RunningNorm(env.obs_dim, binary_columns(env.layout))
    norm.load(ck['norm'])
    D, N = env.obs_dim, env.n
    row = env.reset()
    h = torch.zeros(N, net.hidden, device=dev)
    pol = []  # per tick: per agent [mu_steer, mu_pedal, act_steer, act_pedal, value, reward, done, trunc, first]
    with torch.no_grad():
        for t in range(int(a.seconds * 30)):
            x = torch.from_numpy(norm(row[:, :D])).to(dev)
            mu, v, h = net.step(x, h, torch.from_numpy(row[:, D + 3].copy()).to(dev), torch.from_numpy(row[:, D + 4].copy()).to(dev))
            act = mu + net.log_std.exp() * torch.randn_like(mu) if a.stochastic else mu
            m, ac, vv = mu.cpu().numpy(), act.cpu().numpy(), v.cpu().numpy()
            pol.append([[round(float(m[i, 0]), 3), round(float(m[i, 1]), 3), round(float(ac[i, 0]), 3), round(float(ac[i, 1]), 3), round(float(vv[i]), 3),
                         round(float(row[i, D]), 4), int(row[i, D + 1]), int(row[i, D + 2]), int(row[i, D + 3])] for i in range(N)])
            row = env.step(ac)
    env.close()
    os.remove(cfg_path)
    with open(raw_path) as f:
        rec = json.load(f)
    os.remove(raw_path)
    # Worker frame k is recorded after step k; the policy row k was computed on the observation before it.
    rec['policy'] = pol[:len(rec['frames'])]
    rec['meta'] = {'ckpt': a.ckpt, 'track': a.track, 'ai': cfg['world']['ai'], 'learners': a.learners, 'stochastic': a.stochastic,
                   'policyFields': ['muSteer', 'muPedal', 'actSteer', 'actPedal', 'value', 'reward', 'done', 'trunc', 'first'],
                   'carFields': ['x', 'z', 'yaw', 'speed', 'steer', 'throttle', 'brake', 's', 'lateral', 'damage', 'offtrack', 'inc', 'ghost'],
                   'agentFields': ['car', 'sentSteer', 'sentPedal', 'pending', 'appliedAge', 'ending']}
    with open(out_path, 'w') as f:
        json.dump(rec, f, separators=(',', ':'))
    print(json.dumps({'replay': os.path.relpath(out_path, SUBJECT), 'frames': len(rec['frames']), 'mb': round(os.path.getsize(out_path) / 1e6, 2)}))


if __name__ == '__main__':
    main()
