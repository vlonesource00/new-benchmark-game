"""Merge GPU scene banks (gpu-sim/scene-bank.mjs) built on the same track, classes and field layout into one bank,
e.g. the field suite's train split plus the same-pace duel suite's.
  python gpu-sim/merge-banks.py --out C:/pulse-store/scenes/<name> <bank> <bank> ...
"""
import argparse, json, os
import numpy as np

p = argparse.ArgumentParser()
p.add_argument('--out', required=True); p.add_argument('banks', nargs='+')
a = p.parse_args()
if os.path.exists(a.out): raise SystemExit('Preserve scene bank ' + a.out)
metas = [json.load(open(os.path.join(b, 'meta.json'))) for b in a.banks]
base = metas[0]
for b, m in zip(a.banks[1:], metas[1:]):
    for k in ('format', 'slots', 'fields', 'planExecution', 'planContract', 'observation', 'trackGeometry'):
        if m[k] != base[k]: raise SystemExit(f'{b}: {k} differs from {a.banks[0]}')
    for c, v in m['classes'].items():
        if c in base['classes'] and {k: x for k, x in v.items() if k != 'deployMap'} != {k: x for k, x in base['classes'][c].items() if k != 'deployMap'}:
            raise SystemExit(f'{b}: class {c} differs')
ids = [s['id'] for m in metas for s in m['scenes']]
if len(set(ids)) != len(ids): raise SystemExit('Duplicate scene ids across banks')
classes = dict(base['classes'])
for m in metas[1:]:
    for c, v in m['classes'].items(): classes.setdefault(c, v)
meta = {**base, 'classes': classes, 'suite': [m['suite'] for m in metas], 'suiteDigest': [m['suiteDigest'] for m in metas],
        'split': [m['split'] for m in metas], 'merged': a.banks, 'scenes': [s for m in metas for s in m['scenes']]}
os.makedirs(a.out)
for f, dt in (('states.f64', np.float64), ('rubber.f32', np.float32)):
    np.concatenate([np.fromfile(os.path.join(b, f), dtype=dt) for b in a.banks]).tofile(os.path.join(a.out, f))
json.dump(meta, open(os.path.join(a.out, 'meta.json'), 'w'))
print(json.dumps({'scenes': len(meta['scenes']), 'families': {f: sum(s['family'] == f for s in meta['scenes']) for f in sorted({s['family'] for s in meta['scenes']})}}))
