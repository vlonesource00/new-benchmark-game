"""Observation contract versions and checkpoint migration.

v1 (every checkpoint before 2026-10-14 evening): the env wrote 49 ego values into a block declared as 48, so each later
value sat one place after its declared block: the road block began with the ego's hybrid charge, and every rival token
began with the previous slot's last value. The token's first value is the attention presence mask, so real rivals were
almost always masked out; the eighth rival's last value fell off the end.
v2: the same values in the same order, with the declared ego block widened to 49 (297 values). The first 296 values are
identical, so a v1 network still runs exactly as trained on v2 rows by reading only its first 296 columns.
v3 (multiclass race context): v2's 297 values unchanged, then egoX ego values and rivalN x rivalX rival values
(env/observe.mjs). A v2 network reads only its first 297 columns; migrate_v2_v3 gives a v2 network the new inputs with
zero weights (ego and rival-token input layers), so it computes exactly what it did, and learns to use them in training.
"""
import torch

V1 = {'ego': 48, 'roadK': 24, 'roadF': 6, 'rivalN': 8, 'rivalF': 13}
V2 = {**V1, 'ego': 49}
V3 = {**V2, 'egoX': 1, 'rivalX': 4}


def obs_len(layout):
    return (layout['ego'] + layout['roadK'] * layout['roadF'] + layout['rivalN'] * layout['rivalF']
            + layout.get('egoX', 0) + layout['rivalN'] * layout.get('rivalX', 0))


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


def _pad_inputs(name, t, ego_x, rival_x):
    """One v2 tensor -> v3: the ego and rival-token input layers gain zero-weight columns for the new values (any
    module prefix: plain, MoE base / cmb). Weights, averages and Adam moments alike (all linear in the input columns)."""
    if t.dim() == 2 and name.endswith('ego.0.weight'):
        return torch.cat([t, torch.zeros_like(t[:, :1]).expand(-1, ego_x)], 1)
    if t.dim() == 2 and name.endswith('tok.0.weight'):
        return torch.cat([t, torch.zeros_like(t[:, :1]).expand(-1, rival_x)], 1)
    return t


def migrate_v2_v3(ck, param_names):
    """Returns a v3 copy of a v2 checkpoint (plain or MoE): same actions on every v3 row as the v2 network on its first
    297 columns. param_names: names of the optimizer's parameters in order (trainable ones, as ppo builds Adam).
    Normaliser statistics for the new columns are mean 0 / var 1 (they reach the network raw, as binary_columns lists them)."""
    import numpy as np
    lay = layout_of(ck)
    assert lay == V2, f'not a v2 checkpoint: {lay}'
    ex, rx = V3['egoX'], V3['rivalX']
    new = ex + V3['rivalN'] * rx
    out = dict(ck)
    out['model'] = {k: _pad_inputs(k, v, ex, rx) for k, v in ck['model'].items()}
    if 'ema' in ck:
        out['ema'] = {k: _pad_inputs(k, v, ex, rx) for k, v in ck['ema'].items()}
    for sd in [out['model']] + ([out['ema']] if 'ema' in out else []):  # MoE normaliser buffers over the input columns
        for k in ('t_mean', 'b_mean'):
            if k in sd:
                sd[k] = torch.cat([sd[k], torch.zeros(new, dtype=sd[k].dtype, device=sd[k].device)])
        for k in ('t_std', 'b_std'):
            if k in sd:
                sd[k] = torch.cat([sd[k], torch.ones(new, dtype=sd[k].dtype, device=sd[k].device)])
        if 'skip' in sd:
            sd['skip'] = torch.cat([sd['skip'], torch.ones(new, dtype=torch.bool, device=sd['skip'].device)])
    if 'opt' in ck:
        opt = {**ck['opt'], 'state': {}}
        for i, st in ck['opt']['state'].items():
            name = param_names[int(i)]
            opt['state'][i] = {k: (_pad_inputs(name, v, ex, rx) if torch.is_tensor(v) else v) for k, v in st.items()}
        out['opt'] = opt
    n = ck['norm']
    out['norm'] = {'mean': np.append(n['mean'], np.zeros(new)), 'var': np.append(n['var'], np.ones(new)), 'n': n['n']}
    out['layout'] = dict(V3)
    out['migrated_from'] = 'v2'
    return out


def migrate_to(ck, layout, names_for):
    """Chains migrations up to the env's layout (v1 -> v2 -> v3). names_for(layout, ck): the optimizer's parameter names."""
    if layout_of(ck) == V1 and layout != V1:
        ck = migrate_v1_v2(ck, names_for(V1, ck))
    if layout_of(ck) == V2 and layout == V3:
        ck = migrate_v2_v3(ck, names_for(V2, ck))
    assert layout_of(ck) == layout, f'no migration from {layout_of(ck)} to {layout}'
    return ck
