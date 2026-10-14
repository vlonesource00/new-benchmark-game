"""Recurrent PPO baseline for SLIPSTREAM (the learner is swappable; QR-SAC etc. can replace this file).

  python learner/ppo.py --config configs/tt.json --name tt-a1 --workers 6 [--iters N] [--resume runs/x/model.pt]

Row layout from the env: obs | reward, done, truncated, first, decide. Flags on row t describe the transition into t;
an ended row (done/truncated) is a final observation whose action is discarded by the env.
Decisions are a semi-MDP: only decide rows (seat free, as in the browser) step the GRU and train the policy; the reward of
the busy ticks in between accumulates (per-tick discount) into the preceding decision. The critic is also trained on busy
rows (memory held, target = return to the next actual decision), so a rollout cut on a busy row bootstraps from a trained
value computed exactly as the next rollout will process that row.
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


def binary_columns(layout):
    """Rival presence flags: the model masks attention on them, so they must reach it as raw 0/1."""
    base = layout['ego'] + layout['roadK'] * layout['roadF']
    return np.array([base + i * layout['rivalF'] for i in range(layout['rivalN'])])


class RunningNorm:
    def __init__(self, shape, skip=None):
        self.mean, self.var, self.n = np.zeros(shape, np.float64), np.ones(shape, np.float64), 1e-4
        self.skip = skip
        self._pin()

    def _pin(self):
        if self.skip is not None:
            self.mean[self.skip], self.var[self.skip] = 0.0, 1.0

    def update(self, x):
        m, v, k = x.mean(0), x.var(0), x.shape[0]
        d, tot = m - self.mean, self.n + k
        self.mean = self.mean + d * k / tot
        self.var = (self.var * self.n + v * k + d ** 2 * self.n * k / tot) / tot
        self.n = tot
        self._pin()

    def __call__(self, x):
        out = np.clip((x - self.mean) / np.sqrt(self.var + 1e-8), -10, 10).astype(np.float32)
        if self.skip is not None:
            out[..., self.skip] = x[..., self.skip]
        return out

    def state(self):
        return dict(mean=self.mean, var=self.var, n=self.n)

    def load(self, s):
        self.mean, self.var, self.n = s['mean'], s['var'], s['n']
        self._pin()


def collect_step(net, x, h, first, dec):
    """The one way a row is processed, in collection, at the bootstrap row and (in sequence form) in the update:
    memory steps only where dec = 1 (the seat would be queried)."""
    return net.step(x, h, first, dec)


def semi_gae(rs, val_b, done, ended_next, dec, gamma, lam):
    """rs/done/ended_next [T,N] per tick, val_b/dec [T+1,N]. Advantage of every row: a decide row's is its decision's
    semi-MDP GAE; a busy row's is the same estimate from that row (its value target; the policy ignores it)."""
    T, N = rs.shape
    # Semi-MDP GAE. Carried backwards to each decision: R (discounted reward to the next decision), g (discount to it),
    # nv / na (value and advantage at it). Row T counts as a decision; an episode end is a boundary with no advantage.
    adv = np.zeros((T, N), np.float32)
    R, g = np.zeros(N), np.ones(N)
    nv, na = val_b[T].astype(np.float64), np.zeros(N)
    for t in reversed(range(T)):
        e = ended_next[t] > 0.5
        d1 = np.ones(N, bool) if t + 1 == T else dec[t + 1] > 0.5
        nv = np.where(e, val_b[t + 1] * (1 - done[t]), np.where(d1, val_b[t + 1], nv))
        na = np.where(e, 0.0, np.where(d1, 0.0 if t + 1 == T else adv[t + 1], na))
        b = e | d1
        R = np.where(b, rs[t], rs[t] + gamma * R)
        g = np.where(b, gamma, gamma * g)
        adv[t] = R + g * nv - val_b[t] + g * lam * na
    return adv


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
    ap.add_argument('--std-min', default='', help='exploration floor per action, e.g. 0.06,0.10 (steer,pedal): std = floor + learned; empty = none')
    ap.add_argument('--vcoef', type=float, default=0.5)
    ap.add_argument('--kl', type=float, default=0.03)
    ap.add_argument('--resume', default='')
    ap.add_argument('--save-every', type=int, default=50)
    ap.add_argument('--ema-half', type=float, default=200, help='half-life in iterations of the weight average saved as *-ema.pt; 0 = off')
    ap.add_argument('--critic-warmup', type=int, default=0,
                    help='first N iterations of a resumed run train only the value head (trunk and policy frozen), '
                         'so a changed reward is learned by the critic before it steers policy updates')
    ap.add_argument('--snap-min', type=float, default=10, help='write snap-<min>.pt (and snap-<min>-ema.pt) every this many minutes; 0 = off')
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
    # Exploration floor: the sampling std never drops below std_min. A collapsed std both stops new states being
    # visited and makes every small mean shift a large KL, so updates stop early (the tt-b2 plateau).
    # std = floor + exp(log_std): the learned part keeps its gradient, so the policy can still raise its exploration
    # above the floor (a hard max(log_std, log floor) froze log_std wherever it sat below the floor, as in tt-c2).
    floor = torch.tensor([float(x) for x in a.std_min.split(',')], device=dev) if a.std_min else None
    log_std = (lambda: torch.log(floor + net.log_std.exp())) if floor is not None else (lambda: net.log_std)
    opt = torch.optim.Adam(net.parameters(), lr=a.lr, eps=1e-5)
    norm, ret_rms = RunningNorm(D, binary_columns(env.layout)), RunningNorm(())
    it0 = 0
    if a.resume:
        ck = torch.load(a.resume, map_location=dev, weights_only=False)
        net.load_state_dict(ck['model'])
        opt.load_state_dict(ck['opt'])
        for g in opt.param_groups:  # the saved optimizer state carries the parent's lr; --lr wins
            g['lr'] = a.lr
        norm.load(ck['norm'])
        ret_rms.load(ck['ret'])
        it0 = ck.get('iter', 0)
    # Weight average. Single checkpoints of the deterministic policy swing between 0/10 and 10/10 per track
    # (tt-b2 at 90/120/150 min: 7, 9, 35 of 50 completions), so the evaluated and deployed policy is a slow average
    # of the trained weights instead of whichever weights the run stopped on.
    ema = {k: v.detach().clone() for k, v in net.state_dict().items()}
    if a.resume and 'ema' in ck:
        ema = {k: v.to(dev) for k, v in ck['ema'].items()}
    ema_decay = 0.5 ** (1 / a.ema_half) if a.ema_half > 0 else 0.0
    next_snap = a.snap_min

    def save(path, it_done):
        state = {'opt': opt.state_dict(), 'norm': norm.state(), 'ret': ret_rms.state(), 'iter': it_done, 'layout': env.layout}
        torch.save({**state, 'model': net.state_dict(), 'ema': ema}, path + '.pt')
        if a.ema_half > 0:  # the average as a plain checkpoint, so every tool (complete, export, record) loads it as is
            torch.save({**state, 'model': ema}, path + '-ema.pt')

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
        flg_b = np.zeros((T + 1, N, 5), np.float32)
        act_b = np.zeros((T, N, 2), np.float32)
        logp_b = np.zeros((T, N), np.float32)
        val_b = np.zeros((T + 1, N), np.float32)
        h0 = h.clone()
        t_env = 0.0
        with torch.no_grad():
            for t in range(T + 1):
                raw_b[t] = row[:, :D]
                flg_b[t] = row[:, D:D + 5]
                obs_b[t] = norm(row[:, :D])
                x = torch.from_numpy(obs_b[t]).to(dev)
                first = torch.from_numpy(flg_b[t, :, 3]).to(dev)
                # Row T is the bootstrap: same processing as row 0 of the next rollout, which starts from h (not committed here).
                mu, v, h_next = collect_step(net, x, h, first, torch.from_numpy(flg_b[t, :, 4]).to(dev))
                val_b[t] = v.cpu().numpy()
                if t == T:
                    break  # bootstrap value only: the next rollout processes this row from h
                h = h_next
                std = log_std().exp()
                act = mu + std * torch.randn_like(mu)
                logp_b[t] = (-((act - mu) ** 2) / (2 * std ** 2) - log_std() - 0.5 * math.log(2 * math.pi)).sum(1).cpu().numpy()
                act_b[t] = act.cpu().numpy()
                te = time.time()
                row = env.step(act_b[t])
                t_env += time.time() - te
        norm.update(raw_b[:T].reshape(-1, D)[::4])
        rew = flg_b[1:, :, 0]
        done = flg_b[1:, :, 1]
        ended_next = np.clip(flg_b[1:, :, 1] + flg_b[1:, :, 2], 0, 1)
        dec = flg_b[:, :, 4]
        live = 1 - np.clip(flg_b[:T, :, 1] + flg_b[:T, :, 2], 0, 1)  # critic rows (an ended row's action is discarded)
        valid = live * dec[:T]                                          # policy rows
        # Return-based reward scaling.
        for t in range(T):
            ret_acc = ret_acc * a.gamma * (1 - ended_next[t]) + rew[t]
            ret_rms.update(ret_acc.reshape(-1, 1).squeeze(1)) if t % 8 == 0 else None
        rs = rew / math.sqrt(ret_rms.var + 1e-8)
        adv = semi_gae(rs, val_b, done, ended_next, dec, a.gamma, a.lam)
        tgt = adv + val_b[:T]
        t_roll = time.time() - tr0

        # ---- update: minibatches split over agents, full-sequence BPTT ----
        tu0 = time.time()
        X = torch.from_numpy(obs_b[:T]).to(dev)
        F = torch.from_numpy(flg_b[:T, :, 3]).to(dev)
        DEC = torch.from_numpy(np.ascontiguousarray(dec[:T])).to(dev)
        A = torch.from_numpy(act_b).to(dev)
        LP = torch.from_numpy(logp_b).to(dev)
        ADV = torch.from_numpy(adv).to(dev)
        TGT = torch.from_numpy(tgt).to(dev)
        M = torch.from_numpy(valid).to(dev)
        MV = torch.from_numpy(live).to(dev)
        H0 = h0
        mv = M.sum().clamp(min=1)
        am = (ADV * M).sum() / mv
        asd = (((ADV - am) ** 2 * M).sum() / mv).sqrt()
        ADV = (ADV - am) / (asd + 1e-8)
        kls, clips, vls, pls = [], [], [], []
        stop = False
        warm = it - it0 < a.critic_warmup
        for ep in range(a.epochs):
            perm = torch.randperm(N, device=dev)
            for mb in perm.chunk(a.minibatches):
                mu, v = net.sequence(X[:, mb], H0[mb], F[:, mb], DEC[:, mb])
                ls = log_std()
                lp = (-((A[:, mb] - mu) ** 2) / (2 * ls.exp() ** 2) - ls - 0.5 * math.log(2 * math.pi)).sum(2)
                ratio = (lp - LP[:, mb]).exp()
                m = M[:, mb]
                n = m.sum().clamp(min=1)
                pg = -(torch.min(ratio * ADV[:, mb], ratio.clamp(1 - a.clip, 1 + a.clip) * ADV[:, mb]) * m).sum() / n
                mv_ = MV[:, mb]
                vl = (((v - TGT[:, mb]) ** 2) * mv_).sum() / mv_.sum().clamp(min=1)
                ent = (ls + 0.5 * math.log(2 * math.pi * math.e)).sum()
                loss = pg + a.vcoef * vl - a.ent * ent
                opt.zero_grad(set_to_none=True)
                if warm:  # value head only: gradients reach nothing the policy reads
                    torch.autograd.backward(a.vcoef * vl, inputs=list(net.v.parameters()))
                else:
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
        if ema_decay:
            with torch.no_grad():
                for k, v in net.state_dict().items():
                    ema[k].lerp_(v, 1 - ema_decay) if v.is_floating_point() else ema[k].copy_(v)

        for s in env.take_stats():
            if 'sps' not in s:
                continue
            for k in ('speed', 'legal'):
                agg[k].append(s[k])
            agg['eps'].append(s['eps'])
            agg['inc'].append(s.get('inc', 0))
            for w, c in s['why'].items():
                agg['why:' + w].append(c)
            for trk, laps in s['laps'].items():
                agg['lap:' + trk] += laps
        steps = (it + 1 - it0) * T * N
        rec = {'it': it, 'steps': steps, 'min': round((time.time() - t_start) / 60, 2), 'sps': round(T * N / (t_roll + t_upd)),
               't_roll': round(t_roll, 2), 't_env': round(t_env, 2), 't_upd': round(t_upd, 2), 'rew': round(float(rew[live.astype(bool)].mean()), 4),
               'kl': round(float(np.mean(kls)), 4), 'clip': round(float(np.mean(clips)), 3), 'vl': round(float(np.mean(vls)), 3),
               'std': [round(x, 3) for x in log_std().exp().tolist()], 'stopped': stop, 'warm': warm, 'decide': round(float(dec[:T].mean()), 3)}
        if it % 10 == 9:
            for k, v in list(agg.items()):
                if k.startswith('lap:'):
                    rec[k] = {'n': len(v), 'best': round(min(v), 3), 'med': round(float(np.median(v)), 3)} if v else None
                elif k.startswith('why:') or k in ('eps', 'inc'):
                    rec[k] = int(sum(v))
                else:
                    rec[k] = round(float(np.mean(v)), 4)
            agg.clear()
        log(rec)
        print(json.dumps(rec), flush=True)
        if it % a.save_every == a.save_every - 1 or (a.minutes and time.time() - t_start > a.minutes * 60):
            save(os.path.join(out, 'model'), it + 1)
        el = (time.time() - t_start) / 60
        if a.snap_min and el >= next_snap:
            save(os.path.join(out, f'snap-{round(next_snap)}'), it + 1)
            next_snap += a.snap_min
        if a.minutes and el > a.minutes:
            save(os.path.join(out, 'final'), it + 1)
            break
    env.close()


if __name__ == '__main__':
    main()
