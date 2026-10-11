"""Meaningful data-contract and model invariance checks, independent of CUDA."""
import json
import tempfile
from pathlib import Path
import numpy as np
import torch
from model import PulsePolicy
from data import episodes, windows, assert_disjoint

schema = json.loads(Path('artifacts/schema.json').read_text())
torch.manual_seed(7)
torch.set_num_threads(1)
model = PulsePolicy(schema).eval()
reactive = PulsePolicy(schema, reactive=True).eval()
reactive.load_parent(model.state_dict())
x = torch.rand(3, schema['size']) * 2 - 1
h = torch.rand(3, schema['hidden'])
g = schema['groups']['rivals']
cars = x[:, g['offset']:].reshape(3, g['count'], g['width'])
cars[:, :, 0] = torch.tensor([1, 1, 1, 0, 0, 0, 0, 0])
with torch.inference_mode():
    reference = model(x, h)
    for a, b in zip(reference, reactive(x, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Transfer must start from the identical policy'
    swapped = x.clone()
    swapped[:, g['offset']:] = cars[:, [3, 2, 7, 0, 4, 1, 6, 5]].reshape(3, -1)
    for a, b in zip(reference, model(swapped, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Opponent permutation changed the policy'
    padded = x.clone()
    pad_cars = padded[:, g['offset']:].reshape(3, g['count'], g['width'])
    pad_cars[:, 3:, 1:] = torch.rand_like(pad_cars[:, 3:, 1:]) * 100
    for a, b in zip(reference, model(padded, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Masked padding leaked into the policy'

with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / 'corrective.jsonl'
    manifest = {'type': 'manifest', 'split': 'train', 'episodeId': 'case-a', 'settings': {'mode': 'policy'}}
    steps = [{'type': 'step', 'reset': i == 0, 'observation': {'normalized': [0] * schema['size'], 'missing': [],
              'raw': [0, 20], 'road': {'lateral': 0}, 'preview': [{'halfWidth': 8}]},
              'before': {'damage': .03 if i == 70 else 0}, 'target': [-.9, -.8],
              'teacherControls': {'steer': .4, 'throttle': .7, 'brake': .1}} for i in range(150)]
    def save():
        path.write_text('\n'.join(json.dumps(r) for r in [manifest, *steps, {'type': 'summary', 'minFuel': 40}]))
    save()
    try:
        episodes(tmp, schema, 'train')
        raise AssertionError('Student targets were accepted as initial imitation labels')
    except ValueError:
        pass
    data = episodes(tmp, schema, 'train', corrective=True)
    assert [e['start_index'] for e in data] == [0, 71], 'Invalid rows must split, not stitch, recurrent sequences'
    assert [len(e['x']) for e in data] == [70, 79]
    assert data[0]['fresh'] and not data[1]['fresh']
    assert np.allclose(data[0]['y'][0], [.4, .6]), 'Corrective labels must be the expert request, not student execution'
    assert len(windows(data, 64, 32)) == 2
    try:
        assert_disjoint(data, data)
        raise AssertionError('Whole-episode leakage went undetected')
    except ValueError:
        pass
    steps[5]['teacherControls'] = None
    save()
    try:
        episodes(tmp, schema, 'train', corrective=True)
        raise AssertionError('Missing expert labels were silently accepted')
    except ValueError:
        pass
print(json.dumps({'passed': 8, 'checks': ['identical reactive transfer', 'opponent permutation', 'masked padding', 'no student self-labels',
    'contiguous correction windows', 'expert corrective targets', 'whole-episode leakage', 'missing expert rejection']}))
