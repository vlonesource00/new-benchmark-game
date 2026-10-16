"""Export a checkpoint's actor for the browser (browser/policy.mjs) plus a parity fixture.

  python learner/export.py --ckpt runs/tt-b2/model.pt --name b2   ->  runs/export/<name>.json, runs/export/<name>.fixture.json

The fixture holds a recurrent sequence of real-looking inputs (raw observations, first/decide flags) and the torch
actor's mean actions; browser/parity.mjs replays it through the JS port and reports the largest difference.
"""
import argparse
import base64
import json
import os

import numpy as np
import torch

from model import Slipstream, SlipstreamMoE
from contract import obs_len
from ppo import SUBJECT, RunningNorm, binary_columns

ACTOR = ('ego.', 'road.', 'tok.', 'query.', 'null', 'attn.', 'pre.', 'gru.', 'pi.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--steps', type=int, default=200)
    ap.add_argument('--blind-rivals', action='store_true',
                    help='the deployed actor sees every rival slot empty (as in solo tests) until it has trained in traffic')
    a = ap.parse_args()
    ck = torch.load(os.path.join(SUBJECT, a.ckpt), map_location='cpu', weights_only=False)
    layout = ck['layout']
    moe = 'moe' in ck
    net = (SlipstreamMoE(layout) if moe else Slipstream(layout)).eval()
    net.load_state_dict(ck['model'])
    skip = binary_columns(layout)
    D = obs_len(layout)
    norm = RunningNorm(D, skip)
    norm.load(ck['norm'])
    enc = lambda v: {'shape': list(v.shape), 'data': base64.b64encode(v.detach().float().numpy().astype('<f4').tobytes()).decode()}
    actor = lambda m: {k: enc(v) for k, v in m.state_dict().items() if k.startswith(ACTOR)}
    std = np.sqrt(norm.var + 1e-8).astype(np.float32).tolist()
    out = {'ckpt': a.ckpt, 'iter': ck.get('iter'), 'layout': layout, 'skip': skip.tolist(), 'mean': norm.mean.astype(np.float32).tolist(), 'std': std}
    if moe:  # two expert actors (each with its own normaliser, as browser/policy.mjs runs them) and the router
        sub = lambda m, mean, sd: {'layout': layout, 'hidden': net.eh, 'skip': skip.tolist(), 'mean': mean.tolist(), 'std': sd.tolist(), 'params': actor(m)}
        # v4 wiring: the combat expert's pre and policy layers also read the corridor block (and the pace expert's mean)
        out.update(moe=True, residual=bool(net.residual), hidden=net.hidden, base=sub(net.base, net.b_mean, net.b_std), cmb={**sub(net.cmb, net.t_mean, net.t_std), 'wired': bool(net.cx)},
                   gate={k: enc(v) for k, v in net.gate.state_dict().items()})
    else:
        out.update(hidden=net.hidden, params=actor(net))
    if a.blind_rivals:
        out['blindRivals'] = True
    d = os.path.join(SUBJECT, 'runs', 'export')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f'{a.name}.json'), 'w') as f:
        json.dump(out, f)
    # Parity fixture: inputs drawn around the running statistics, presence flags 0/1, occasional resets and busy rows.
    rng = np.random.default_rng(0)
    D = len(out['mean'])
    raw = (norm.mean + np.sqrt(norm.var) * rng.normal(size=(a.steps, D))).astype(np.float32)
    raw[:, skip] = (rng.random((a.steps, len(skip))) < 0.4).astype(np.float32)
    if a.blind_rivals:
        raw[:, net.ego_f + net.k * net.rf_f:] = 0
    first = (rng.random(a.steps) < 0.02).astype(np.float32); first[0] = 1
    dec = (rng.random(a.steps) < 0.7).astype(np.float32); dec[first > 0] = 1
    h = torch.zeros(1, net.hidden)
    mus = []
    with torch.no_grad():
        for t in range(a.steps):
            x = torch.from_numpy(norm(raw[t:t + 1]))
            mu, _, h = net.step(x, h, torch.tensor([first[t]]), torch.tensor([dec[t]]))
            mus.append(mu[0].tolist())
    with open(os.path.join(d, f'{a.name}.fixture.json'), 'w') as f:
        json.dump({'raw': raw.tolist(), 'first': first.tolist(), 'decide': dec.tolist(), 'mu': mus}, f)
    n = sum(np.prod(p['shape']) for e in ([out['base'], out['cmb']] if moe else [out]) for p in e['params'].values())
    print(json.dumps({'export': f'runs/export/{a.name}.json', 'mb': round(os.path.getsize(os.path.join(d, f'{a.name}.json')) / 1e6, 2), 'params': int(n)}))


if __name__ == '__main__':
    main()
