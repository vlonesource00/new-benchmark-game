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
from cuda_env import SceneBank, GpuEnv, REWARD
from fit_rivals import load_rivals


def features(model, obs, hidden):
    """PlanPolicy.forward split at the head: (head input, presence, next hidden)."""
    own, encoded, present = model.encoded(obs)
    ir, iz, inn = model.encoder.traffic_input_gates(encoded).chunk(3, 1)
    hr, hz, hn = model.encoder.traffic_hidden_gates(hidden[:, :64]).chunk(3, 1)
    reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
    memory = ((1 - update) * torch.tanh(inn + reset * hn) + update * hidden[:, :64]) * present
    return torch.cat([encoded, own, memory], 1), present, torch.cat([memory, torch.zeros_like(hidden[:, 64:])], 1)


def warm_hidden(model, schema):
    """driveCases warms the recurrent state with 30 all-zero observations before each run."""
    h = torch.zeros(1, schema['hidden'], device='cuda')
    with torch.no_grad():
        for _ in range(30):
            _, h = model(torch.zeros(1, schema['size'], device='cuda'), h)
    return h[0]


class Rollout:
    """Decision records in collection order; rewards land on an env's latest record."""
    def __init__(self, cap, width, E):
        z = lambda *s, t=torch.float32: torch.zeros(*s, dtype=t, device='cuda')
        self.feat, self.present, self.action = z(cap, width), z(cap, 1), z(cap, 4)
        self.logp, self.value, self.reward = z(cap), z(cap), z(cap)
        self.fresh, self.done, self.cut = z(cap, t=torch.bool), z(cap, t=torch.bool), z(cap, t=torch.bool)
        self.env, self.n, self.last = z(cap, t=torch.long), 0, torch.full((E,), -1, dtype=torch.long, device='cuda')

    def add(self, idx, feat, present, action, logp, value, fresh):
        k = torch.arange(self.n, self.n + len(idx), device='cuda')
        if self.n + len(idx) > len(self.env):
            raise ValueError('Rollout buffer full; raise --cap')
        self.feat[k], self.present[k], self.action[k], self.logp[k], self.value[k], self.fresh[k] = feat, present, action, logp, value, fresh
        self.env[k] = idx; self.last[idx] = k; self.n += len(idx)

    def credit(self, idx, r):
        k = self.last[idx]; ok = k >= 0
        self.reward.index_put_((k[ok],), r[ok].float(), accumulate=True)
        return k

    def gae(self, gamma, lam):
        n, env = self.n, self.env[:self.n]
        order = torch.argsort(env * (n + 1) + torch.arange(n, device='cuda'))
        e = env[order]
        counts = torch.bincount(e, minlength=int(self.last.numel()))
        start = torch.cumsum(counts, 0) - counts
        col = torch.arange(n, device='cuda') - start[e]
        L, E = int(counts.max()), len(counts)
        pad = lambda x, fill=0.: torch.full((E, L), fill, dtype=x.dtype, device='cuda').index_put_((e, col), x[order])
        r, v, d, c = pad(self.reward[:n]), pad(self.value[:n]), pad(self.done[:n], False), pad(self.cut[:n], False)
        valid = pad(torch.ones(n, dtype=torch.bool, device='cuda'), False)
        adv = torch.zeros(E, L, device='cuda'); run = torch.zeros(E, device='cuda')
        for j in range(L - 1, -1, -1):
            nxt = v[:, j + 1] if j + 1 < L else torch.zeros(E, device='cuda')
            more = valid[:, j + 1] if j + 1 < L else torch.zeros(E, dtype=torch.bool, device='cuda')
            # Next state value: the env's next decision; at an episode end 0 unless truncated (cut); at the
            # rollout's edge (no next record) bootstrap with the record's own value.
            boot = torch.where(d[:, j], torch.where(c[:, j], v[:, j], 0.), torch.where(more, nxt, v[:, j]))
            delta = r[:, j] + gamma * boot - v[:, j]
            run = delta + gamma * lam * run * (~d[:, j] & more)
            adv[:, j] = torch.where(valid[:, j], run, 0.)
        a = torch.empty(n, device='cuda'); a[order] = adv[e, col]
        return a, a + self.value[:n]


