"""PPO fine-tuning of the PULSE route head on its own physical rollouts.

The encoder stays frozen (bitwise); only the intent head (policy mean) and a
separate value MLP learn. Rollouts come from tools/rl-rollout.mjs (TRAIN-pool
scenes, Gaussian exploration held for 0.5 s). An optional behaviour-cloning
anchor on teacher labels keeps early updates near competent driving.
Reward: track progress (pace), minus damage, track-limit time, contact and
steering jerk; plus retained passes, cleared hazards and scene success.
"""
import argparse
import hashlib
import json
import math
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
import torch
from torch import nn
import onnx
from plan_model import PlanPolicy
from ppo_parse import parse_rollout, parse_targets
from checkpoint_state import atomic_json, atomic_checkpoint

# Contacts cost what they cost the evaluation, charged when they happen: the success bonus at the
# end of a 70 s scene is invisible to a decision 40 s earlier (horizon ~7 s at gamma .995 / ~30 Hz).
REWARD = {'progress': 1 / 50, 'damage': 300., 'offtrack': 2., 'contact': 3., 'severe': 10., 'jerk': .2,
          'pass': 3., 'hazard': 2., 'success': 5.}


def episode_tensors(parsed, model, schema):
    head, summary, a = parsed
    steps = a['time']
    if head['format'] != 'pulse-rl-rollout-v2' or head['schema'] != schema or summary['type'] != 'summary' or len(steps) < 64:
        return None
    with torch.inference_mode():
        inputs, present = model.sequence_inputs(torch.from_numpy(a['observation']).cuda())
    t = a['time'].astype(np.float64)
    prog, dmg, lat, steer = (a[k].astype(np.float64) for k in ('progress', 'damage', 'lateral', 'steer'))
    dt = np.diff(t, append=t[-1] + (t[-1] - t[-2]))
    r = np.zeros(len(steps))
    r[:-1] += REWARD['progress'] * np.diff(prog)
    r[:-1] -= REWARD['damage'] * np.clip(np.diff(dmg), 0, None)
    # Track limits by the game's own wheel/kerb rule (violation intervals from the simulator).
    outside, start = np.zeros(len(t), dtype=bool), None
    for e in sorted(summary['events'], key=lambda e: e['time']):
        if e['type'] == 'track-limit-violation' and start is None:
            start = e['time']
        elif e['type'] == 'inside-track-limits' and start is not None:
            outside |= (t >= start) & (t < e['time']); start = None
    if start is not None:
        outside |= t >= start
    r -= REWARD['offtrack'] * dt * outside
    r[:-1] -= REWARD['jerk'] * np.abs(np.diff(steer))
    for e in summary['events']:
        k = min(len(t) - 1, int(np.searchsorted(t, e['time'])))
        if e['type'] == 'retained-pass':
            r[k] += REWARD['pass']
        elif e['type'] == 'hazard-cleared':
            r[k] += REWARD['hazard']
        elif e['type'] == 'contact' and e['self']:
            r[k] -= REWARD['severe'] if (e.get('closing') or 0) > 6 else REWARD['contact']
    if summary['success']:
        r[-1] += REWARD['success']
    return {'inputs': inputs.clone(), 'present': present.clone(),
            'action': torch.from_numpy(a['raw']).cuda(), 'fresh': torch.from_numpy(a['fresh'] > 0).cuda(), 'rewardNp': r,
            'reward': torch.tensor(r, device='cuda', dtype=torch.float32), 'summary': summary,
            'case': head['case'], 'sigma': head['sigma']}


def discounted(x, factor):
    # Reverse discounted sum on the CPU (a per-element CUDA loop costs a kernel launch per step).
    out, run = np.empty_like(x), 0.
    for k in range(len(x) - 1, -1, -1):
        run = x[k] + factor * run; out[k] = run
    return out


def gae(reward, value, gamma, lam, truncated=False):
    # An early-stopped scene is cut, not ended: its remainder is bootstrapped from the last value.
    v = value.detach().cpu().numpy().astype(np.float64)
    delta = reward + gamma * np.append(v[1:], v[-1] if truncated else 0.) - v
    adv = discounted(delta, gamma * lam)
    adv = torch.tensor(adv, device=value.device, dtype=torch.float32)
    return adv, adv + value


