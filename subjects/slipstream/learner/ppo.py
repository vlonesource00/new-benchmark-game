"""Recurrent PPO baseline for SLIPSTREAM (the learner is swappable; QR-SAC etc. can replace this file).

  python learner/ppo.py --config configs/tt.json --name tt-a1 --workers 6 [--iters N] [--resume runs/x/model.pt]

Row layout from the env: obs | reward, done, truncated, first. Flags on row t describe the transition into t;
an ended row (done/truncated) is a final observation whose action is discarded by the env.
"""
import argparse
import json
import math
import os
import re
import time
from collections import defaultdict

import numpy as np
import torch

from model import Slipstream
from vecenv import VecEnv

HERE = os.path.dirname(os.path.abspath(__file__))
SUBJECT = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SUBJECT))


class RunningNorm:
    def __init__(self, shape):
        self.mean, self.var, self.n = np.zeros(shape, np.float64), np.ones(shape, np.float64), 1e-4

    def update(self, x):
        m, v, k = x.mean(0), x.var(0), x.shape[0]
        d, tot = m - self.mean, self.n + k
        self.mean = self.mean + d * k / tot
        self.var = (self.var * self.n + v * k + d ** 2 * self.n * k / tot) / tot
        self.n = tot

    def __call__(self, x):
        return np.clip((x - self.mean) / np.sqrt(self.var + 1e-8), -10, 10).astype(np.float32)

    def state(self):
        return dict(mean=self.mean, var=self.var, n=self.n)

    def load(self, s):
        self.mean, self.var, self.n = s['mean'], s['var'], s['n']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--iters', type=int, default=100000)
    ap.add_argument('--minutes', type=float, default=0)
    ap.add_argument('--horizon', type=int, default=64)
    ap.add_argument('--epochs', type=int, default=4)
    ap.add_argument('--minibatches', type=int, default=4)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--gamma', type=float, default=0.995)
    ap.add_argument('--lam', type=float, default=0.95)
    ap.add_argument('--clip', type=float, default=0.2)
    ap.add_argument('--ent', type=float, default=0.0)
    ap.add_argument('--vcoef', type=float, default=0.5)
    ap.add_argument('--kl', type=float, default=0.03)
    ap.add_argument('--resume', default='')
    ap.add_argument('--save-every', type=int, default=50)
    a = ap.parse_args()
    assert re.fullmatch(r'[a-z0-9-]+', a.name, re.I), 'run name'
    out = os.path.join(SUBJECT, 'runs', a.name)
    assert not os.path.exists(os.path.join(out, 'log.jsonl')) or a.resume, f'{out} exists; use a new name'
    os.makedirs(out, exist_ok=True)
    logf = open(os.path.join(out, 'log.jsonl'), 'a')

    def log(rec):
        logf.write(json.dumps(rec) + '\n')
        logf.flush()

    cfg_path = os.path.abspath(os.path.join(SUBJECT, a.config) if not os.path.isabs(a.config) else a.config)
    with open(cfg_path) as f:
        log({'run': a.name, 'args': vars(a), 'config': json.load(f)})
    dev = torch.device('cuda')
    env = VecEnv(ROOT, cfg_path, a.workers, log)
    N, D, T = env.n, env.obs_dim, a.horizon
    net = Slipstream(env.layout).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=a.lr, eps=1e-5)
    norm, ret_rms = RunningNorm(D), RunningNorm(())
    it0 = 0
    if a.resume:
        ck = torch.load(a.resume, map_location=dev, weights_only=False)
        net.load_state_dict(ck['model'])
        opt.load_state_dict(ck['opt'])
        norm.load(ck['norm'])
        ret_rms.load(ck['ret'])
        it0 = ck.get('iter', 0)
    log({'agents': N, 'obs': D, 'workers': a.workers, 'params': sum(p.numel() for p in net.parameters())})

    row = env.reset()
    h = torch.zeros(N, net.hidden, device=dev)
    ret_acc = np.zeros(N)
    t_start = time.time()
    agg = defaultdict(list)
    for it in range(it0, a.iters):
        tr0 = time.time()
        obs_b = np.zeros((T + 1, N, D), np.float32)
        raw_b = np.zeros((T + 1, N, D), np.float32)
        flg_b = np.zeros((T + 1, N, 4), np.float32)
        act_b = np.zeros((T, N, 2), np.float32)
        logp_b = np.zeros((T, N), np.float32)
        val_b = np.zeros((T + 1, N), np.float32)
        h0 = h.clone()
        t_env = 0.0
        with torch.no_grad():
            for t in range(T + 1):
                raw_b[t] = row[:, :D]
                flg_b[t] = row[:, D:D + 4]
                obs_b[t] = norm(row[:, :D])
                x = torch.from_numpy(obs_b[t]).to(dev)
                first = torch.from_numpy(flg_b[t, :, 3]).to(dev)
                mu, v, h_next = net.step(x, h, first)
                val_b[t] = v.cpu().numpy()
                if t == T:
                    break  # bootstrap value only: the next rollout processes this row from h
                h = h_next
                std = net.log_std.exp()
                act = mu + std * torch.randn_like(mu)
                logp_b[t] = (-((act - mu) ** 2) / (2 * std ** 2) - net.log_std - 0.5 * math.log(2 * math.pi)).sum(1).cpu().numpy()
                act_b[t] = act.cpu().numpy()
                te = time.time()
                row = env.step(act_b[t])
                t_env += time.time() - te
        norm.update(raw_b[:T].reshape(-1, D)[::4])
        rew = flg_b[1:, :, 0]
        done = flg_b[1:, :, 1]
        ended_next = np.clip(flg_b[1:, :, 1] + flg_b[1:, :, 2], 0, 1)
        valid = 1 - np.clip(flg_b[:T, :, 1] + flg_b[:T, :, 2], 0, 1)
        # Return-based reward scaling.
        for t in range(T):
            ret_acc = ret_acc * a.gamma * (1 - ended_next[t]) + rew[t]
            ret_rms.update(ret_acc.reshape(-1, 1).squeeze(1)) if t % 8 == 0 else None
        rs = rew / math.sqrt(ret_rms.var + 1e-8)
        adv = np.zeros((T, N), np.float32)
        last = np.zeros(N, np.float32)
        for t in reversed(range(T)):
            delta = rs[t] + a.gamma * val_b[t + 1] * (1 - done[t]) - val_b[t]
            last = delta + a.gamma * a.lam * (1 - ended_next[t]) * last
            adv[t] = last
        tgt = adv + val_b[:T]
        t_roll = time.time() - tr0

        # ---- update: minibatches split over agents, full-sequence BPTT ----
        tu0 = time.time()
        X = torch.from_numpy(obs_b[:T]).to(dev)
        F = torch.from_numpy(flg_b[:T, :, 3]).to(dev)
        A = torch.from_numpy(act_b).to(dev)
        LP = torch.from_numpy(logp_b).to(dev)
        ADV = torch.from_numpy(adv).to(dev)
        TGT = torch.from_numpy(tgt).to(dev)
        M = torch.from_numpy(valid).to(dev)
        H0 = h0
        mv = M.sum().clamp(min=1)
        am = (ADV * M).sum() / mv
        asd = (((ADV - am) ** 2 * M).sum() / mv).sqrt()
        ADV = (ADV - am) / (asd + 1e-8)
        kls, clips, vls, pls = [], [], [], []
        stop = False
        for ep in range(a.epochs):
            perm = torch.randperm(N, device=dev)
            for mb in perm.chunk(a.minibatches):
                mu, v = net.sequence(X[:, mb], H0[mb], F[:, mb])
                ls = net.log_std
                lp = (-((A[:, mb] - mu) ** 2) / (2 * ls.exp() ** 2) - ls - 0.5 * math.log(2 * math.pi)).sum(2)
                ratio = (lp - LP[:, mb]).exp()
                m = M[:, mb]
                n = m.sum().clamp(min=1)
                pg = -(torch.min(ratio * ADV[:, mb], ratio.clamp(1 - a.clip, 1 + a.clip) * ADV[:, mb]) * m).sum() / n
                vl = (((v - TGT[:, mb]) ** 2) * m).sum() / n
                ent = (ls + 0.5 * math.log(2 * math.pi * math.e)).sum()
                loss = pg + a.vcoef * vl - a.ent * ent
                opt.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
                opt.step()
                with torch.no_grad():
                    kl = (((ratio - 1) - (lp - LP[:, mb])) * m).sum() / n
                    kls.append(kl.item())
                    clips.append(((((ratio - 1).abs() > a.clip).float() * m).sum() / n).item())
                    vls.append(vl.item())
                    pls.append(pg.item())
            if np.mean(kls[-a.minibatches:]) > a.kl:
                stop = True
                break
        t_upd = time.time() - tu0

        for s in env.take_stats():
            if 'sps' not in s:
                continue
            for k in ('speed', 'legal'):
                agg[k].append(s[k])
            agg['eps'].append(s['eps'])
            for w, c in s['why'].items():
                agg['why:' + w].append(c)
            for trk, laps in s['laps'].items():
                agg['lap:' + trk] += laps
        steps = (it + 1 - it0) * T * N
        rec = {'it': it, 'steps': steps, 'min': round((time.time() - t_start) / 60, 2), 'sps': round(T * N / (t_roll + t_upd)),
               't_roll': round(t_roll, 2), 't_env': round(t_env, 2), 't_upd': round(t_upd, 2), 'rew': round(float(rew[valid.astype(bool)].mean()), 4),
               'kl': round(float(np.mean(kls)), 4), 'clip': round(float(np.mean(clips)), 3), 'vl': round(float(np.mean(vls)), 3),
               'std': [round(x, 3) for x in net.log_std.exp().tolist()], 'stopped': stop}
        if it % 10 == 9:
            for k, v in list(agg.items()):
                if k.startswith('lap:'):
                    rec[k] = {'n': len(v), 'best': round(min(v), 3), 'med': round(float(np.median(v)), 3)} if v else None
                elif k.startswith('why:') or k == 'eps':
                    rec[k] = int(sum(v))
                else:
                    rec[k] = round(float(np.mean(v)), 4)
            agg.clear()
        log(rec)
        print(json.dumps(rec), flush=True)
        if it % a.save_every == a.save_every - 1 or (a.minutes and time.time() - t_start > a.minutes * 60):
            torch.save({'model': net.state_dict(), 'opt': opt.state_dict(), 'norm': norm.state(), 'ret': ret_rms.state(), 'iter': it + 1, 'layout': env.layout},
                       os.path.join(out, 'model.pt'))
        if a.minutes and time.time() - t_start > a.minutes * 60:
            break
    env.close()


if __name__ == '__main__':
    main()
