"""A calibrated traffic actor must preserve its parent and recurrent contract."""
import json
from pathlib import Path
import torch
from model import PulsePolicy
from train import rollout_loss

torch.manual_seed(31); torch.set_num_threads(1)
schema = json.loads(Path('artifacts/schema-v2.json').read_text())
config = dict(instant=True, motorHistoryMask=True, splitMotor=True, trafficResidual=True, trafficMemory=True)
parent = PulsePolicy(schema, **config).eval()
with torch.no_grad():
    parent.traffic[2].weight.normal_(0, .07)
    parent.traffic[2].bias.fill_(.03)
model = PulsePolicy(schema, **config, trafficGate=True).eval()
model.load_parent(parent.state_dict())
g = schema['groups']['rivals']; x = torch.rand(3, schema['size']) * 2 - 1
cars = x[:, g['offset']:].reshape(3, g['count'], g['width']); cars[:, :, 0] = 0; cars[:, :2, 0] = 1
h = torch.rand(3, schema['hidden'])
checks = []
for a, b in zip(parent(x, h), model(x, h)):
    assert torch.equal(a, b), 'Calibration transfer changed initial controls or memory'
checks.append('initial action and memory are bitwise equal to parent')
assert all(p.requires_grad == name.startswith('traffic_gain.') for name, p in model.named_parameters())
checks.append('only the small gain head can train')
frozen = {name: p.detach().clone() for name, p in model.named_parameters() if not p.requires_grad}
optimizer = torch.optim.Adam(model.traffic_gain.parameters(), lr=.01)
for _ in range(3):
    loss = (model(x, h)[0] - parent(x, h)[0].detach() * .5).square().mean()
    optimizer.zero_grad(); loss.backward()
    assert all(torch.isfinite(p.grad).all() for p in model.traffic_gain.parameters())
    assert any(p.grad.abs().sum() > 0 for p in model.traffic_gain.parameters())
    optimizer.step()
assert all(torch.equal(dict(model.named_parameters())[name], value) for name, value in frozen.items())
checks.append('finite calibration gradients leave every parent parameter unchanged')
assert torch.equal(parent(x, h)[1], model(x, h)[1])
checks.append('learned gain cannot alter recurrent state on the same observations')
empty = x.clone(); empty[:, g['offset']:] = 0
for a, b in zip(parent(empty, h), model(empty, h)):
    assert torch.equal(a, b)
checks.append('empty-rival controls and memory remain exact after learning')
permuted = x.clone(); pc = permuted[:, g['offset']:].reshape_as(cars)
pc[:] = cars[:, torch.tensor([1, 0, 2, 3, 4, 5, 6, 7])]
pc[:, 2:, 1:] = 100
assert torch.allclose(model(x, h)[0], model(permuted, h)[0], atol=1e-6)
checks.append('opponent permutation and padding retain their invariance')
sequence = x[:1].unsqueeze(1).repeat(1, 64, 1)
sequence[:, 20:23, g['offset']:] = 0
hidden = torch.zeros(1, schema['hidden']); actions = []
for t in range(sequence.shape[1]):
    action, hidden = model(sequence[:, t], hidden); actions.append(action)
batched = model.traffic_sequence(sequence, 0, torch.ones(1))
assert torch.allclose(torch.stack(actions, 1), batched, atol=1e-6)
checks.append('batched training matches streaming control including empty resets')
model.zero_grad(); rollout_loss(model, sequence, torch.zeros_like(batched), 0, torch.ones(1), 10).backward()
assert all(p.grad is None for name, p in model.named_parameters() if name in frozen)
assert all(torch.isfinite(p.grad).all() for p in model.traffic_gain.parameters())
checks.append('sequence fitting has finite gain gradients and no parent gradients')
for invalid in [dict(instant=True, splitMotor=True, trafficResidual=True, trafficGate=True), {**config, 'trafficGate': True, 'motorTune': True}]:
    try:
        PulsePolicy(schema, **invalid)
        raise AssertionError('invalid gain ownership accepted')
    except ValueError:
        pass
checks.append('incompatible motor or memory ownership is rejected')
clipped = PulsePolicy(schema, **config, trafficGate=True, trafficGateMode='clipped').eval()
clipped.load_parent(parent.state_dict())
assert all(torch.equal(a, b) for a, b in zip(parent(x, h), clipped(x, h)))
checks.append('post-clip calibrator initially preserves its parent bitwise')
with torch.no_grad():
    clipped.traffic[2].weight.zero_()
    clipped.traffic[2].bias.copy_(torch.tensor([4., -4.]))
    clipped.traffic_gain[2].bias.fill_(torch.atanh(torch.tensor(-.75)))
base = torch.tensor([[.9, -.9]])
inputs = torch.zeros(1, clipped.traffic[0].in_features)
expected = base + .25 * (torch.tensor([[1., -1.]]) - base)
assert torch.allclose(clipped.traffic_action(base, inputs, torch.ones(1, 1)), expected, atol=1e-7)
assert torch.equal(clipped.traffic_action(base, inputs, torch.zeros(1, 1)), base)
checks.append('saturated parent deltas match offline gain search and empty masking')
hidden = torch.zeros(1, schema['hidden']); actions = []
for t in range(sequence.shape[1]):
    action, hidden = clipped(sequence[:, t], hidden); actions.append(action)
assert torch.allclose(torch.stack(actions, 1), clipped.traffic_sequence(sequence, 0, torch.ones(1)), atol=1e-6)
checks.append('post-clip batched and streaming actions use the same contract')
legacy = PulsePolicy(schema, **config, trafficGate=True).eval()
explicit_raw = PulsePolicy(schema, **config, trafficGate=True, trafficGateMode='raw').eval()
legacy.load_parent(model.state_dict()); explicit_raw.load_parent(model.state_dict())
assert all(torch.equal(a, b) for a, b in zip(legacy(x, h), explicit_raw(x, h)))
checks.append('metadata without a mode preserves legacy raw gain math')
print(json.dumps({'passed': len(checks), 'parameters': sum(p.numel() for p in model.parameters()),
                  'trainable': sum(p.numel() for p in model.parameters() if p.requires_grad), 'checks': checks}))
