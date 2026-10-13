"""PPO on the CUDA environment (gpu-sim/cuda_env.py): on-policy rollouts of E scenes at once, no JS rollouts.

Same learner as ppo_plan.py (frozen encoder, intent head + value MLP, Gaussian exploration held for --hold s,
policy gradient on fresh decisions only) and the same reward (cuda_env.REWARD = ppo_plan.REWARD), but rollouts are
continuous: environments keep running across iterations and each iteration collects --horizon simulated seconds.
A decision's reward is what the env accrued until the env's next decision (or the episode end, which adds the
race10 success bonus). Early-stopped scenes (severe contact) and the rollout cut are bootstrapped from the value.
Validate on the JS development suite (tools/plan-evaluate.mjs, isolated workers): stand-in rivals are not the AIs.
  python training/ppo_gpu.py --parent artifacts/models/c196-ppo-it040 --out artifacts/models/g01 --families solo,hazard
"""
import argparse, hashlib, json, math, os, sys, time
from pathlib import Path
import numpy as np
import torch
from torch import nn
import onnx
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'gpu-sim'))
from plan_model import PlanPolicy
from checkpoint_state import atomic_json, atomic_checkpoint
from cuda_env import SceneBank, GpuEnv, REWARDS
from fit_rivals import load_rivals
from job_progress import JobProgress


def decide(model, obs, hidden):
    """(head input, presence, masked pre-noise intent, next hidden): PlanPolicy.forward split at the head."""
    feat, present, memory = model.head_input(obs, hidden)
    mean = model.head(feat) * present
    return feat, present, mean, model.next_hidden(memory, mean, hidden)


# Encoder parts on the head's path (deep-set context/opponent nets and the traffic GRU): --train-encoder trains these.
ENCODER_PATH = ('context', 'opponent', 'traffic_input_gates', 'traffic_hidden_gates')


def warm_hidden(model, schema):
    """driveCases warms the recurrent state with 30 all-zero observations before each run."""
    h = torch.zeros(1, schema['hidden'], device='cuda')
    with torch.no_grad():
        for _ in range(30):
            _, h = model(torch.zeros(1, schema['size'], device='cuda'), h)
    return h[0]


