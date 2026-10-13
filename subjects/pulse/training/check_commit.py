"""c207 gate G1 on the CPU: a commit policy made from a parent (PlanPolicy.add_commit) is the parent.
Drives both through the observation stream of a recorded JS episode (the ego's normalized observations (the model input), in order) with each
model's own hidden chain, then checks the exported ONNX (batch 1 and 16) against PyTorch over the same round trip.
  python training/check_commit.py artifacts/models/c196-ppo-it040 artifacts/driving-suites/c196-devtraffic-tr-0/development-001-traffic.jsonl
"""
import copy, json, sys, tempfile
from pathlib import Path
import numpy as np
import torch
import onnxruntime as ort
sys.path.insert(0, str(Path(__file__).parent))
from plan_model import PlanPolicy

torch.set_grad_enabled(False)
root, trace = Path(sys.argv[1]), Path(sys.argv[2])
steps = int(sys.argv[3]) if len(sys.argv) > 3 else 600
ck = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
schema = ck['schema']
parent = PlanPolicy(schema, ck['encoderConfig']); parent.load_state_dict(ck['weights'], strict=True); parent.eval()
child = copy.deepcopy(parent); child.add_commit(); child.eval()
obs = []
with open(trace, encoding='utf-8') as f:
    for line in f:
        r = json.loads(line)
        if r.get('type') == 'step' and r.get('observation'):
            obs.append(r['observation']['normalized'])
        if len(obs) >= steps:
            break
obs = torch.tensor(obs, dtype=torch.float32)
assert obs.shape[1] == schema['size'], obs.shape
checks = []


def check(name, ok, detail=''):
    checks.append(name)
    if not ok:
        raise AssertionError(f'{name} {detail}')


def warm(model):
    h = torch.zeros(1, schema['hidden'])
    for _ in range(30):
        _, h = model(torch.zeros(1, schema['size']), h)
    return h


hp, hc = warm(parent), warm(child)
check('warm hidden identical', torch.equal(hp[:, :64], hc[:, :64]))
acts_p, acts_c, hid_c, present_steps = [], [], [], 0
for o in obs:
    ap, hp2 = parent(o[None], hp)
    ac, hc2 = child(o[None], hc)
    check('actions bitwise equal', torch.equal(ap, ac), f'max {float((ap - ac).abs().max())}')
    check('traffic memory bitwise equal', torch.equal(hp2[:, :64], hc2[:, :64]))
    check('previous intent carried', torch.equal(hc2[:, 64:68], ac))
    check('rest of hidden zero', not hc2[:, 68:].any())
    present_steps += int(ac.abs().sum() > 0)
    acts_p.append(ap); acts_c.append(ac); hid_c.append(hc)
    hp, hc = hp2, hc2
check('the stream has traffic decisions', present_steps > 50, present_steps)

# A non-zero adapter output must change the action, and the previous intent must reach it (wired, not ignored).
probe = copy.deepcopy(child)
with torch.no_grad():
    probe.adapter[2].weight.fill_(.5)
i = int(np.argmax([float(h[:, 64:68].abs().sum()) for h in hid_c]))  # a step whose stored previous intent is non-zero
check('commit input is wired', not torch.equal(probe(obs[i][None], hid_c[i])[0], acts_c[i]))
moved = hid_c[i].clone(); moved[:, 64:68] = -moved[:, 64:68]
check('previous intent reaches the adapter', not torch.equal(probe(obs[i][None], moved)[0], probe(obs[i][None], hid_c[i])[0]))
# Trainable: the adapter's hidden layer is unsaturated and its output layer gets a gradient from a policy loss.
F = torch.cat([child.head_input(o[None], h)[0] for o, h in zip(obs, hid_c)])
u = child.adapter[1](child.adapter[0](F))
check('adapter unsaturated', float((1 - u.square()).mean()) > .5, float((1 - u.square()).mean()))
with torch.enable_grad():
    loss = (child.head(F) - .3).square().mean(); loss.backward()
check('adapter output layer gets gradient', float(child.adapter[2].weight.grad.abs().sum()) > 0)
child.zero_grad(set_to_none=True)

with tempfile.TemporaryDirectory() as tmp:
    for b in (1, 16):
        path = Path(tmp) / f'policy-{b}.onnx'
        torch.onnx.export(child, (torch.zeros(b, schema['size']), torch.zeros(b, schema['hidden'])), path, dynamo=False,
                          opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        sess = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
        h = np.repeat(warm(child).numpy(), b, 0); worst = 0.
        ht = torch.tensor(h)
        for o in obs:
            x = np.repeat(o[None].numpy(), b, 0)
            a, h = sess.run(None, {'observation': x, 'hidden': h})
            at, ht = child(torch.tensor(x), ht)
            worst = max(worst, float(np.abs(a - at.numpy()).max()), float(np.abs(h - ht.numpy()).max()))
            h = ht.numpy()  # same hidden on both sides: per-step error, not compounded float drift
        check(f'onnx batch {b} matches torch', worst < 1e-5, worst)
print(f'check_commit: {len(set(checks))} checks passed over {len(obs)} decisions ({present_steps} with traffic)')
