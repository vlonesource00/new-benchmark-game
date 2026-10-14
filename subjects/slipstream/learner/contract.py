"""Observation contract versions and checkpoint migration.

v1 (every checkpoint before 2026-10-14 evening): the env wrote 49 ego values into a block declared as 48, so each later
value sat one place after its declared block: the road block began with the ego's hybrid charge, and every rival token
began with the previous slot's last value. The token's first value is the attention presence mask, so real rivals were
almost always masked out; the eighth rival's last value fell off the end.
v2: the same values in the same order, with the declared ego block widened to 49 (297 values). The first 296 values are
identical, so a v1 network still runs exactly as trained on v2 rows by reading only its first 296 columns.
"""
import torch

V1 = {'ego': 48, 'roadK': 24, 'roadF': 6, 'rivalN': 8, 'rivalF': 13}
V2 = {**V1, 'ego': 49}


def obs_len(layout):
    return layout['ego'] + layout['roadK'] * layout['roadF'] + layout['rivalN'] * layout['rivalF']


def layout_of(ck):
    return dict(ck.get('layout') or V1)


def _remap(name, t):
    """One v1 tensor -> v2. Weights of the three input layers gain/shift a column; everything else is unchanged.
    Applied identically to weights, their averages and their Adam moments (all are linear in the input columns)."""
    if name == 'ego.0.weight':  # new column 48 = hybrid charge, previously the road MLP's first input
        return torch.cat([t, torch.zeros_like(t[:, :1])], 1)
    if name == 'road.0.weight':  # road column j now holds the value the v1 road MLP saw at column j + 1
        return torch.cat([t[:, 1:], torch.zeros_like(t[:, :1])], 1)
    if name == 'tok.0.weight':  # token feature f now holds the value v1 saw at f + 1; f = 12 (is a learner) is new
        return torch.cat([t[:, 1:], torch.zeros_like(t[:, :1])], 1)
    return t


def migrate_v1_v2(ck, param_names):
    """Returns a v2 copy of a v1 checkpoint. In a world with no other car in range the v2 network computes exactly what
    the v1 network did (dropped inputs were the hybrid charge, 0 for GT cars, and the last road sample's water depth,
    which v1 never read); with rivals in range it now sees them, which v1 never learned to use.
    param_names: the model's parameter names in optimizer order (list(net.named_parameters()))."""
    assert layout_of(ck) == V1, f'not a v1 checkpoint: {layout_of(ck)}'
    out = dict(ck)
    out['model'] = {k: _remap(k, v) for k, v in ck['model'].items()}
    if 'ema' in ck:
        out['ema'] = {k: _remap(k, v) for k, v in ck['ema'].items()}
    if 'opt' in ck:
        opt = {**ck['opt'], 'state': {}}
        for i, s in ck['opt']['state'].items():
            name = param_names[int(i)]
            opt['state'][i] = {k: (_remap(name, v) if torch.is_tensor(v) and v.dim() == 2 else v) for k, v in s.items()}
        out['opt'] = opt
    n = ck['norm']
    import numpy as np
    out['norm'] = {'mean': np.append(n['mean'], 0.0), 'var': np.append(n['var'], 1.0), 'n': n['n']}
    out['layout'] = dict(V2)
    out['migrated_from'] = 'v1'
    return out
