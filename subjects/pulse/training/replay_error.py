"""Compare fitting error, achievable gains and physical evidence; never control a car."""
import argparse
import json
from pathlib import Path
import numpy as np
import torch
from model import PulsePolicy
from outcome_data import outcome_episodes

p = argparse.ArgumentParser()
p.add_argument('--model', required=True); p.add_argument('--parent', required=True)
p.add_argument('--data', required=True); p.add_argument('--out', required=True)
args = p.parse_args(); out = Path(args.out)
if out.exists():
    raise ValueError('Preserve prior fitting diagnostics')
torch.set_num_threads(4)
device = 'cuda' if torch.cuda.is_available() else 'cpu'
def load(root):
    c = torch.load(Path(root) / 'model.pt', map_location='cpu', weights_only=True)
    m = PulsePolicy(c['schema'], **c['modelConfig']).to(device).eval(); m.load_state_dict(c['weights'])
    return m, c['schema']
model, schema = load(args.model); parent, ps = load(args.parent)
if schema != ps:
    raise ValueError('Parent schema mismatch')
report = {'model': args.model, 'parent': args.parent, 'device': device, 'episodes': [],
          'scope': 'Teacher-forced recorded-state error and gain reachability, not driving or held-out performance.'}
for split in ['train', 'validation']:
    for e in outcome_episodes(Path(args.data) / split, schema, split):
        x = torch.tensor(e['x'][None], device=device); target = e['y']
        captures = []
        hook = model.traffic_gain.register_forward_hook(lambda _m, _i, y: captures.append(y.detach().cpu().numpy())) if model.traffic_gate else None
        with torch.inference_mode():
            action = model.traffic_sequence(x, 0, torch.ones(1, device=device))[0].cpu().numpy()
            pa = parent.traffic_sequence(x, 0, torch.ones(1, device=device))[0].cpu().numpy()
            own_input, own, mean, maximum, _ = parent.features(x[0])
            motor = torch.cat([own, torch.zeros_like(mean), torch.zeros_like(maximum)], 1)
            base = torch.cat([parent.head(motor)[:, :1], parent.pedals(torch.cat([motor, own_input], 1))], 1).cpu().numpy()
        if hook:
            hook.remove()
        predicted = 1 + captures[0] if captures else None
        # The episode loaders preserve proposal ordering and recorded time.
        source = Path(args.data) / split / Path(e['path']).name
        rows = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
        times = np.array([r['time'] for r in rows if r.get('type') == 'step'])
        bins = []
        for start in range(0, int(times[-1]) + 1, 10):
            mask = (times >= start) & (times < start + 10)
            error = action[mask] - target[mask]; delta = pa[mask] - base[mask]
            useful = np.abs(delta) > .02
            wanted = np.divide(target[mask] - base[mask], delta, out=np.zeros_like(delta), where=useful)
            q = lambda v: [float(z) for z in np.quantile(v, [.1, .5, .9])] if v.size else None
            bins.append({'start': start, 'steerMAE': float(np.abs(error[:, 0]).mean()),
                         'effortMAE': float(np.abs(error[:, 1]).mean()),
                         'wantedGainP10MedianP90': q(wanted[useful]),
                         'predictedGainP10MedianP90': q(predicted[mask][useful]) if predicted is not None else None,
                         'unreachableGainFraction': float(((wanted < 0) | (wanted > 2))[useful].mean()) if useful.any() else 0})
        report['episodes'].append({'name': e['manifest']['name'], 'split': split, 'bins': bins})
out.parent.mkdir(parents=True, exist_ok=True); out.write_text(json.dumps(report, indent=2))
print(json.dumps({'file': str(out), 'episodes': len(report['episodes']), 'device': device}))
