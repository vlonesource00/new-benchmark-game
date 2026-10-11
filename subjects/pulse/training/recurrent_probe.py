"""Compare uninterrupted recurrence with short-window imitation measurements."""
import argparse
import json
from pathlib import Path
import torch
from model import PulsePolicy

p = argparse.ArgumentParser()
p.add_argument('--model', required=True)
p.add_argument('--episode', required=True)
args = p.parse_args()
torch.set_num_threads(1)
meta = json.loads((Path(args.model) / 'metadata.json').read_text())
weights = torch.load(Path(args.model) / 'model.pt', map_location='cpu', weights_only=True)
model = PulsePolicy(weights['schema'], **weights.get('modelConfig', {})).eval()
model.load_state_dict(weights['weights'])
rows = [r for r in map(json.loads, Path(args.episode).read_text().splitlines()) if r['type'] == 'step']
x = torch.tensor([r['observation']['normalized'] for r in rows])
y = torch.tensor([[r['teacherControls']['steer'], r['teacherControls']['throttle'] - r['teacherControls']['brake']] for r in rows])
predictions, norms = [], []
with torch.inference_mode():
    h = torch.zeros(1, model.hidden_size)
    for observation in x:
        action, h = model(observation[None], h)
        predictions.append(action[0]); norms.append(float(h.norm()))
    uninterrupted = torch.stack(predictions)
    errors = uninterrupted - y
    windowed, valid = torch.zeros_like(y), torch.zeros(len(rows), dtype=torch.bool)
    length, burn = meta['training']['length'], meta['training']['burn']
    for s in range(0, len(rows), length):
        h = torch.zeros(1, model.hidden_size)
        for i in range(s, min(len(rows), s + length)):
            action, h = model(x[i:i+1], h)
            windowed[i] = action[0]
            valid[i] = s == 0 or i - s >= burn
    window_error = windowed[valid] - y[valid]
    report = {'model': Path(args.model).name, 'episode': Path(args.episode).name,
              'modelSha256': meta['modelSha256'], 'steps': len(rows),
              'uninterruptedRmse': errors.square().mean(0).sqrt().tolist(),
              'windowedRmse': window_error.square().mean(0).sqrt().tolist(),
              'initialSteer': {'policy': float(uninterrupted[0, 0]), 'teacher': float(y[0, 0])},
              'hiddenNorm': {'maximum': max(norms), 'final': norms[-1]},
              'segments': []}
    for lo, hi in [(0, 2), (2, 5), (5, 15), (15, 70)]:
        selected = torch.tensor([lo <= r['time'] < hi for r in rows])
        if selected.any():
            report['segments'].append({'seconds': [lo, hi], 'steerRmse': float(errors[selected, 0].square().mean().sqrt()),
                                       'longitudinalRmse': float(errors[selected, 1].square().mean().sqrt())})
print(json.dumps(report))
