"""Meaningful data-contract and model invariance checks, independent of CUDA."""
import json
import tempfile
from pathlib import Path
import numpy as np
import torch
from model import PulsePolicy, transfer_observations
from data import episodes, windows, assert_disjoint
from train import rollout_loss
from interpolate import pedal_weights

schema = json.loads(Path('artifacts/schema.json').read_text())
schema_v2 = json.loads(Path('artifacts/schema-v2.json').read_text()) if Path('artifacts/schema-v2.json').exists() else None
torch.manual_seed(7)
torch.set_num_threads(1)
model = PulsePolicy(schema).eval()
reactive = PulsePolicy(schema, reactive=True).eval()
reactive.load_parent(model.state_dict())
context_skip = PulsePolicy(schema, contextSkip=True).eval()
context_skip.load_parent(model.state_dict())
x = torch.rand(3, schema['size']) * 2 - 1
h = torch.rand(3, schema['hidden'])
g = schema['groups']['rivals']
cars = x[:, g['offset']:].reshape(3, g['count'], g['width'])
cars[:, :, 0] = torch.tensor([1, 1, 1, 0, 0, 0, 0, 0])
with torch.inference_mode():
    reference = model(x, h)
    for a, b in zip(reference, reactive(x, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Transfer must start from the identical policy'
    for a, b in zip(reference, context_skip(x, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Current-state skip must start from the identical policy'
    swapped = x.clone()
    swapped[:, g['offset']:] = cars[:, [3, 2, 7, 0, 4, 1, 6, 5]].reshape(3, -1)
    for a, b in zip(reference, model(swapped, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Opponent permutation changed the policy'
    padded = x.clone()
    pad_cars = padded[:, g['offset']:].reshape(3, g['count'], g['width'])
    pad_cars[:, 3:, 1:] = torch.rand_like(pad_cars[:, 3:, 1:]) * 100
    for a, b in zip(reference, model(padded, h)):
        assert torch.allclose(a, b, atol=1e-6), 'Masked padding leaked into the policy'
    instant = PulsePolicy(schema, instant=True).eval()
    a, passed_h = instant(x, h)
    b, _ = instant(x, h * 10 + 2)
    assert torch.equal(a, b) and torch.equal(passed_h, h), 'Instant control must be independent of memory'
    for transformed in [swapped, padded]:
        assert torch.allclose(a, instant(transformed, h)[0], atol=1e-6), 'Instant opponent masks/order changed output'
    history_masked = PulsePolicy(schema, instant=True, motorHistoryMask=True).eval()
    history_masked.load_parent(instant.state_dict())
    changed_history = x.clone()
    for i, f in enumerate(schema['fields']):
        if f['name'] in ['ego.previousSteer', 'ego.previousLongitudinal', 'ego.heldSteer', 'ego.heldLongitudinal', 'ego.steering']:
            changed_history[:, i] = 10
    assert torch.equal(history_masked(x, h)[0], history_masked(changed_history, h)[0]), 'Masked actuator history changed the command'
    split_motor = PulsePolicy(schema, instant=True, motorHistoryMask=True, splitMotor=True).eval()
    split_motor.load_parent(history_masked.state_dict())
    assert torch.allclose(split_motor(x, h)[0], history_masked(x, h)[0], atol=1e-6), 'Split motor transfer changed the initial function'
    steer_before = split_motor(x, h)[0][:, 0].clone()
    for parameter in split_motor.pedals.parameters():
        parameter.add_(.2)
    assert torch.equal(split_motor(x, h)[0][:, 0], steer_before), 'Pedal learning changed frozen steering'
    assert all(not p.requires_grad for name, p in split_motor.named_parameters() if not name.startswith('pedals.'))
    blend_a = {'head.weight': torch.ones(2, 3), 'pedals.weight': torch.zeros(1, 3)}
    blend_b = {'head.weight': torch.ones(2, 3), 'pedals.weight': torch.ones(1, 3)}
    blended = pedal_weights(blend_a, blend_b, .5)
    assert torch.equal(blended['head.weight'], blend_a['head.weight']) and torch.equal(blended['pedals.weight'], torch.full((1, 3), .5))
    blend_b['head.weight'] *= 2
    try:
        pedal_weights(blend_a, blend_b, .5)
        raise AssertionError('Interpolation changed the supposedly frozen steering function')
    except ValueError:
        pass
    xx = torch.rand(3, 10, schema['size']); yy = torch.rand(3, 10, 2) * 2 - 1
    fresh = torch.tensor([1., 0., 1.]); burn = 2
    actual = rollout_loss(instant, xx, yy, burn, fresh, 10)
    errors = []
    for t in range(10):
        action, _ = instant(xx[:, t], torch.zeros(3, schema['hidden']))
        weight = 1 + 2 * (yy[:, t, 1:] < -.05).float()
        err = ((action - yy[:, t]).square() * torch.cat([weight * 0 + 10, weight], 1)).mean(1)
        errors.append((err * fresh).sum() / fresh.sum() if t < burn else err.mean())
    assert torch.allclose(actual, torch.stack(errors).mean(), atol=1e-6), 'Vectorized loss changed the burn/fresh objective'
    if schema_v2:
        v2 = PulsePolicy(schema_v2, instant=True).eval()
        v2.load_parent(transfer_observations(instant.state_dict(), schema, schema_v2))
        new_x = torch.rand(3, schema_v2['size'])
        indices = {f['name']: i for i, f in enumerate(schema_v2['fields'])}
        for i, f in enumerate(schema['fields']):
            new_x[:, indices[f['name']]] = x[:, i]
        for a, b in zip(instant(x, h), v2(new_x, h)):
            assert torch.allclose(a, b, atol=1e-6), 'Added observations changed the transferred function at initialization'

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
    steps[5]['teacherControls'] = {'steer': .4, 'throttle': .7, 'brake': .1}
    manifest['neverTraining'] = True
    save()
    try:
        episodes(tmp, schema, 'train', corrective=True)
        raise AssertionError('Diagnostic intervention was accepted as training data')
    except ValueError:
        pass
    manifest.pop('neverTraining')
    manifest['settings']['mode'] = 'teacher'
    records = [manifest, *steps, {'type': 'summary', 'minFuel': 40, 'trackLimitSeconds': .1}]
    path.write_text('\n'.join(json.dumps(r) for r in records))
    try:
        episodes(tmp, schema, 'train')
        raise AssertionError('An off-track expert demonstration was accepted')
    except ValueError:
        pass
    manifest['settings']['mode'] = 'policy'
    for r in steps:
        r['before']['damage'] = 0
        r['observation']['road']['lateral'] = 9.7
        r['legalTrackLimit'] = 10.23
    save()
    edge = episodes(tmp, schema, 'train', corrective=True)
    assert len(edge) == 1 and len(edge[0]['x']) == 150, 'Legal kerb states were removed from corrective data'
    steps[0]['legalTrackLimit'] = float('nan')
    save()
    try:
        episodes(tmp, schema, 'train', corrective=True)
        raise AssertionError('Non-finite legality boundary was accepted')
    except ValueError:
        pass
    steps[0]['legalTrackLimit'] = 10.23
    manifest['settings'] = {'mode': 'teacher', 'disturbanceSteer': .1}
    manifest['trainingOnly'] = True
    manifest['trainingDisturbance'] = True
    save()
    disturbed = episodes(tmp, schema, 'train', corrective=True)
    assert np.allclose(disturbed[0]['y'][0], [.4, .6]), 'Disturbed execution replaced the expert correction label'
    try:
        episodes(tmp, schema, 'train')
        raise AssertionError('Noisy execution was accepted as a cloning target')
    except ValueError:
        pass
    steps[70]['before']['damage'] = .003
    save()
    prefix = episodes(tmp, schema, 'train', corrective=True)
    assert len(prefix) == 1 and len(prefix[0]['x']) == 70, 'A failed disturbed expert contributed repaired/post-crash rows'
    manifest['settings'] = {'mode': 'policy'}
    manifest.pop('trainingDisturbance')
    manifest['cleanPrefixTraining'] = True
    save()
    feedback = episodes(tmp, schema, 'train', corrective=True)
    assert len(feedback) == 1 and len(feedback[0]['x']) == 70, 'Policy feedback learned from repaired/post-crash states'
    manifest['settings']['trainingExpertActuator'] = 'longitudinal'
    save()
    try:
        episodes(tmp, schema, 'train', corrective=True)
        raise AssertionError('Assisted pedals were accepted as unassisted feedback')
    except ValueError:
        pass
print(json.dumps({'passed': 26 + int(schema_v2 is not None), 'v2TransferChecked': schema_v2 is not None, 'checks': ['identical reactive transfer', 'identical current-state skip transfer', 'opponent permutation', 'masked padding',
    'instant memory independence', 'instant opponent invariance', 'motor history invariance', 'vectorized supervised loss parity', 'no student self-labels',
    'contiguous correction windows', 'expert corrective targets', 'whole-episode leakage', 'missing expert rejection',
    'diagnostic data rejection', 'unclean expert rejection', 'legal corrective kerb states', 'finite legality boundary',
    'disturbed expert corrective labels', 'no noisy execution cloning', 'split motor initial parity', 'pedal updates preserve frozen steering', 'failed disturbed expert clean prefix only',
    'pedal interpolation preserves steering', 'different steering interpolation rejected', 'failed policy clean prefix only', 'assisted feedback rejected']}))
