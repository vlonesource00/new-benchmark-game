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

from contract import layout_of, migrate_to, obs_len
from model import GraphedSequence, Slipstream, SlipstreamMoE
from teacher import TeacherData, bc_loss, torch_norm
from vecenv import VecEnv

HERE = os.path.dirname(os.path.abspath(__file__))
SUBJECT = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SUBJECT))


def opt_names(layout, ck):
    """Names of the parameters Adam holds for a checkpoint's network, in order (trainable ones it has: a checkpoint
    from before a head was added holds no state for it)."""
    net = SlipstreamMoE(layout) if 'moe' in ck else Slipstream(layout)
    return [n for n, p in net.named_parameters() if p.requires_grad and n in ck['model']]


def remap_opt(sd, old, new):
    """Adam state dict over parameter names `old` -> over `new` (one group): moments follow their parameter by name;
    parameters new to the network start without state."""
    idx = {n: i for i, n in enumerate(old)}
    state = {j: sd['state'][idx[n]] for j, n in enumerate(new) if n in idx and idx[n] in sd['state']}
    return {'state': state, 'param_groups': [{**sd['param_groups'][0], 'params': list(range(len(new)))}]}


def binary_columns(layout):
    """Rival presence flags: the model masks attention on them, so they must reach it as raw 0/1. Contract v3's
    race-context block (flags and small integers: same class, tier, lap and size differences) also reaches it raw."""
    base = layout['ego'] + layout['roadK'] * layout['roadF']
    cols = [base + i * layout['rivalF'] for i in range(layout['rivalN'])]
    v2 = base + layout['rivalN'] * layout['rivalF']
    v3 = v2 + layout.get('egoX', 0) + layout['rivalN'] * layout.get('rivalX', 0)
    cols += list(range(v2, v3))
    cols += list(range(v3, v3 + layout.get('corrX', 0)))  # v4 collision corridor: already scaled to about +-4, raw
    return np.array(cols, dtype=np.int64)


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
    ap.add_argument('--migrate', action='store_true', help='convert a resumed v1-contract checkpoint to the env contract (v2); '
                    'without it a resumed run keeps its checkpoint contract (reads only its own columns)')
    ap.add_argument('--save-every', type=int, default=50)
    ap.add_argument('--teacher', default='', help='comma-separated runs/teacher/<name> sequences (INTERCEPT driving, env/teacher.mjs)')
    ap.add_argument('--bc', type=float, default=0.0, help='weight of the imitation term (squared error to the teacher action)')
    ap.add_argument('--bc-end', type=float, default=1.0, help='imitation weight at the end of --minutes, as a fraction of --bc (linear)')
    ap.add_argument('--bc-sections', default='', help='JSON {sections: {track: [[s0, s1]...]}}: imitate only there')
    ap.add_argument('--distill', default='', help='online distillation: comma-separated <track>=<checkpoint> (e.g. track '
                    'specialists). Each teacher network runs on the student rollout states in solo worlds (no AI seats) of '
                    'its track; the student mean action is pulled to the teacher mean (squared error) on those decision rows')
    ap.add_argument('--distill-w', type=float, default=1.0, help='weight of the distillation term')
    ap.add_argument('--bc-batch', type=int, default=32)
    ap.add_argument('--bc-chunk', type=int, default=128)
    ap.add_argument('--bc-burn', type=int, default=32)
    ap.add_argument('--ema-half', type=float, default=200, help='half-life in iterations of the weight average saved as *-ema.pt; 0 = off')
    ap.add_argument('--critic-warmup', type=int, default=0,
                    help='first N iterations of a resumed run train only the value head (trunk and policy frozen), '
                         'so a changed reward is learned by the critic before it steers policy updates')
    ap.add_argument('--no-graphs', action='store_true', help='run the training sequence pass eagerly instead of as a '
                    'replayed CUDA graph (same results; the graph is ~2-3x faster)')
    ap.add_argument('--moe-base', default='', help='mixture of experts: this checkpoint is the frozen pace expert, --resume '
                    '(a plain or MoE checkpoint) the trainable combat expert, plus a learned router; the input normaliser is frozen')
    ap.add_argument('--gate-solo', type=float, default=5.0, help='MoE: weight of g^2 on decision rows with no rival in view')
    ap.add_argument('--gate-cost', type=float, default=0.02, help='MoE: weight of g on every decision row (use the combat expert only where it pays)')
    ap.add_argument('--gate-prior', type=float, default=0.0, help='MoE: weight of a cross-entropy pull of the router to the '
                    'traffic window (1 with a rival 60 m ahead to 20 m behind, else 0), so it routes before PPO can value routing')
    ap.add_argument('--gate-prior-end', type=float, default=0.1, help='router prior weight at the end of --minutes, as a fraction (linear)')
    ap.add_argument('--moe-mode', default='', choices=['', 'residual'], help='MoE: residual = action base + g * combat '
                    '(the combat head restarts near zero as a correction to the pace expert); empty keeps the checkpoint mode')
    ap.add_argument('--anchor', type=float, default=0.0, help='MoE: weight of the squared distance of the action mean from '
                    'the pace expert, on every decision row (deviating from the specialist must earn its reward)')
    ap.add_argument('--noise-gate', type=float, default=-1.0, help='MoE: exploration std scaled by s0 + (1 - s0) * g per '
                    'decision (s0 = this value, -1 = off), so the frozen pace expert is not driven with noise where the '
                    'router leaves it in charge; rollout log-probs and the update use the same per-row std')
    ap.add_argument('--risk-head', action='store_true', help='two critics: task (progress, passes, places) and risk '
                    '(the safety-cost part of the env row: offs, contact, damage, margins, crashes); each its own GAE')
    ap.add_argument('--risk-w', type=float, default=1.0, help='with --risk-head: weight of the risk advantage in the '
                    'policy advantage (1 = the plain total reward)')
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
    N, E, T = env.n, env.obs_dim, a.horizon
    lay, ck = env.layout, None
    if a.resume:
        ck = torch.load(a.resume, map_location=dev, weights_only=False)
        lay = layout_of(ck)
        if a.migrate and lay != env.layout:
            ck = migrate_to(ck, env.layout, opt_names)
            lay = layout_of(ck)
    D = obs_len(lay)  # this network's input columns; the env row carries E >= D, then the 5 flags
    moe = bool(a.moe_base) or bool(ck and 'moe' in ck)
    net = (SlipstreamMoE(lay) if moe else Slipstream(lay)).to(dev)
    # Exploration floor: the sampling std never drops below std_min. A collapsed std both stops new states being
    # visited and makes every small mean shift a large KL, so updates stop early (the tt-b2 plateau).
    # std = floor + exp(log_std): the learned part keeps its gradient, so the policy can still raise its exploration
    # above the floor (a hard max(log_std, log floor) froze log_std wherever it sat below the floor, as in tt-c2).
    floor = torch.tensor([float(x) for x in a.std_min.split(',')], device=dev) if a.std_min else None
    log_std = (lambda: torch.log(floor + net.log_std.exp())) if floor is not None else (lambda: net.log_std)
    ngate = moe and a.noise_gate >= 0
    nscale = lambda g: a.noise_gate + (1 - a.noise_gate) * g
    opt = torch.optim.Adam([p for p in net.parameters() if p.requires_grad], lr=a.lr, eps=1e-5)
    seq = net.sequence if a.no_graphs or dev.type != 'cuda' else GraphedSequence(net)
    norm, ret_rms = RunningNorm(D, binary_columns(lay)), RunningNorm(())
    it0 = 0
    if a.resume and moe and 'moe' not in ck:  # a plain checkpoint becomes the combat expert (fresh optimizer)
        net.cmb.load_state_dict(ck['model'])
        norm.load(ck['norm'])
    elif a.resume:
        net.load_state_dict(ck['model'])
        old, new = opt_names(lay, ck), [n for n, p in net.named_parameters() if p.requires_grad]
        opt.load_state_dict(ck['opt'] if old == new else remap_opt(ck['opt'], old, new))
        for g in opt.param_groups:  # the saved optimizer state carries the parent's lr; --lr wins
            g['lr'] = a.lr
        norm.load(ck['norm'])
        ret_rms.load(ck['ret'])
        it0 = ck.get('iter', 0)
    if a.moe_base:  # the pace expert: weights and normaliser fixed; the training normaliser is frozen from here on
        bk = torch.load(os.path.join(SUBJECT, a.moe_base), map_location=dev, weights_only=False)
        if layout_of(bk) != lay:  # the frozen pace expert follows the combat expert's contract (zero-weight new inputs)
            bk = migrate_to(bk, lay, opt_names)
        assert obs_len(layout_of(bk)) == D, 'pace expert contract != combat expert'
        net.base.load_state_dict(bk['model'])
        bn = RunningNorm(D, binary_columns(lay))
        bn.load(bk['norm'])
        net.set_norms((norm.mean, np.sqrt(norm.var + 1e-8)), (bn.mean, np.sqrt(bn.var + 1e-8)), binary_columns(lay))
    vnet = net.cmb if moe else net
    vnet.split_v = a.risk_head  # value [task, risk]: two critics over the env row's reward split, summed for the policy
    K = 2 if a.risk_head else 1
    switched = moe and a.moe_mode == 'residual' and not bool(net.residual)
    if switched:  # new head: its old Adam moments and a resumed weight average no longer apply
        net.make_residual()
        opt = torch.optim.Adam([p for p in net.parameters() if p.requires_grad], lr=a.lr, eps=1e-5)
    pres_cols = binary_columns(lay)[:lay['rivalN']]  # presence flags only (v3 appends its race-context columns)
    gap_cols = pres_cols + 7  # rival feature 7: along-track gap / 100 m (env/observe.mjs)
    # Weight average. Single checkpoints of the deterministic policy swing between 0/10 and 10/10 per track
    # (tt-b2 at 90/120/150 min: 7, 9, 35 of 50 completions), so the evaluated and deployed policy is a slow average
    # of the trained weights instead of whichever weights the run stopped on.
    ema = {k: v.detach().clone() for k, v in net.state_dict().items()}
    if a.resume and 'ema' in ck and not switched:
        ema = {k: v.to(dev) for k, v in ck['ema'].items()}
        ema = {k: ema.get(k, v.detach().clone()) for k, v in net.state_dict().items()}  # heads added since: start at the net's
    ema_decay = 0.5 ** (1 / a.ema_half) if a.ema_half > 0 else 0.0
    secs = json.load(open(os.path.join(SUBJECT, a.bc_sections)))['sections'] if a.bc_sections else None
    teacher = TeacherData(a.teacher.split(','), D, dev, secs) if a.teacher and a.bc > 0 else None
    bc_rng = np.random.default_rng(0)
    # Online distillation teachers: frozen networks with their own normalisers and memories, one per track.
    seats = [(w['track'], not w['ai']) for hs in env.hs for w in hs['worlds'] for _ in range(w['agents'])]
    assert len(seats) == N
    dist = []
    for spec in filter(None, a.distill.split(',')):
        trk, path = spec.split('=')
        tk = torch.load(os.path.join(SUBJECT, path), map_location=dev, weights_only=False)
        tl = layout_of(tk)
        assert obs_len(tl) == D, f'{path}: teacher contract != student'
        tn = Slipstream(tl).to(dev)
        tn.load_state_dict(tk['model'])
        tn.requires_grad_(False)
        tnorm = RunningNorm(D, binary_columns(tl))
        tnorm.load(tk['norm'])
        mask = torch.tensor([st == (trk, True) for st in seats], device=dev)
        assert mask.any(), f'no solo world on {trk}'
        dist.append({'net': tn, 'norm': tnorm, 'mask': mask, 'h': torch.zeros(N, tn.hidden, device=dev)})
    DMASK = sum(d['mask'].float() for d in dist) if dist else None
    next_snap = a.snap_min

    def save(path, it_done):
        state = {'opt': opt.state_dict(), 'norm': norm.state(), 'ret': ret_rms.state(), 'iter': it_done, 'layout': lay, **({'moe': True} if moe else {})}
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
        val_b = np.zeros((T + 1, N, K), np.float32)
        risk_b = np.zeros((T + 1, N), np.float32)
        gate_b = np.zeros((T, N), np.float32)
        h0 = h.clone()
        DT = torch.zeros(T, N, 2, device=dev) if dist else None
        t_env = 0.0
        with torch.no_grad():
            for t in range(T + 1):
                raw_b[t] = row[:, :D]
                flg_b[t] = row[:, E:E + 5]
                if env.row > E + 5:
                    risk_b[t] = row[:, E + 5]
                obs_b[t] = norm(row[:, :D])
                x = torch.from_numpy(obs_b[t]).to(dev)
                first = torch.from_numpy(flg_b[t, :, 3]).to(dev)
                # Row T is the bootstrap: same processing as row 0 of the next rollout, which starts from h (not committed here).
                decf = torch.from_numpy(flg_b[t, :, 4]).to(dev)
                if moe:
                    mu, v, h_next, g_ = net.step(x, h, first, decf, with_gate=True)
                    if t < T:
                        gate_b[t] = g_.cpu().numpy()
                else:
                    mu, v, h_next = collect_step(net, x, h, first, decf)
                if t < T:  # teachers see rows 0..T-1 (row T is row 0 of the next rollout)
                    for d in dist:
                        tmu, _, d['h'] = collect_step(d['net'], torch.from_numpy(d['norm'](raw_b[t])).to(dev), d['h'], first, decf)
                        DT[t, d['mask']] = tmu[d['mask']]
                val_b[t] = v.reshape(N, K).cpu().numpy()
                if t == T:
                    break  # bootstrap value only: the next rollout processes this row from h
                h = h_next
                lsr = log_std() + (nscale(g_).unsqueeze(1).log() if ngate else 0)
                std = lsr.exp()
                act = mu + std * torch.randn_like(mu)
                logp_b[t] = (-((act - mu) ** 2) / (2 * std ** 2) - lsr - 0.5 * math.log(2 * math.pi)).sum(1).cpu().numpy()
                act_b[t] = act.cpu().numpy()
                te = time.time()
                row = env.step(act_b[t])
                t_env += time.time() - te
        if not moe:
            norm.update(raw_b[:T].reshape(-1, D)[::4])
        # In traffic: a rival within 60 m ahead or 20 m behind (as the hybrid bridge's hand-over window).
        gp = raw_b[:T][:, :, gap_cols]
        traffic = ((raw_b[:T][:, :, pres_cols] > 0.5) & (gp < 0.6) & (gp > -0.2)).any(2)
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
        if a.risk_head:  # GAE is linear in rewards and values: the two critics' advantages sum to the total's
            rr = risk_b[1:] / math.sqrt(ret_rms.var + 1e-8)
            advs = [semi_gae(r_, val_b[..., k], done, ended_next, dec, a.gamma, a.lam) for k, r_ in enumerate((rs - rr, rr))]
            adv = advs[0] + a.risk_w * advs[1]
            tgt = np.stack(advs, 2) + val_b[:T]
        else:
            adv = semi_gae(rs, val_b[..., 0], done, ended_next, dec, a.gamma, a.lam)
            tgt = (adv + val_b[:T, :, 0])[..., None]
        # explained variance of each critic on its targets (live rows): how much of the return the value predicts
        lv = live.astype(bool)
        ev = [round(float(1 - np.var(tgt[..., k][lv] - val_b[:T, :, k][lv]) / max(np.var(tgt[..., k][lv]), 1e-8)), 3) for k in range(K)]
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
        SOLO = torch.from_numpy((~traffic).astype(np.float32)).to(dev)
        gp_w = a.gate_prior * (1 - (1 - a.gate_prior_end) * min(1.0, (time.time() - t_start) / 60 / a.minutes)) if a.minutes else a.gate_prior
        MV = torch.from_numpy(live).to(dev)
        H0 = h0
        mv = M.sum().clamp(min=1)
        am = (ADV * M).sum() / mv
        asd = (((ADV - am) ** 2 * M).sum() / mv).sqrt()
        ADV = (ADV - am) / (asd + 1e-8)
        kls, clips, vls, pls, bcs, gns, dls, gls, devs = [], [], [], [], [], [], [], [], []
        cacc = {'tr': torch.zeros(3, device=dev), 'solo': torch.zeros(3, device=dev)}
        nf = torch_norm(norm, dev) if teacher else None
        bc_w = a.bc * (1 - (1 - a.bc_end) * min(1.0, (time.time() - t_start) / 60 / a.minutes)) if a.minutes else a.bc
        stop = False
        warm = it - it0 < a.critic_warmup
        for ep in range(a.epochs):
            perm = torch.randperm(N, device=dev)
            for mb in perm.chunk(a.minibatches):
                probe = teacher is not None and not warm and not gns  # differentiates twice: eager pass (GraphedSequence)
                sq = net.sequence if probe else seq
                res = sq(X[:, mb], H0[mb], F[:, mb], DEC[:, mb])
                mu, v = res[0], res[1].reshape(T, -1, K)
                ls = log_std()
                lsr = ls + nscale(res[2]).unsqueeze(2).log() if ngate else ls  # entropy bonus stays on ls: no push on the router
                lp = (-((A[:, mb] - mu) ** 2) / (2 * lsr.exp() ** 2) - lsr - 0.5 * math.log(2 * math.pi)).sum(2)
                ratio = (lp - LP[:, mb]).exp()
                m = M[:, mb]
                n = m.sum().clamp(min=1)
                pg = -(torch.min(ratio * ADV[:, mb], ratio.clamp(1 - a.clip, 1 + a.clip) * ADV[:, mb]) * m).sum() / n
                mv_ = MV[:, mb]
                vl = (((v - TGT[:, mb]) ** 2).sum(2) * mv_).sum() / mv_.sum().clamp(min=1)
                ent = (ls + 0.5 * math.log(2 * math.pi * math.e)).sum()
                loss = pg + a.vcoef * vl - a.ent * ent
                if moe and not warm:  # router: no combat expert without a rival in view, and a small price for using it
                    g = res[2]
                    gl = a.gate_solo * (g ** 2 * m * SOLO[:, mb]).sum() / n + a.gate_cost * (g * m).sum() / n
                    if gp_w:
                        gc = g.clamp(1e-4, 1 - 1e-4)
                        gl = gl + gp_w * (-((1 - SOLO[:, mb]) * gc.log() + SOLO[:, mb] * (1 - gc).log()) * m).sum() / n
                    dev2 = (res[3] ** 2).sum(2)
                    if a.anchor:
                        gl = gl + a.anchor * (dev2 * m).sum() / n
                    loss = loss + gl
                    gls.append(gl.item())
                    devs.append(((dev2 * m).sum() / n).item())
                    with torch.no_grad():  # correction strength per action, traffic vs solo rows: [sum d^2 steer, pedal, rows]
                        for key, w in (('tr', m * (1 - SOLO[:, mb])), ('solo', m * SOLO[:, mb])):
                            cacc[key] += torch.cat([((res[3] ** 2) * w.unsqueeze(2)).sum((0, 1)), w.sum().view(1)])
                if dist and not warm:
                    dm = M[:, mb] * DMASK[mb]
                    dl = (((mu - DT[:, mb]) ** 2).sum(2) * dm).sum() / dm.sum().clamp(min=1)
                    loss = loss + a.distill_w * dl
                    dls.append(dl.item())
                if teacher and not warm:
                    bcl = bc_loss(net, *teacher.batch(a.bc_batch, a.bc_chunk, bc_rng), nf, a.bc_burn, sq)
                    if probe:  # once per iteration: how hard each term pulls the policy head (sets the --bc scale)
                        head = list(net.pi.parameters())
                        gp = torch.autograd.grad(pg, head, retain_graph=True)
                        gb = torch.autograd.grad(bc_w * bcl, head, retain_graph=True)
                        gns.append([sum(g.pow(2).sum() for g in gp).sqrt().item(), sum(g.pow(2).sum() for g in gb).sqrt().item()])
                    loss = loss + bc_w * bcl
                    bcs.append(bcl.item())
                opt.zero_grad(set_to_none=True)
                if warm:  # value head only: gradients reach nothing the policy reads
                    torch.autograd.backward(a.vcoef * vl, inputs=net.value_params())
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
            agg['rear'].append(s.get('rear', 0))
            agg['ttc'].append(s.get('ttc', 0))
            agg['rub'].append(s.get('rub', 0))
            agg['clear'].append(s.get('clear', 0))
            for k in ('passes', 'dirty', 'lostP', 'stuckS', 'closes'):
                agg[k].append(s.get(k, 0))
            for w, c in s['why'].items():
                agg['why:' + w].append(c)
            agg['ticks'].append(s.get('ticks', 0) or 0)
            for k, v in (s.get('ledger') or {}).items():
                agg['led:' + k].append(v)
            for trk, laps in s['laps'].items():
                agg['lap:' + trk] += laps
        steps = (it + 1 - it0) * T * N
        rec = {'it': it, 'steps': steps, 'min': round((time.time() - t_start) / 60, 2), 'sps': round(T * N / (t_roll + t_upd)),
               't_roll': round(t_roll, 2), 't_env': round(t_env, 2), 't_upd': round(t_upd, 2), 'rew': round(float(rew[live.astype(bool)].mean()), 4),
               **({'bc': round(float(np.mean(bcs)), 4), 'bc_w': round(bc_w, 3), 'gn': [round(x, 4) for x in gns[0]]} if bcs else {}),
               **({'dist': round(float(np.mean(dls)), 4)} if dls else {}),
               **({'gate_tr': round(float(gate_b[traffic & (valid > 0)].mean()) if (traffic & (valid > 0)).any() else 0.0, 3),
                   'gate_solo': round(float(gate_b[~traffic & (valid > 0)].mean()) if (~traffic & (valid > 0)).any() else 0.0, 3),
                   'traffic': round(float(traffic[valid > 0].mean()), 3), 'gl': round(float(np.mean(gls)), 4) if gls else 0.0,
                   'dev': round(float(np.mean(devs)), 5) if devs else 0.0,
                   # RMS correction applied on top of the pace expert [steer, pedal], in traffic and solo
                   **{f'corr_{k}': [round(float(x), 4) for x in (c[:2] / c[2].clamp(min=1)).sqrt().tolist()] for k, c in cacc.items()}} if moe else {}),
               'ev': ev, 'kl': round(float(np.mean(kls)), 4), 'clip': round(float(np.mean(clips)), 3), 'vl': round(float(np.mean(vls)), 3),
               'std': [round(x, 3) for x in log_std().exp().tolist()], 'stopped': stop, 'warm': warm, 'decide': round(float(dec[:T].mean()), 3)}
        if it % 10 == 9:
            dn = max(1.0, float(sum(agg.pop('ticks', []))))
            # reward ledger: each term's summed contribution per 1000 agent decisions (raw reward units, before scaling)
            rec['ledger'] = {k[4:]: round(1000 * sum(agg.pop(k)) / dn, 3) for k in [k for k in agg if k.startswith('led:')]}
            for k, v in list(agg.items()):
                if k.startswith('lap:'):
                    rec[k] = {'n': len(v), 'best': round(min(v), 3), 'med': round(float(np.median(v)), 3)} if v else None
                elif k.startswith('why:') or k in ('eps', 'inc', 'rear', 'passes', 'dirty', 'lostP', 'closes'):
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
