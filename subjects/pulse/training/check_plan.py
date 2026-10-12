import json
from pathlib import Path
import torch
from plan_model import PlanPolicy

torch.manual_seed(7441); torch.set_num_threads(4)
root = Path('artifacts/models/c75-arrival-and-continuation/epoch-100')
saved = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
checks = 0
for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
    model = PlanPolicy(saved['schema'], saved['modelConfig']).to(device)
    model.encoder.load_state_dict(saved['weights']); model.eval()
    group = saved['schema']['groups']['rivals']
    x = torch.randn(37, saved['schema']['size'], device=device) * .2
    x[:, group['offset']:] = 0
    for t in [0, 1, 2, 5, 6, 7, 12, 13, 14, 25, 26, 27, 28, 29]:
        x[t, group['offset']] = 1
        x[t, group['offset'] + 1:group['offset'] + group['width']] = .1
    # Give the initially neutral head a nonzero output to verify presence masks.
    with torch.no_grad():
        model.intent[2].bias.copy_(torch.tensor([.2, -.3, .1, -.5], device=device))
    h = torch.zeros(1, saved['schema']['hidden'], device=device)
    memories, actions = [], []
    with torch.no_grad():
        for row in x:
            action, h = model(row[None], h); actions.append(action); memories.append(h[:, :64])
        inputs, present = model.sequence_inputs(x)
        torch.testing.assert_close(inputs[:, -64:], torch.cat(memories), atol=2e-6, rtol=2e-6); checks += 1
        torch.testing.assert_close(model.intent(inputs) * present, torch.cat(actions), atol=2e-6, rtol=2e-6); checks += 1
        assert torch.count_nonzero(torch.cat(actions)[present[:, 0] == 0]) == 0; checks += 1
    before = {k: v.clone() for k, v in model.encoder.state_dict().items()}
    model.train(); optimizer = torch.optim.Adam(model.intent.parameters(), lr=.001)
    loss = model.intent(inputs.detach()).square().mean(); loss.backward(); optimizer.step()
    assert all(torch.equal(v, before[k]) for k, v in model.encoder.state_dict().items()); checks += 1
    assert not any(p.grad is not None for p in model.encoder.parameters()); checks += 1
    assert all(p.grad is not None for p in model.intent.parameters()); checks += 1
print(json.dumps({'passed': True, 'checks': checks, 'cuda': torch.cuda.is_available(),
                  'scope': 'Frozen encoder and accepted-sequence intention math; no driving claim'}))