def bc_inputs(bc_dir, model, cache_dir, stride, pool):
    # The encoder is frozen, so encoded teacher rows are identical every iteration: encode once, cache on disk.
    key = hashlib.sha256(b''.join(v.detach().cpu().numpy().tobytes() for v in model.encoder.state_dict().values())).hexdigest()[:16]
    cache = Path(cache_dir) / f'bc-{Path(bc_dir).name}-s{stride}-{key}.pt'
    if cache.exists():
        x, p, y = torch.load(cache, weights_only=True)
        return x.cuda(), p.cuda(), y.cuda()
    files = sorted((Path(bc_dir) / 'train').glob('*.jsonl'))
    xs, ps, ys = [], [], []
    for obs, target in pool.map(parse_targets, files, [stride] * len(files), chunksize=4):
        with torch.inference_mode():
            i, pr = model.sequence_inputs(torch.from_numpy(obs).cuda())
        xs.append(i.half().cpu()); ps.append(pr.half().cpu()); ys.append(torch.from_numpy(target))
    x, p, y = torch.cat(xs), torch.cat(ps), torch.cat(ys)
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix('.tmp'); torch.save((x, p, y), tmp); os.replace(tmp, cache)
    return x.cuda(), p.cuda(), y.cuda()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--parent', required=True); p.add_argument('--rollouts', required=True); p.add_argument('--out', required=True)
    p.add_argument('--bc', default=None); p.add_argument('--bc-weight', type=float, default=.5)
    p.add_argument('--lr', type=float, default=3e-4); p.add_argument('--epochs', type=int, default=4)
    p.add_argument('--clip', type=float, default=.2); p.add_argument('--target-kl', type=float, default=.02)
    p.add_argument('--gamma', type=float, default=.995); p.add_argument('--lam', type=float, default=.95)
    p.add_argument('--seed', type=int, default=11)
    p.add_argument('--cache', default=None); p.add_argument('--bc-stride', type=int, default=2)
    p.add_argument('--procs', type=int, default=8)
    p.add_argument('--fresh-value', action='store_true')
    args = p.parse_args()
    root, out = Path(args.parent), Path(args.out)
    if out.exists():
        raise ValueError('Preserve previous iteration; choose a new output')
    torch.manual_seed(args.seed); rng = np.random.default_rng(args.seed)
    parent = json.loads((root / 'metadata.json').read_text())
    ck = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    schema, config = ck['schema'], ck['encoderConfig']
    model = PlanPolicy(schema, config).to('cuda')
    model.load_state_dict(ck['weights'], strict=True)
    frozen = {k: v.detach().cpu().clone() for k, v in model.encoder.state_dict().items()}
    width = schema['hidden'] + model.encoder.own_size + 64
    value = nn.Sequential(nn.Linear(width, 128), nn.Tanh(), nn.Linear(128, 128), nn.Tanh(), nn.Linear(128, 1)).to('cuda')
    p_fresh = args.fresh_value  # a changed reward invalidates the parent's critic
    warm = p_fresh or not (root / 'value.pt').exists()
    if not warm:
        value.load_state_dict(torch.load(root / 'value.pt', map_location='cuda', weights_only=True))
    pool = ProcessPoolExecutor(args.procs)
    files = sorted(Path(args.rollouts).glob('*.jsonl'))
    episodes = [e for e in (episode_tensors(r, model, schema) for r in pool.map(parse_rollout, files)) if e]
    if len(episodes) < 8:
        raise ValueError('Too few rollouts')
    sigma = episodes[0]['sigma']; log_sigma = math.log(sigma)
    vopt = torch.optim.Adam(value.parameters(), lr=1e-3)
    if warm:  # a new critic first fits Monte Carlo returns
        for e in episodes:
            e['mc'] = torch.tensor(discounted(e['rewardNp'], args.gamma), device='cuda', dtype=torch.float32)
        for _ in range(300):
            e = episodes[rng.integers(len(episodes))]
            vopt.zero_grad(); loss = (value(e['inputs']).squeeze(1) - e['mc']).square().mean(); loss.backward(); vopt.step()
    with torch.no_grad():
        for e in episodes:
            v = value(e['inputs']).squeeze(1)
            e['adv'], e['ret'] = gae(e['rewardNp'], v, args.gamma, args.lam, e['summary'].get('truncated', False))
            mean = model.intent(e['inputs']) * e['present']
            e['logp'] = (-.5 * ((e['action'] - mean) / sigma).square() - log_sigma).sum(1)
    cat = lambda k: torch.cat([e[k] for e in episodes])
    inputs, present, action, adv, ret, old = cat('inputs'), cat('present'), cat('action'), cat('adv'), cat('ret'), cat('logp')
    fresh = cat('fresh')
    # Value learns on every step; the policy only on exploration decisions (one per hold).
    pa = fresh.nonzero().squeeze(1)
    adv = (adv - adv[pa].mean()) / (adv[pa].std() + 1e-8)
    bc = None
    if args.bc:
        bc = bc_inputs(args.bc, model, args.cache or Path(args.bc) / 'ppo-cache', args.bc_stride, pool)
    pool.shutdown()
    popt = torch.optim.Adam(model.intent.parameters(), lr=args.lr)
    n, stats = len(pa), []
    for epoch in range(args.epochs):
        order = pa[torch.randperm(n, device='cuda')]; kls = []
        for s in range(0, n, 512):
            idx = order[s:s + 512]
            vidx = torch.randint(len(ret), (4096,), device='cuda')
            mean = model.intent(inputs[idx]) * present[idx]
            logp = (-.5 * ((action[idx] - mean) / sigma).square() - log_sigma).sum(1)
            ratio = (logp - old[idx]).exp()
            pg = -torch.min(ratio * adv[idx], ratio.clamp(1 - args.clip, 1 + args.clip) * adv[idx]).mean()
            loss = pg
            if bc is not None:
                j = torch.randint(len(bc[2]), (2048,), device='cuda')
                pred = model.intent(bc[0][j].float()) * bc[1][j].float()
                loss = loss + args.bc_weight * ((pred - bc[2][j]).square() * pred.new_tensor([4., 4., 4., 1.])).mean()
            popt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.intent.parameters(), .5); popt.step()
            vopt.zero_grad(); vl = (value(inputs[vidx]).squeeze(1) - ret[vidx]).square().mean(); vl.backward(); vopt.step()
            kls.append((old[idx] - logp.detach()).mean().item())
        stats.append({'epoch': epoch + 1, 'kl': float(np.mean(kls)), 'policyLoss': pg.item(), 'valueLoss': vl.item()})
        if np.mean(kls) > args.target_kl:
            break
    model.eval().cpu()
    if any(not torch.equal(v, frozen[k]) for k, v in model.encoder.state_dict().items()):
        raise ValueError('PPO changed the frozen encoder')
    out.mkdir(parents=True)
    atomic_checkpoint(out / 'model.pt', {'format': 'pulse-plan-policy-v1', 'weights': model.state_dict(), 'schema': schema,
                                         'encoderConfig': config, 'contract': {'ppo': vars(args), 'reward': REWARD}})
    torch.save(value.state_dict(), out / 'value.pt')
    for b in [1, 16]:
        torch.onnx.export(model, (torch.zeros(b, schema['size']), torch.zeros(b, schema['hidden'])), out / f'policy-{b}.onnx',
                          dynamo=False, opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        g = onnx.load(out / f'policy-{b}.onnx'); g.ir_version = 10; onnx.checker.check_model(g); onnx.save(g, out / f'policy-{b}.onnx')
    summaries = [e['summary'] for e in episodes]
    report = {'episodes': len(episodes), 'success': float(np.mean([s['success'] for s in summaries])),
              'meanReturn': float(np.mean([e['reward'].sum().item() for e in episodes])),
              'damage': float(np.mean([s['damage'] for s in summaries])), 'passes': float(np.mean([s['passes'] for s in summaries])),
              'trackLimitSeconds': float(np.mean([s['trackLimitSeconds'] for s in summaries])), 'updates': stats}
    metadata = dict(parent)
    metadata.update({'checkpointDirectory': out.as_posix(), 'parentModelSha256': parent['modelSha256'], 'stage': 'PPO fine-tune',
                     'ppo': {'arguments': vars(args), 'reward': REWARD, 'iteration': report},
                     'modelSha256': {str(b): hashlib.sha256((out / f'policy-{b}.onnx').read_bytes()).hexdigest() for b in [1, 16]}})
    atomic_json(out / 'metadata.json', metadata)
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
