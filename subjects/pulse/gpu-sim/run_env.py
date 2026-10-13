"""Drive the GPU env with a PULSE plan checkpoint (policy mean, or sampled with --sigma) and report episode
outcomes per scene family plus throughput; optionally write episode recordings for the lab's GPU viewer.
  python gpu-sim/run_env.py --bank C:/pulse-store/scenes/c186-train --model artifacts/models/c196-ppo-it040 --envs 256 --episodes 400
"""
import argparse, json, os, sys, time
from pathlib import Path
import torch
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'training'))
from cuda_env import SceneBank, GpuEnv
from plan_model import PlanPolicy
from fit_rivals import load_rivals
from job_progress import JobProgress


def load_policy(path):
    ck = torch.load(Path(path) / 'model.pt', map_location='cpu', weights_only=True)
    model = PlanPolicy(ck['schema'], ck['encoderConfig']).cuda().eval()
    model.load_state_dict(ck['weights'], strict=True)
    return model, ck['schema']


def warm_hidden(model, schema):
    """driveCases warms the recurrent state with 30 all-zero observations before each run."""
    h = torch.zeros(1, schema['hidden'], device='cuda')
    with torch.no_grad():
        for _ in range(30):
            _, h = model(torch.zeros(1, schema['size'], device='cuda'), h)
    return h[0]


def activations(model, obs, hidden):
    """Every PlanPolicy layer for the lab's network view; out equals model(obs, hidden)[0]."""
    own_input, own, mean, maximum, present = model.encoder.features(obs)
    encoded = torch.cat([own, mean, maximum], 1)
    ir, iz, inn = model.encoder.traffic_input_gates(encoded).chunk(3, 1)
    hr, hz, hn = model.encoder.traffic_hidden_gates(hidden[:, :64]).chunk(3, 1)
    reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
    memory = ((1 - update) * torch.tanh(inn + reset * hn) + update * hidden[:, :64]) * present
    hid = model.intent[1](model.intent[0](torch.cat([encoded, own_input, memory], 1)))
    out = model.intent[3](model.intent[2](hid)) * present
    return {'obs': obs, 'own': own, 'mean': mean, 'max': maximum, 'mem': memory, 'upd': update, 'hid': hid, 'out': out}