class Rollout:
    """Decision records in collection order; rewards land on an env's latest record."""
    def __init__(self, cap, width, E, device='cuda', obs=0, hidden=0):
        self.dev = device
        z = lambda *s, t=torch.float32: torch.zeros(*s, dtype=t, device=device)
        # --train-encoder keeps the model input and the hidden state it met instead of the head input (recomputed with
        # gradients in the update): at 4096 envs both would not fit beside the env under the 0.8 memory cap.
        self.feat = None if obs else z(cap, width)
        self.present, self.action = z(cap, 1), z(cap, 4)
        self.obs, self.hid = (z(cap, obs), z(cap, hidden)) if obs else (None, None)
        self.logp, self.value, self.reward = z(cap), z(cap), z(cap)
        self.fresh, self.done, self.cut = z(cap, t=torch.bool), z(cap, t=torch.bool), z(cap, t=torch.bool)
        self.env, self.n, self.last = z(cap, t=torch.long), 0, torch.full((E,), -1, dtype=torch.long, device=self.dev)
        # Value of the env's next decision state for records at the rollout edge (bootstrap), when observed.
        self.next_value, self.has_next = z(cap), z(cap, t=torch.bool)
        self.time, self.next_t = z(cap), z(cap)  # decision times (s): elapsed-time discounting

    def clear(self):
        # Reuse the buffers across iterations: a fresh ~5 GiB allocation while the old one is alive does not fit beside the env.
        for v in vars(self).values():
            if torch.is_tensor(v): v.zero_()
        self.n = 0; self.last.fill_(-1)

    def add(self, idx, feat, present, action, logp, value, fresh, t, obs=None, hid=None):
        k = torch.arange(self.n, self.n + len(idx), device=self.dev)
        if self.n + len(idx) > len(self.env):
            raise ValueError('Rollout buffer full; raise --cap')
        self.present[k], self.action[k], self.logp[k], self.value[k], self.fresh[k] = present, action, logp, value, fresh
        if self.obs is None:
            self.feat[k] = feat
        else:
            self.obs[k], self.hid[k] = obs, hid
        self.env[k] = idx; self.last[idx] = k; self.n += len(idx); self.time[k] = t

    def credit(self, idx, r):
        k = self.last[idx]; ok = k >= 0
        self.reward.index_put_((k[ok],), r[ok].float(), accumulate=True)
        return k

    def gae(self, gamma, lam, rate=0.):
        n, env = self.n, self.env[:self.n]
        order = torch.argsort(env * (n + 1) + torch.arange(n, device=self.dev))
        e = env[order]
        counts = torch.bincount(e, minlength=int(self.last.numel()))
        start = torch.cumsum(counts, 0) - counts
        col = torch.arange(n, device=self.dev) - start[e]
        L, E = int(counts.max()), len(counts)
        pad = lambda x, fill=0.: torch.full((E, L), fill, dtype=x.dtype, device=self.dev).index_put_((e, col), x[order])
        r, v, d, c = pad(self.reward[:n]), pad(self.value[:n]), pad(self.done[:n], False), pad(self.cut[:n], False)
        nv, hn = pad(self.next_value[:n]), pad(self.has_next[:n], False)
        tm, nt = pad(self.time[:n]), pad(self.next_t[:n])
        valid = pad(torch.ones(n, dtype=torch.bool, device=self.dev), False)
        adv = torch.zeros(E, L, device=self.dev); run = torch.zeros(E, device=self.dev)
        for j in range(L - 1, -1, -1):
            nxt = v[:, j + 1] if j + 1 < L else torch.zeros(E, device=self.dev)
            more = valid[:, j + 1] if j + 1 < L else torch.zeros(E, dtype=torch.bool, device=self.dev)
            # (An early stop after a severe contact is a terminal failure, not a cut: it must not bootstrap.)
            # Next state value: the env's next decision; at an episode end 0 unless truncated (cut, the record's own
            # value); at the rollout's edge the value of the env's next decision state, observed after the rollout.
            edge = torch.where(hn[:, j], nv[:, j], v[:, j])
            boot = torch.where(d[:, j], torch.where(c[:, j], v[:, j], 0.), torch.where(more, nxt, edge))
            if rate:  # per elapsed second, referenced to `rate` requests/s: 15/30/60 Hz scenes see the same horizon
                # Elapsed time only within the episode: after a terminal row the env's next record belongs to a new episode
                # (its clock restarts at 0), so a terminal or unobserved continuation uses one reference step.
                live = ~d[:, j]
                step = torch.full_like(tm[:, j], 1 / rate)
                dt = torch.where(live & more, (tm[:, j + 1] if j + 1 < L else tm[:, j]) - tm[:, j],
                                 torch.where(live & hn[:, j], nt[:, j] - tm[:, j], step))
                g, gl = gamma ** (dt * rate), (gamma * lam) ** (dt * rate)
            else:
                g, gl = gamma, gamma * lam
            delta = r[:, j] + g * boot - v[:, j]
            run = delta + gl * run * (~d[:, j] & more)
            adv[:, j] = torch.where(valid[:, j], run, 0.)
        a = torch.empty(n, device=self.dev); a[order] = adv[e, col]
        if not torch.isfinite(a).all():
            raise FloatingPointError(f'non-finite advantages: {int((~torch.isfinite(a)).sum())} of {n}')
        return a, a + self.value[:n]