def export(model, value, out, schema, config, contract, metadata):
    model = model.eval().cpu()
    out.mkdir(parents=True)
    atomic_checkpoint(out / 'model.pt', {'format': 'pulse-plan-policy-v1', 'weights': model.state_dict(), 'schema': schema,
                                         'encoderConfig': config, 'contract': contract})
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
    p.add_argument('--offset-lag', type=float, default=.15); p.add_argument('--dtype', default='float64')
    p.add_argument('--seed', type=int, default=1); p.add_argument('--cap', type=int, default=0)
    p.add_argument('--rivals', default=None, help='distilled rivals (fit_rivals.py); default executor stand-ins')
    p.add_argument('--rival-offset-lag', type=float, default=.4)
    p.add_argument('--holdout', type=int, default=4, help='every k-th pool scene is held out for validation (0: none)')
    p.add_argument('--stagger', type=float, default=60., help='s: desynchronise episode phases before the first iteration')
    a = p.parse_args()
    root, out = Path(a.parent), Path(a.out)
    if out.exists() or any(out.parent.glob(out.name + '-it*')):
        raise ValueError('Preserve previous runs; choose a new output')
    torch.manual_seed(a.seed)
    ck = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    schema, config = ck['schema'], ck['encoderConfig']
    model = PlanPolicy(schema, config).cuda()
    model.load_state_dict(ck['weights'], strict=True)
    frozen = {k: v.detach().clone() for k, v in model.encoder.state_dict().items()}
    width = schema['hidden'] + model.encoder.own_size + 64
    value = nn.Sequential(nn.Linear(width, 128), nn.Tanh(), nn.Linear(128, 128), nn.Tanh(), nn.Linear(128, 1)).cuda()
    if (root / 'value.pt').exists():
        value.load_state_dict(torch.load(root / 'value.pt', map_location='cuda', weights_only=True))
    popt = torch.optim.Adam(model.intent.parameters(), lr=a.lr); vopt = torch.optim.Adam(value.parameters(), lr=1e-3)
    bank = SceneBank(a.bank)
    pool = [s['id'] for s in bank.scenes if s['family'] in a.families.split(',')]
    held = pool[::a.holdout] if a.holdout else []
    train_ids = [i for i in pool if i not in set(held)]
    env = GpuEnv(bank, a.envs, dtype=getattr(torch, a.dtype), seed=a.seed, ids=train_ids, offset_lag=a.offset_lag,
                 rivals=load_rivals(a.rivals) if a.rivals else None, rival_offset_lag=a.rival_offset_lag)
    E, log_sigma = a.envs, math.log(a.sigma)
    h0 = warm_hidden(model, schema); hidden = h0.expand(E, -1).clone()
    noise = torch.zeros(E, 4, device='cuda'); noise_at = torch.full((E,), -1e9, dtype=torch.float64, device='cuda')
    cum = torch.zeros(E, dtype=torch.float64, device='cuda')  # env.reward already credited
    ticks = int(round(a.horizon * 120)); cap = a.cap or E * (ticks // 2 + 4)  # at most one request per two ticks (one in flight)
    parent_meta = json.loads((root / 'metadata.json').read_text())
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
        t0 = time.time(); ro = Rollout(cap, width, E); finished = []
        model.eval()
        for _ in range(ticks):
            idx, obs = env.decisions()
            if len(idx):
                with torch.no_grad():
                    feat, present, nh = features(model, obs.float(), hidden[idx])
                    mean = model.intent(feat) * present
                    fresh = (env.t[idx] - noise_at[idx]) >= a.hold - 1e-9
                    f = fresh.nonzero().squeeze(1)
                    noise[idx[f]] = torch.randn(len(f), 4, device='cuda') * a.sigma; noise_at[idx[f]] = env.t[idx[f]]
                    act = mean + noise[idx] * present
                    logp = (-.5 * ((act - mean) / a.sigma).square() - log_sigma).sum(1)
                    v = value(feat).squeeze(1)
                r = env.reward[idx] - cum[idx]; ro.credit(idx, r); cum[idx] = env.reward[idx]
                ro.add(idx, feat, present, act, logp, v, fresh)
                env.post(idx, act)
                hidden[idx] = nh
            done = env.physics()
            if len(done):
                res = env.end(done)
                k = ro.credit(done, res['reward'] - cum[done]); ok = k >= 0
                ro.done[k[ok]] = True; ro.cut[k[ok]] = ~res['complete'][ok]
                cum[done] = 0; hidden[done] = h0; noise_at[done] = -1e9; ro.last[done] = -1
                finished.append({kk: (vv.cpu() if torch.is_tensor(vv) else vv) for kk, vv in res.items()})
        # Credit what accrued since each env's latest decision (the rollout edge) and keep counting from here.
        live = torch.arange(E, device='cuda'); ro.credit(live, env.reward - cum); cum = env.reward.clone()
        ro.last[:] = -1
        roll_s = time.time() - t0
        adv, ret = ro.gae(a.gamma, a.lam)
        n = ro.n; feat, present, action, old = ro.feat[:n], ro.present[:n], ro.action[:n], ro.logp[:n]
        pa = ro.fresh[:n].nonzero().squeeze(1)
        adv = (adv - adv[pa].mean()) / (adv[pa].std() + 1e-8)
        model.train(); stats = []
        for epoch in range(a.epochs):
            order = pa[torch.randperm(len(pa), device='cuda')]; kls = []
            for s in range(0, len(order), a.minibatch):
                i = order[s:s + a.minibatch]
                mean = model.intent(feat[i]) * present[i]
                logp = (-.5 * ((action[i] - mean) / a.sigma).square() - log_sigma).sum(1)
                ratio = (logp - old[i]).exp()
                pg = -torch.min(ratio * adv[i], ratio.clamp(1 - a.clip, 1 + a.clip) * adv[i]).mean()
                popt.zero_grad(); pg.backward(); torch.nn.utils.clip_grad_norm_(model.intent.parameters(), .5); popt.step()
                j = torch.randint(n, (4096,), device='cuda')
                vl = (value(feat[j]).squeeze(1) - ret[j]).square().mean()
                vopt.zero_grad(); vl.backward(); vopt.step()
                kls.append((old[i] - logp.detach()).mean().item())
            stats.append(float(np.mean(kls)))
            if stats[-1] > a.target_kl:
                break
        if any(not torch.equal(v, frozen[k]) for k, v in model.encoder.state_dict().items()):
            raise ValueError('PPO changed the frozen encoder')
        row = {'iteration': it, 'decisions': n, 'policySamples': len(pa), 'rolloutSeconds': round(roll_s, 1), 'wallSeconds': round(time.time() - t0, 1),
               'meanReward': round(ro.reward[:n].sum().item() / E / a.horizon, 4), 'epochs': len(stats), 'kl': round(stats[-1], 5), 'valueLoss': round(vl.item(), 4)}
        if finished:
            cat = {k: torch.cat([f[k] for f in finished]) for k in ('success', 'damage', 'limit', 'severe', 'scene', 'hazards', 'progress')}
            fam = [bank.scenes[s]['family'] for s in cat['scene'].tolist()]
            row.update({'episodes': len(fam), 'success': round(cat['success'].double().mean().item(), 3), 'damage': round(cat['damage'].mean().item(), 4),
                        'limitSeconds': round(cat['limit'].mean().item(), 2), 'severe': round(cat['severe'].double().mean().item(), 3),
                        'byFamily': {f: round(float(np.mean([s for s, g in zip(cat['success'].tolist(), fam) if g == f])), 3) for f in sorted(set(fam))}})
        history.append(row); print(json.dumps(row), flush=True)
        if it % a.save_every == 0 or it == a.iterations:
            dest = out.parent / f'{out.name}-it{it:03d}'
            meta = dict(parent_meta)
            meta.update({'checkpointDirectory': dest.as_posix(), 'parentModelSha256': parent_meta.get('modelSha256'), 'stage': 'GPU PPO fine-tune',
                         'ppoGpu': {'arguments': vars(a), 'reward': REWARD, 'iteration': it, 'heldOut': held, 'history': history}})
            export(model, value, dest, schema, config, {'ppoGpu': vars(a), 'reward': REWARD, 'iteration': it}, meta)
            print('saved', dest, flush=True)


if __name__ == '__main__':
    main()
