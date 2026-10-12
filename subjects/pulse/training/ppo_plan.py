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
from pathlib import Path
import numpy as np
import torch
from torch import nn
import onnx
from plan_model import PlanPolicy
from checkpoint_state import atomic_json, atomic_checkpoint

REWARD = {'progress': 1 / 50, 'damage': 300., 'offtrack': 2., 'contact': .5, 'severe': 5., 'jerk': .2,
          'pass': 3., 'hazard': 2., 'success': 5.}


def episode_tensors(file, model, schema):
    lines = [json.loads(l) for l in Path(file).read_text().splitlines() if l.strip()]
    head, steps, summary = lines[0], [l for l in lines if l['type'] == 'step'], lines[-1]
    if head['format'] != 'pulse-rl-rollout-v1' or head['schema'] != schema or summary['type'] != 'summary' or len(steps) < 64:
        return None
    x = torch.tensor([s['observation'] for s in steps], device='cuda')
    with torch.inference_mode():
        inputs, present = model.sequence_inputs(x)
    t = np.array([s['time'] for s in steps])
    prog = np.array([s['progress'] for s in steps])
    dmg = np.array([s['damage'] for s in steps])
    lat = np.array([s['lateral'] for s in steps])
    steer = np.array([s['steer'] for s in steps])
    dt = np.diff(t, append=t[-1] + (t[-1] - t[-2]))
    r = np.zeros(len(steps))
    r[:-1] += REWARD['progress'] * np.diff(prog)
    r[:-1] -= REWARD['damage'] * np.clip(np.diff(dmg), 0, None)
    r -= REWARD['offtrack'] * dt * (np.abs(lat) > head['limit'])
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
            'action': torch.tensor([s['action'] for s in steps], device='cuda'),
            'reward': torch.tensor(r, device='cuda', dtype=torch.float32), 'summary': summary,
            'case': head['case'], 'sigma': head['sigma']}


def gae(reward, value, gamma, lam):
    adv = torch.zeros_like(reward)
    last = 0.
    for k in range(len(reward) - 1, -1, -1):
        nxt = value[k + 1] if k + 1 < len(reward) else 0.
        delta = reward[k] + gamma * nxt - value[k]
        last = delta + gamma * lam * last
        adv[k] = last
    return adv, adv + value


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--parent', required=True); p.add_argument('--rollouts', required=True); p.add_argument('--out', required=True)
    p.add_argument('--bc', default=None); p.add_argument('--bc-weight', type=float, default=.5)
    p.add_argument('--lr', type=float, default=3e-4); p.add_argument('--epochs', type=int, default=4)
    p.add_argument('--clip', type=float, default=.2); p.add_argument('--target-kl', type=float, default=.02)
    p.add_argument('--gamma', type=float, default=.995); p.add_argument('--lam', type=float, default=.95)
    p.add_argument('--seed', type=int, default=11)
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
    warm = not (root / 'value.pt').exists()
    if not warm:
        value.load_state_dict(torch.load(root / 'value.pt', map_location='cuda', weights_only=True))
    episodes = [e for e in (episode_tensors(f, model, schema) for f in sorted(Path(args.rollouts).glob('*.jsonl'))) if e]
    if len(episodes) < 8:
        raise ValueError('Too few rollouts')
    sigma = episodes[0]['sigma']; log_sigma = math.log(sigma)
    vopt = torch.optim.Adam(value.parameters(), lr=1e-3)
    if warm:  # a new critic first fits Monte Carlo returns
        for e in episodes:
            g, mc = 0., torch.zeros_like(e['reward'])
            for k in range(len(mc) - 1, -1, -1):
                g = e['reward'][k] + args.gamma * g; mc[k] = g
            e['mc'] = mc
        for _ in range(300):
            e = episodes[rng.integers(len(episodes))]
            vopt.zero_grad(); loss = (value(e['inputs']).squeeze(1) - e['mc']).square().mean(); loss.backward(); vopt.step()
    with torch.no_grad():
        for e in episodes:
            v = value(e['inputs']).squeeze(1)
            e['adv'], e['ret'] = gae(e['reward'], v, args.gamma, args.lam)
            mean = model.intent(e['inputs']) * e['present']
            e['logp'] = (-.5 * ((e['action'] - mean) / sigma).square() - log_sigma).sum(1)
    cat = lambda k: torch.cat([e[k] for e in episodes])
    inputs, present, action, adv, ret, old = cat('inputs'), cat('present'), cat('action'), cat('adv'), cat('ret'), cat('logp')
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    bc = None
    if args.bc:
        xs, ps, ys = [], [], []
        for f in sorted((Path(args.bc) / 'train').glob('*.jsonl')):
            rows = [json.loads(l) for l in f.read_text().splitlines()[1:] if l.strip()]
            x = torch.tensor([r['observation'] for r in rows], device='cuda')
            with torch.inference_mode():
                i, pr = model.sequence_inputs(x)
            xs.append(i.clone()); ps.append(pr.clone()); ys.append(torch.tensor([r['target'] for r in rows], device='cuda'))
        bc = (torch.cat(xs), torch.cat(ps), torch.cat(ys))
    popt = torch.optim.Adam(model.intent.parameters(), lr=args.lr)
    n, stats = len(adv), []
    for epoch in range(args.epochs):
        order = torch.randperm(n, device='cuda'); kls = []
        for s in range(0, n, 4096):
            idx = order[s:s + 4096]
            mean = model.intent(inputs[idx]) * present[idx]
            logp = (-.5 * ((action[idx] - mean) / sigma).square() - log_sigma).sum(1)
            ratio = (logp - old[idx]).exp()
            pg = -torch.min(ratio * adv[idx], ratio.clamp(1 - args.clip, 1 + args.clip) * adv[idx]).mean()
            loss = pg
            if bc is not None:
                j = torch.randint(len(bc[2]), (2048,), device='cuda')
                pred = model.intent(bc[0][j]) * bc[1][j]
                loss = loss + args.bc_weight * ((pred - bc[2][j]).square() * pred.new_tensor([4., 4., 4., 1.])).mean()
            popt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.intent.parameters(), .5); popt.step()
            vopt.zero_grad(); vl = (value(inputs[idx]).squeeze(1) - ret[idx]).square().mean(); vl.backward(); vopt.step()
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
