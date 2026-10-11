"""Measure command imitation separately from unassisted closed-loop driving."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from model import PulsePolicy


def metrics(rows, predicted, target):
    error = predicted - target
    absolute = np.abs(error)
    worst = np.argsort(absolute[:, 0])[-5:][::-1]
    return {
        'rows': len(rows),
        'steer': {'mae': float(absolute[:, 0].mean()), 'rmse': float(np.sqrt((error[:, 0] ** 2).mean())),
                  'p95': float(np.quantile(absolute[:, 0], .95)), 'max': float(absolute[:, 0].max())},
        'longitudinal': {'mae': float(absolute[:, 1].mean()), 'rmse': float(np.sqrt((error[:, 1] ** 2).mean()))},
        'worstSteer': [{'time': rows[i]['time'], 's': rows[i]['before']['s'], 'lateral': rows[i]['before']['lateral'],
                        'speed': rows[i]['before']['speed'], 'predicted': predicted[i].tolist(), 'expert': target[i].tolist()}
                       for i in worst],
    }


def infer(model, x, hidden_size):
    with torch.inference_mode():
        if model.instant:
            return np.concatenate([model(torch.from_numpy(x[i:i + 512]), torch.zeros((len(x[i:i + 512]), hidden_size)))[0].numpy()
                                   for i in range(0, len(x), 512)])
        hidden = torch.zeros((1, hidden_size))
        actions = []
        for row in x:
            action, hidden = model(torch.from_numpy(row[None]), hidden)
            actions.append(action[0].numpy())
        return np.array(actions)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', required=True)
    p.add_argument('--evaluation', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--case', action='append', choices=['solo', 'solo-offset', 'traffic'])
    args = p.parse_args()
    output = Path(args.out)
    if output.exists():
        raise ValueError('Preserve diagnostics; choose a new output')
    torch.set_num_threads(1)
    home = Path(args.model)
    metadata = json.loads((home / 'metadata.json').read_text())
    checkpoint = torch.load(home / 'model.pt', map_location='cpu', weights_only=True)
    if checkpoint['schema'] != metadata['schema'] or checkpoint['modelConfig'] != metadata['modelConfig']:
        raise ValueError('Checkpoint/metadata contracts disagree')
    schema = checkpoint['schema']
    model = PulsePolicy(schema, **checkpoint['modelConfig']).eval()
    model.load_state_dict(checkpoint['weights'])
    indices = [i for i, f in enumerate(schema['fields']) if f['name'] in
               ['ego.previousSteer', 'ego.previousLongitudinal', 'ego.heldSteer', 'ego.heldLongitudinal']]
    results = []
    actuator = next(i for i, f in enumerate(schema['fields']) if f['name'] == 'ego.steering')
    for case in args.case or ['solo', 'solo-offset', 'traffic']:
        for mode in ['teacher', 'policy']:
            path = Path(args.evaluation) / f'{case}-{mode}.jsonl'
            records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
            manifest = records[0]
            if any(manifest['versions'][key] != metadata[key] for key in
                   ['schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest']):
                raise ValueError(f'Incompatible trace: {path}')
            all_rows = [row for row in records if row['type'] == 'step']
            # Score the complete recurrent sequence, then truncate the statistics
            # at the first illegal/damaged/reversed physical state. Do not remove
            # rows in the middle and falsely pretend the memory was contiguous.
            x = np.array([row['observation']['normalized'] for row in all_rows], dtype=np.float32)
            target = np.array([[row['teacherControls']['steer'], row['teacherControls']['throttle'] - row['teacherControls']['brake']]
                               for row in all_rows], dtype=np.float32)
            if x.shape[1] != schema['size'] or not np.isfinite(x).all() or not np.isfinite(target).all():
                raise ValueError('Invalid diagnostic numbers')
            predicted = infer(model, x, schema['hidden'])
            count = len(all_rows)
            for i, row in enumerate(all_rows):
                if abs(row['before']['lateral']) > row['legalTrackLimit'] or row['before']['damage'] > .001 or row['progressDelta'] < -.01:
                    count = i
                    break
            if not count:
                raise ValueError('No clean prefix to diagnose')
            result = {'case': case, 'mode': mode, 'cleanPrefixSeconds': all_rows[count - 1]['time'] + all_rows[count - 1]['dt'],
                      'traceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                      'commandImitation': metrics(all_rows[:count], predicted[:count], target[:count])}
            held = np.array([[row['before']['controls']['steer'], row['before']['controls']['throttle'] - row['before']['controls']['brake']]
                             for row in all_rows[:count]], dtype=np.float32)
            result['holdCommandBaseline'] = metrics(all_rows[:count], held, target[:count])
            x[:, indices] = 0
            history_masked = infer(model, x, schema['hidden'])
            result['historyMaskedImitation'] = metrics(all_rows[:count], history_masked[:count], target[:count])
            x[:, actuator] = 0
            actuator_masked = infer(model, x, schema['hidden'])
            result['actuatorAndHistoryMaskedImitation'] = metrics(all_rows[:count], actuator_masked[:count], target[:count])
            results.append(result)
    report = {'scope': 'Offline commands only. INTERCEPT labels teacher and student states; no racing or pass evidence.',
              'model': metadata['modelSha256'], 'schemaVersion': metadata['schemaVersion'],
              'recurrentShadowScope': 'Memory is reconstructed on each recorded observation, without inference drops. This is not a worker replay.',
              'results': results}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2))
    print(json.dumps({'report': str(output), 'results': [{'case': r['case'], 'mode': r['mode'],
          'cleanPrefixSeconds': r['cleanPrefixSeconds'], 'steerRmse': r['commandImitation']['steer']['rmse'],
          'longitudinalRmse': r['commandImitation']['longitudinal']['rmse'],
          'historyMaskedSteerRmse': r['historyMaskedImitation']['steer']['rmse'],
          'actuatorMaskedSteerRmse': r['actuatorAndHistoryMaskedImitation']['steer']['rmse'],
          'holdBaselineSteerRmse': r['holdCommandBaseline']['steer']['rmse']} for r in results]}))


if __name__ == '__main__':
    main()