def network(model, schema):
    """Layer layout and the intent head's weights (the only dense layers drawn as connections)."""
    q = lambda t: [[round(v, 4) for v in row] for row in t.detach().cpu().tolist()]
    return {'groups': schema['groups'], 'fields': [f['name'] for f in schema['fields']],
            'intentInputs': ['own', 'mean', 'max', 'obs:ego+tyres+road', 'mem'], 'w1': q(model.intent[0].weight), 'w2': q(model.intent[2].weight),
            'outputs': ['offset 30 m', 'offset 70 m', 'offset 120 m', 'speed cap']}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--bank', required=True); p.add_argument('--model', required=True)
    p.add_argument('--envs', type=int, default=256); p.add_argument('--episodes', type=int, default=256)
    p.add_argument('--sigma', type=float, default=0.); p.add_argument('--seed', type=int, default=0)
    p.add_argument('--record', type=int, default=0); p.add_argument('--out', default=None, help='results/gpu-episodes/<name> for the lab viewer')
    p.add_argument('--families', default=None); p.add_argument('--ids', default=None, help='comma-separated scene ids')
    p.add_argument('--offset-lag', type=float, default=0.); p.add_argument('--dtype', default='float64'); p.add_argument('--full', action='store_true', help='no early stop after a severe contact (matched JS evaluation)')
    p.add_argument('--rivals', default=None, help='distilled rival policy (training/fit_rivals.py); default executor stand-ins')
    p.add_argument('--rival-offset-lag', type=float, default=.4, help='low-pass (s) on distilled rival offsets')
    p.add_argument('--rival-room', type=float, default=0., help='m: distilled rivals give room alongside (0 off)')
    p.add_argument('--rival-room-range', default=None, help='lo,hi m: per-rival room drawn per episode, clamped at 0')
    p.add_argument('--family-weights', default=None, help='family:w,... scene sampling weights (default 1)')
    p.add_argument('--offset-deadband', type=float, default=0.); p.add_argument('--contact', default='v2', choices=['v2', 'v3'])
    p.add_argument('--reward', default='race10-v2', help='cuda_env REWARDS profile')
    p.add_argument('--heldout-of', default=None, help='scene ids held out by a ppo_gpu.py checkpoint (its metadata)')
    p.add_argument('--each', action='store_true', help='every pool scene exactly once (episodes = pool size)')
    p.add_argument('--neurons', action='store_true', help='record every layer per decision of recorded episodes (lab network view)')
    a = p.parse_args()
    torch.manual_seed(a.seed)
    if a.heldout_of:
        a.ids = ','.join(json.loads((Path(a.heldout_of) / 'metadata.json').read_text())['ppoGpu']['heldOut'])
    bank = SceneBank(a.bank)
    model, schema = load_policy(a.model)
    env = GpuEnv(bank, a.envs, dtype=getattr(torch, a.dtype), seed=a.seed, record=a.record, families=a.families.split(',') if a.families else None,
                 ids=a.ids.split(',') if a.ids else None, sequential=a.each, offset_lag=a.offset_lag, early_stop=not a.full,
                 rivals=load_rivals(a.rivals) if a.rivals else None, rival_offset_lag=a.rival_offset_lag, rival_room=a.rival_room, rival_room_range=tuple(map(float, a.rival_room_range.split(','))) if a.rival_room_range else None,
                 family_weights={k: float(v) for k, v in (x.split(':') for x in a.family_weights.split(','))} if a.family_weights else None,
                 offset_deadband=a.offset_deadband, contact=a.contact, reward=a.reward)
    h0 = warm_hidden(model, schema)
    hidden = h0.expand(a.envs, -1).clone()
    results, ticks, t0 = [], 0, time.time()
    if a.each: a.episodes = len(env.pool)
    # Progress in simulated seconds: parallel episodes all finish near the end, so an episode count sits at 0 until then.
    span = [bank.scenes[i]['seconds'] for i in env.pool]
    budget = round(sum(span) if a.each else a.episodes * sum(span) / len(span))
    job, finished = JobProgress('GPU evaluation', Path(a.out).name if a.out else f'run-env-{int(t0)}', budget), 0.
    while len(results) < a.episodes:
        idx, obs = env.decisions()
        if len(idx):
            with torch.no_grad():
                act, nh = model(obs.float(), hidden[idx])
            if a.neurons and env.record:
                rec = idx < env.record
                if rec.any():
                    with torch.no_grad():
                        acts = activations(model, obs[rec].float(), hidden[idx][rec])
                    rows = {k: (v * 100).round().int().cpu().tolist() for k, v in acts.items()}
                    for i, e in enumerate(idx[rec].tolist()):
                        r = env.recordings[e]
                        if r is not None:
                            r.setdefault('neurons', []).append({'t': round(env.t[e].item(), 3), **{k: v[i] for k, v in rows.items()}})
            if a.sigma:
                act = act + torch.randn_like(act) * a.sigma
            env.post(idx, act)
            hidden[idx] = nh
        done = env.physics(); ticks += 1
        if ticks % 600 == 0:
            job.update(min(budget, round(finished + env.t.sum().item())), f'{a.model} · {len(results)}/{a.episodes} episodes · {sum(r["success"] for r in results)}/{len(results)} succeeded so far · {ticks * a.envs / 120 / (time.time() - t0):.0f} sim-s/s')
        if len(done):
            res = env.end(done)
            hidden[done] = h0
            for i in range(len(done)):
                if res['counted'][i]:
                    results.append({k: (v[i].item() if torch.is_tensor(v) else v) for k, v in res.items()})
                    finished += bank.scenes[results[-1]['scene']]['seconds']
    torch.cuda.synchronize()
    wall = time.time() - t0
    job.update(budget, f'{a.model} · {sum(r["success"] for r in results[:a.episodes])}/{a.episodes} succeeded', status='complete')
    fam = {}
    for r in results[:a.episodes]:
        f = bank.scenes[r['scene']]['family']; d = fam.setdefault(f, {'n': 0, 'success': 0, 'admissible': 0, 'severe': 0, 'limit': 0, 'passes': 0., 'damage': 0.})
        d['n'] += 1; d['success'] += r['success']; d['admissible'] += r['admissible']; d['severe'] += r['severe']; d['limit'] += r['limit'] > 0
        d['passes'] += r['passes']; d['damage'] += r['damage']
    for f, d in fam.items():
        d['passes'] = round(d['passes'] / d['n'], 2); d['damage'] = round(d['damage'] / d['n'], 4)
    sim = ticks * a.envs / 120
    print(json.dumps({'episodes': len(results), 'success': round(sum(r['success'] for r in results) / len(results), 3), 'families': fam,
                      'wallSeconds': round(wall, 1), 'simSecondsPerWall': round(sim / wall, 1), 'ticks': ticks}))
    if a.out and env.finished:
        out = Path(a.out)
        if out.exists():
            raise ValueError('Preserve ' + str(out))
        out.mkdir(parents=True)
        geom = bank.meta['trackGeometry']
        for k, rec in enumerate(env.finished):
            rec.update({'model': a.model, 'sigma': a.sigma, 'track': {'length': geom['length'], 'halfWidth': geom['halfWidth'], 'curbWidth': geom['curbWidth'],
                        'nodes': [[n[0], n[1]] for n in geom['nodes']]}})
            (out / f'{k:03d}-{rec["scene"]}.json').write_text(json.dumps(rec))
        if a.neurons:
            (out / 'network.json').write_text(json.dumps(network(model, schema)))
        (out / 'outcomes.json').write_text(json.dumps([{**r, 'id': bank.scenes[r['scene']]['id']} for r in results[:a.episodes]]))
        print('recordings', len(env.finished), '->', out)


if __name__ == '__main__':
    main()