def export(model, value, out, schema, config, contract, metadata):
    model = model.eval().cpu()
    out.mkdir(parents=True)
    atomic_checkpoint(out / 'model.pt', {'format': 'pulse-plan-policy-v1', 'weights': model.state_dict(), 'schema': schema,
                                         'encoderConfig': config, 'contract': contract, 'commit': model.commit})
    torch.save(value.state_dict(), out / 'value.pt')
    for b in [1, 16]:
        torch.onnx.export(model, (torch.zeros(b, schema['size']), torch.zeros(b, schema['hidden'])), out / f'policy-{b}.onnx',
                          dynamo=False, opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        g = onnx.load(out / f'policy-{b}.onnx'); g.ir_version = 10; onnx.checker.check_model(g); onnx.save(g, out / f'policy-{b}.onnx')
    metadata['modelSha256'] = {str(b): hashlib.sha256((out / f'policy-{b}.onnx').read_bytes()).hexdigest() for b in [1, 16]}
    atomic_json(out / 'metadata.json', metadata)
    model.cuda()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--parent', required=True); p.add_argument('--out', required=True)
    p.add_argument('--bank', default='C:/pulse-store/scenes/c186-train'); p.add_argument('--families', default='solo,hazard')
    p.add_argument('--envs', type=int, default=1024); p.add_argument('--horizon', type=float, default=12.)
    p.add_argument('--iterations', type=int, default=40); p.add_argument('--save-every', type=int, default=10)
    p.add_argument('--sigma', type=float, default=.15); p.add_argument('--hold', type=float, default=.5)
    p.add_argument('--lr', type=float, default=1e-4); p.add_argument('--epochs', type=int, default=6)
    p.add_argument('--minibatch', type=int, default=1024)
    p.add_argument('--clip', type=float, default=.2); p.add_argument('--target-kl', type=float, default=.02)
    p.add_argument('--gamma', type=float, default=.995); p.add_argument('--lam', type=float, default=.95)
    p.add_argument('--discount-rate', type=float, default=0., help='requests/s that gamma and lam refer to: discount per elapsed '
                   'time instead of per request (0: per request, the original)')
    p.add_argument('--offset-lag', type=float, default=.15); p.add_argument('--dtype', default='float64')
    p.add_argument('--seed', type=int, default=1); p.add_argument('--cap', type=int, default=0)
    p.add_argument('--rivals', default=None, help='distilled rivals (fit_rivals.py); default executor stand-ins')
    p.add_argument('--rival-offset-lag', type=float, default=.4)
    p.add_argument('--rival-room', type=float, default=0., help='m: distilled rivals give room alongside (0 off)')
    p.add_argument('--rival-room-range', default=None, help='lo,hi m: per-rival room drawn per episode, clamped at 0')
    p.add_argument('--family-weights', default=None, help='family:w,... scene sampling weights (default 1)')
    p.add_argument('--offset-deadband', type=float, default=0.); p.add_argument('--contact', default='v2', choices=['v2', 'v3'])
    p.add_argument('--reward', default='race10-v2', help='cuda_env REWARDS profile')
    p.add_argument('--holdout', type=int, default=4, help='every k-th pool scene is held out for validation (0: none)')
    p.add_argument('--stagger', type=float, default=60., help='s: desynchronise episode phases before the first iteration')
    p.add_argument('--commit', action='store_true', help='add the previous-intent adapter (PlanPolicy.add_commit) to a parent without one')
    p.add_argument('--fresh-critic', action='store_true', help="new value MLP instead of the parent's value.pt")
    p.add_argument('--value-warmup', type=int, default=0, help='first k iterations train only the critic (no policy step)')
    p.add_argument('--train-encoder', action='store_true', help='also train the encoder parts on the head path (recomputed features)')
    p.add_argument('--encoder-lr', type=float, default=1e-5)
    p.add_argument('--anchor', type=float, default=1., help='L2 pull of trained encoder weights toward the parent (sum of squares)')
    p.add_argument('--check-recompute', action='store_true', help='gate G3: one rollout, then recomputed vs stored log-probs '
                   'and gradient norms; no update, no output')
    a = p.parse_args()
    root, out = Path(a.parent), Path(a.out)
    if out.exists() or any(out.parent.glob(out.name + '-it*')):
        raise ValueError('Preserve previous runs; choose a new output')
    torch.manual_seed(a.seed)
    ck = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    schema, config = ck['schema'], ck['encoderConfig']
    model = PlanPolicy(schema, config, commit=ck.get('commit', False)).cuda()
    model.load_state_dict(ck['weights'], strict=True)
    if a.commit and not model.commit:
        model.add_commit()
    trained = [k for k, _ in model.encoder.named_parameters() if k.split('.')[0] in ENCODER_PATH] if a.train_encoder else []
    enc = [q for k, q in model.encoder.named_parameters() if k in trained]
    for q in enc:
        q.requires_grad_(True)
    anchor = [q.detach().clone() for q in enc]
    frozen = {k: v.detach().clone() for k, v in model.encoder.state_dict().items() if k not in trained}
    width = model.width + (4 if model.commit else 0)
    value = nn.Sequential(nn.Linear(width, 128), nn.Tanh(), nn.Linear(128, 128), nn.Tanh(), nn.Linear(128, 1)).cuda()
    if (root / 'value.pt').exists() and not a.fresh_critic:
        value.load_state_dict(torch.load(root / 'value.pt', map_location='cuda', weights_only=True))
    head = list(model.intent.parameters()) + (list(model.adapter.parameters()) if model.commit else [])
    popt = torch.optim.Adam([{'params': head, 'lr': a.lr}] + ([{'params': enc, 'lr': a.encoder_lr}] if enc else []))
    vopt = torch.optim.Adam(value.parameters(), lr=1e-3)
    bank = SceneBank(a.bank)
    pool = [s['id'] for s in bank.scenes if s['family'] in a.families.split(',')]
    fams = {}
    for s in bank.scenes:
        if s['id'] in pool: fams.setdefault(s['family'], []).append(s['id'])
    held = [i for ids in fams.values() for i in ids[::a.holdout]] if a.holdout else []
    train_ids = [i for i in pool if i not in set(held)]
    env = GpuEnv(bank, a.envs, dtype=getattr(torch, a.dtype), seed=a.seed, ids=train_ids, offset_lag=a.offset_lag,
                 rivals=load_rivals(a.rivals) if a.rivals else None, rival_offset_lag=a.rival_offset_lag, rival_room=a.rival_room, rival_room_range=tuple(map(float, a.rival_room_range.split(','))) if a.rival_room_range else None,
                 family_weights={k: float(v) for k, v in (x.split(':') for x in a.family_weights.split(','))} if a.family_weights else None,
                 offset_deadband=a.offset_deadband, contact=a.contact, reward=a.reward)
    E, log_sigma = a.envs, math.log(a.sigma)
    h0 = warm_hidden(model, schema); hidden = h0.expand(E, -1).clone()
    noise = torch.zeros(E, 4, device='cuda'); noise_at = torch.full((E,), -1e9, dtype=torch.float64, device='cuda')
    cum = torch.zeros(E, dtype=torch.float64, device='cuda')  # env.reward already credited
    ticks = int(round(a.horizon * 120)); cap = a.cap or E * (ticks // 2 + 4)  # at most one request per two ticks (one in flight)
    parent_meta = json.loads((root / 'metadata.json').read_text())
    job = JobProgress('GPU PPO', out.name, a.iterations)
    job.update(0, f'desynchronising {E} environments ({a.stagger:.0f} s), then {a.iterations} iterations of {a.horizon:.0f} s')
    # Synchronised starts make whole iterations see the same scene phase; end each env once at a random time first.
    if a.stagger > 0:
        cut = torch.randint(int(a.stagger * 120), (E,), device='cuda')
        for tick in range(int(a.stagger * 120)):
            idx, obs = env.decisions()
            if len(idx):
                with torch.no_grad():
                    act, nh = model(obs.float(), hidden[idx])
                env.post(idx, act); hidden[idx] = nh
            done = env.physics()
            stop = torch.unique(torch.cat([done, (cut == tick).nonzero().squeeze(1)]))
            if len(stop):
                env.end(stop); hidden[stop] = h0
        cum = env.reward.clone()
    history = []
    for it in range(1, a.iterations + 1):
        t0 = time.time(); finished = []
        if it == 1: ro = Rollout(cap, width, E, obs=schema['size'] if enc else 0, hidden=schema['hidden'] if enc else 0)
        else: ro.clear()
        model.eval()
        for _ in range(ticks):
            idx, obs = env.decisions()
            if len(idx):
                with torch.no_grad():
                    feat, present, mean, nh = decide(model, obs.float(), hidden[idx])
                    fresh = (env.t[idx] - noise_at[idx]) >= a.hold - 1e-9
                    f = fresh.nonzero().squeeze(1)
                    noise[idx[f]] = torch.randn(len(f), 4, device='cuda') * a.sigma; noise_at[idx[f]] = env.t[idx[f]]
                    act = mean + noise[idx] * present
                    logp = (-.5 * ((act - mean) / a.sigma).square() - log_sigma).sum(1)
                    v = value(feat).squeeze(1)
                r = env.reward[idx] - cum[idx]; ro.credit(idx, r); cum[idx] = env.reward[idx]
                ro.add(idx, feat, present, act, logp, v, fresh, env.t[idx].float(), *((obs.float(), hidden[idx]) if enc else ()))
                env.post(idx, act)
                hidden[idx] = nh
            done = env.physics()
            if len(done):
                res = env.end(done)
                k = ro.credit(done, res['reward'] - cum[done]); ok = k >= 0
                ro.done[k[ok]] = True; ro.cut[k[ok]] = (~res['complete'] & ~res['severe'])[ok]
                cum[done] = 0; hidden[done] = h0; noise_at[done] = -1e9; ro.last[done] = -1
                finished.append({kk: (vv.cpu() if torch.is_tensor(vv) else vv) for kk, vv in res.items()})
        # Rollout edge: keep driving (not recorded) until each env holding an edge record makes its next decision,
        # whose value bootstraps that record; episodes ending first close it as usual.
        pending = ro.last >= 0
        for _ in range(240):
            if not pending.any():
                break
            idx, obs = env.decisions()
            if len(idx):
                with torch.no_grad():
                    feat, present, mean, nh = decide(model, obs.float(), hidden[idx])
                    fresh = (env.t[idx] - noise_at[idx]) >= a.hold - 1e-9
                    f = fresh.nonzero().squeeze(1)
                    noise[idx[f]] = torch.randn(len(f), 4, device='cuda') * a.sigma; noise_at[idx[f]] = env.t[idx[f]]
                    act = mean + noise[idx] * present
                    p = pending[idx]; k = ro.last[idx[p]]
                    ro.next_value[k] = value(feat[p]).squeeze(1); ro.has_next[k] = True; ro.next_t[k] = env.t[idx[p]].float()
                r = env.reward[idx] - cum[idx]; ro.credit(idx[pending[idx]], r[pending[idx]]); cum[idx] = env.reward[idx]
                pending[idx] = False; ro.last[idx] = -1
                env.post(idx, act); hidden[idx] = nh
            done = env.physics()
            if len(done):
                res = env.end(done)
                k = ro.credit(done, res['reward'] - cum[done]); ok = k >= 0
                ro.done[k[ok]] = True; ro.cut[k[ok]] = (~res['complete'] & ~res['severe'])[ok]
                cum[done] = 0; hidden[done] = h0; noise_at[done] = -1e9; ro.last[done] = -1; pending[done] = False
                finished.append({kk: (vv.cpu() if torch.is_tensor(vv) else vv) for kk, vv in res.items()})
        # Credit what accrued since each env's latest decision (the rollout edge) and keep counting from here.
        live = torch.arange(E, device='cuda'); ro.credit(live, env.reward - cum); cum = env.reward.clone()
        ro.last[:] = -1
        roll_s = time.time() - t0
        adv, ret = ro.gae(a.gamma, a.lam, a.discount_rate)
        n = ro.n; present, action, old = ro.present[:n], ro.action[:n], ro.logp[:n]
        pa = ro.fresh[:n].nonzero().squeeze(1)
        adv = (adv - adv[pa].mean()) / (adv[pa].std() + 1e-8)
        # Same math as collection (no dropout/normalisation layers, so eval mode only makes that explicit).
        model.eval(); stats = []

        def policy_mean(i):
            if enc:  # recompute the head input from the stored observation and hidden: gradients reach the encoder
                f, pr, _ = model.head_input(ro.obs[i], ro.hid[i])
                return model.head(f) * pr
            return model.head(ro.feat[i]) * present[i]

        def critic_input(j):
            if enc:  # current encoder, detached: the critic does not move the encoder
                with torch.no_grad():
                    return model.head_input(ro.obs[j], ro.hid[j])[0]
            return ro.feat[j]

        if a.check_recompute:
            worst = 0.
            with torch.no_grad():
                for s0 in range(0, len(pa), 8192):
                    i = pa[s0:s0 + 8192]
                    lp = (-.5 * ((action[i] - policy_mean(i)) / a.sigma).square() - log_sigma).sum(1)
                    worst = max(worst, float((lp - old[i]).abs().max()))
            i = pa[:a.minibatch]
            lp = (-.5 * ((action[i] - policy_mean(i)) / a.sigma).square() - log_sigma).sum(1)
            popt.zero_grad(); (-(lp * adv[i]).mean()).backward()
            named = [(k, q) for k, q in model.encoder.named_parameters() if k in trained] \
                + [('adapter.' + k, q) for k, q in (model.adapter.named_parameters() if model.commit else [])] \
                + [('intent.' + k, q) for k, q in model.intent.named_parameters()]
            grads = {k: (float(q.grad.norm()) if q.grad is not None else None) for k, q in named}
            print(json.dumps({'checkRecompute': {'decisions': n, 'policySamples': len(pa), 'maxAbsLogpDiff': worst, 'gradNorms': grads}}), flush=True)
            return
        for epoch in range(a.epochs):
            order = pa[torch.randperm(len(pa), device='cuda')]; kls = []
            for s in range(0, len(order), a.minibatch):
                i = order[s:s + a.minibatch]
                mean = policy_mean(i)
                logp = (-.5 * ((action[i] - mean) / a.sigma).square() - log_sigma).sum(1)
                ratio = (logp - old[i]).exp()
                pg = -torch.min(ratio * adv[i], ratio.clamp(1 - a.clip, 1 + a.clip) * adv[i]).mean()
                if enc:
                    pg = pg + a.anchor * sum((q - q0).square().sum() for q, q0 in zip(enc, anchor))
                if it > a.value_warmup:
                    popt.zero_grad(); pg.backward(); torch.nn.utils.clip_grad_norm_(head + enc, .5); popt.step()
                j = torch.randint(n, (4096,), device='cuda')
                vl = (value(critic_input(j)).squeeze(1) - ret[j]).square().mean()
                vopt.zero_grad(); vl.backward(); vopt.step()
                kls.append((old[i] - logp.detach()).mean().item())
            stats.append(float(np.mean(kls)))
            if stats[-1] > a.target_kl:
                break
        if any(not torch.equal(v, frozen[k]) for k, v in model.encoder.state_dict().items() if k in frozen):
            raise ValueError('PPO changed the frozen encoder')
        row = {'iteration': it, 'decisions': n, 'policySamples': len(pa), 'rolloutSeconds': round(roll_s, 1), 'wallSeconds': round(time.time() - t0, 1),
               'meanReward': round(ro.reward[:n].sum().item() / E / a.horizon, 4), 'epochs': len(stats), 'kl': round(stats[-1], 5), 'valueLoss': round(vl.item(), 4),
               'policyStep': it > a.value_warmup}
        if model.commit:
            row['adapterOut'] = round(float(model.adapter[2].weight.norm()), 4)
        if enc:
            row['encoderDrift'] = round(math.sqrt(sum(float((q - q0).square().sum()) for q, q0 in zip(enc, anchor)) /
                                                  sum(float(q0.square().sum()) for q0 in anchor)), 6)
        if finished:
            cat = {k: torch.cat([f[k] for f in finished]) for k in ('success', 'damage', 'limit', 'severe', 'scene', 'hazards', 'progress', 'held')}
            fam = [bank.scenes[s]['family'] for s in cat['scene'].tolist()]
            row.update({'episodes': len(fam), 'success': round(cat['success'].double().mean().item(), 3), 'damage': round(cat['damage'].mean().item(), 4),
                        'limitSeconds': round(cat['limit'].mean().item(), 2), 'heldSeconds': round(cat['held'].mean().item(), 2), 'severe': round(cat['severe'].double().mean().item(), 3),
                        'byFamily': {f: round(float(np.mean([s for s, g in zip(cat['success'].tolist(), fam) if g == f])), 3) for f in sorted(set(fam))}})
        history.append(row); print(json.dumps(row), flush=True)
        fam = ' · '.join(f'{k} {v * 100:.0f}%' for k, v in row.get('byFamily', {}).items())
        job.update(it, f"iteration {it}/{a.iterations} · reward/s {row['meanReward']:.3f} · train success {fam or '—'} · damage {row.get('damage', 0) * 100:.1f}% · {row['wallSeconds']:.0f} s/iteration",
                   {'iteration': it, 'success': row.get('success', history[-2].get('success', 0) if len(history) > 1 else 0), 'meanReturn': row['meanReward'],
                    'damage': row.get('damage', 0), 'dev': None}, status='complete' if it == a.iterations else 'running')
        if it % a.save_every == 0 or it == a.iterations:
            dest = out.parent / f'{out.name}-it{it:03d}'
            meta = dict(parent_meta)
            meta.update({'checkpointDirectory': dest.as_posix(), 'parentModelSha256': parent_meta.get('modelSha256'), 'stage': 'GPU PPO fine-tune',
                         'ppoGpu': {'arguments': vars(a), 'reward': REWARDS[a.reward], 'iteration': it, 'heldOut': held, 'history': history}})
            export(model, value, dest, schema, config, {'ppoGpu': vars(a), 'reward': REWARDS[a.reward], 'iteration': it}, meta)
            print('saved', dest, flush=True)


if __name__ == '__main__':
    main()
