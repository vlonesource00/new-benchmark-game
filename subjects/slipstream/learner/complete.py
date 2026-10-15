"""Completion evaluation: N seeded attempts per track, each must run three consecutive valid laps without a wreck or reset.

  python learner/complete.py --ckpt runs/tt-b2/model.pt [--attempts 10] [--laps 3] [--tracks alpine,nurburgring] [--name x]

One learner per world (no traffic), standing start at a seeded random place, fixed full tank, deterministic policy,
browser-faithful timing (reply latency, memory steps only on decide rows). The first line crossing ends a partial lap
and is ignored; after it every lap must be judged clean by the game (purple/green/yellow) until `--laps` are done.
An attempt fails at its first invalid lap or its first terminal episode end (off track > 2 s, damage, backwards,
stuck, DQ); the car is never reset mid-attempt. Same --seed = same starts, latency draws and conditions for every
checkpoint, so checkpoints compare like for like.
"""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from collections import defaultdict

import numpy as np
import torch

from evaluate import REF
from contract import layout_of, obs_len
from model import Slipstream, SlipstreamMoE
from ppo import ROOT, SUBJECT, RunningNorm, binary_columns
from vecenv import VecEnv

TRACKS = ['harbor-ring', 'solenne', 'alpine', 'desert', 'nurburgring']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--attempts', type=int, default=10)
    ap.add_argument('--laps', type=int, default=3)
    ap.add_argument('--tracks', default=','.join(TRACKS))
    ap.add_argument('--seed', type=int, default=101)
    ap.add_argument('--workers', type=int, default=1)
    ap.add_argument('--name', default='')
    ap.add_argument('--latency', default='uniform', choices=['uniform', 'frames'],
                    help='uniform: the original 1-6 substep reply delay (continuity with earlier results); '
                         'frames: the measured browser model (one frame of 1/2/3/4/8 substeps per attempt)')
    ap.add_argument('--ai', default='', help='traffic test: AI seats racing in every attempt, e.g. intercept,apex')
    ap.add_argument('--pole', action='store_true', help='with --grid: the learner starts from pole, the AI seats behind it '
                    '(as the game seats SLIPSTREAM first), instead of shuffled slots')
    ap.add_argument('--grid', action='store_true', help='traffic test: start from the race grid (shuffled slots) with the AI '
                    'seats, standing, as a real race start; the attempt counts the same laps and failures')
    ap.add_argument('--noise', default='', help='diagnostic: drive with Gaussian action noise of this std per action '
                    '(steer,pedal), as training samples it (e.g. 0.06,0.10); empty = the deterministic mean action')
    a = ap.parse_args()
    tracks = a.tracks.split(',')
    latency = {'min': 1, 'max': 6, 'longP': 0.03, 'longMin': 8, 'longMax': 30} if a.latency == 'uniform' else \
        {'frames': [[1, 0.3], [2, 0.35], [3, 0.1], [4, 0.15], [8, 0.1]], 'extraP': 0.05, 'longP': 0.01, 'longMin': 8, 'longMax': 30}
    cfg = {'worlds': len(tracks) * a.attempts // a.workers, 'seed': a.seed, 'substeps': 4, 'statsEvery': 60, 'tracks': tracks, 'weathers': ['clear'],
           'world': {'learners': 1, 'ai': [], 'classId': 'gt', 'lifetime': 1e9, 'fuel': 60,
                     'latency': latency,
                     'episode': {'min': 1e9, 'max': 1e9}, 'starts': {'snapshot': 0, 'failure': 0, 'standing': 1}}}
    if a.ai:
        cfg['world']['ai'] = a.ai.split(',')
    if a.grid:
        cfg['world']['gridOrder'] = 'fixed' if a.pole else 'shuffle'
        cfg['world']['starts']['grid'] = 1
    assert cfg['worlds'] * a.workers == len(tracks) * a.attempts, 'attempts x tracks must split evenly over workers'
    fd, cfg_path = tempfile.mkstemp(suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(cfg, f)
    dev = torch.device('cuda')
    env = VecEnv(ROOT, cfg_path, a.workers)
    ck = torch.load(os.path.join(SUBJECT, a.ckpt), map_location=dev, weights_only=False)
    lay = layout_of(ck)  # the checkpoint's own input contract: it reads only its own columns
    net = (SlipstreamMoE(lay) if 'moe' in ck else Slipstream(lay)).to(dev).eval()
    net.load_state_dict(ck['model'])
    norm = RunningNorm(obs_len(lay), binary_columns(lay))
    norm.load(ck['norm'])
    D, N = env.obs_dim, env.n
    track_of = [w['track'] for hs in env.hs for w in hs['worlds'] for _ in range(w['agents'])]
    cap = {t: int(30 * ((a.laps + 1.6) * REF[t])) for t in tracks}  # out-lap + laps at ~1.4x reference pace
    att = [{'track': track_of[i], 'status': 'running', 'why': None, 'cross': 0, 'laps': [], 'at_s': None} for i in range(N)]
    row = env.reset()
    h = torch.zeros(N, net.hidden, device=dev)
    tick = 0

    def absorb():
        evs = []
        for s in env.take_stats():
            base = int(env.offsets[s.get('w', 0)]) if 'w' in s else 0
            evs += [('lap', base + e[0], e[1], e) for e in s.get('lapEv', [])]
            evs += [('end', base + e[0], e[1], e) for e in s.get('endEv', [])]
        for kind, i, _, e in sorted(evs, key=lambda x: x[2]):
            r = att[i]
            if r['status'] != 'running':
                continue
            if kind == 'end':
                r['status'], r['why'], r['at_s'] = 'fail', e[2], e[3]
                continue
            r['cross'] += 1
            if r['cross'] == 1:
                continue  # partial lap from the standing start
            r['laps'].append(e[3] if e[2] else None)
            if not e[2]:
                r['status'], r['why'] = 'fail', f'invalid lap ({e[4]})'
                r['cut_s'] = e[5] if len(e) > 5 else None
            elif len(r['laps']) >= a.laps:
                r['status'] = 'success'

    noise = torch.tensor([float(v) for v in a.noise.split(',')]) if a.noise else None
    gen = torch.Generator().manual_seed(a.seed)
    with torch.no_grad():
        while True:
            x = torch.from_numpy(norm(row[:, :obs_len(lay)])).to(dev)
            mu, _, h = net.step(x, h, torch.from_numpy(row[:, D + 3].copy()).to(dev), torch.from_numpy(row[:, D + 4].copy()).to(dev))
            if noise is not None:
                mu = mu + noise * torch.randn(mu.shape, generator=gen).to(dev)
            row = env.step(mu.cpu().numpy())
            tick += 1
            if tick % 60 == 0:
                absorb()
                for r in att:
                    if r['status'] == 'running' and tick > cap[r['track']] + 180:
                        r['status'], r['why'] = 'fail', 'timeout'
                if a.name:  # progress for the viewer's job bar
                    d = os.path.join(SUBJECT, 'runs', 'completion')
                    os.makedirs(d, exist_ok=True)
                    with open(os.path.join(d, f'{a.name}.progress.json'), 'w') as f:
                        json.dump({'done': sum(r['status'] != 'running' for r in att), 'total': len(att), 'complete': sum(r['status'] == 'success' for r in att), 'sim_s': round(tick / 30)}, f)
                if all(r['status'] != 'running' for r in att):
                    break
    env.close()
    os.remove(cfg_path)
    # Identity of what ran: checkpoint bytes, source revision, world random streams (2 = one generator per world).
    with open(os.path.join(SUBJECT, a.ckpt), 'rb') as f:
        sha = hashlib.sha256(f.read()).hexdigest()[:12]
    try:
        rev = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=SUBJECT, capture_output=True, text=True).stdout.strip()
    except OSError:
        rev = ''
    out = {'ckpt': a.ckpt, 'ckpt_sha': sha, 'rev': rev, 'rngv': 2, 'noise': a.noise, 'seed': a.seed, 'latency': a.latency, 'ai': a.ai, 'grid': a.grid, 'pole': a.pole, 'attempts': a.attempts, 'laps': a.laps, 'sim_s': round(tick / 30), 'tracks': {}}
    for t in tracks:
        rs = [r for r in att if r['track'] == t]
        clean = [x for r in rs for x in r['laps'] if x]
        why = defaultdict(int)
        for r in rs:
            if r['status'] == 'fail':
                why[r['why']] += 1
        out['tracks'][t] = {'complete': sum(r['status'] == 'success' for r in rs), 'of': len(rs),
                            'median_valid': round(float(np.median(clean)), 3) if clean else None, 'best': min(clean) if clean else None,
                            'gap_median_pct': round(100 * (np.median(clean) / REF[t] - 1), 2) if clean else None,
                            'fails': dict(why), 'fail_sites': sorted(r['at_s'] for r in rs if r['at_s'] is not None),
                            'cut_sites': sorted(r['cut_s'] for r in rs if r.get('cut_s') is not None)}
    out['complete_total'] = sum(v['complete'] for v in out['tracks'].values())
    print(json.dumps(out))
    if a.name:
        d = os.path.join(SUBJECT, 'runs', 'completion')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{a.name}.json'), 'w') as f:
            json.dump({**out, 'attempt_log': att}, f, indent=1)


if __name__ == '__main__':
    main()
