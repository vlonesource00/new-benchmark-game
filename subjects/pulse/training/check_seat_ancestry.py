"""Verify accepted-only training history against actual recorded NN proposals."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import torch
from model import PulsePolicy
from outcome_data import accepted_request_rows

p = argparse.ArgumentParser()
p.add_argument('--trace', required=True)
p.add_argument('--model', required=True)
args = p.parse_args()
records = [json.loads(line) for line in Path(args.trace).read_text().splitlines() if line.strip()]
manifest = records[0]
if manifest['settings']['transport'] != 'seat-frame':
    raise ValueError('Recorded single-in-flight frame transport required')
root = Path(args.model)
metadata = json.loads((root / 'metadata.json').read_text())
if manifest['policy']['modelSha256']['1'] != metadata['modelSha256']['1']:
    raise ValueError('Exact original model required')
checkpoint = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
torch.set_num_threads(4)
model = PulsePolicy(checkpoint['schema'], **checkpoint['modelConfig']).eval()
model.load_state_dict(checkpoint['weights'], strict=True)
rows = [r for r in records if r['type'] == 'step']
accepted = accepted_request_rows(rows)
hidden = torch.zeros(1, checkpoint['schema']['hidden'])
action_error = norm_error = 0.
with torch.inference_mode():
    for row in accepted:
        norm_error = max(norm_error, abs(float(torch.linalg.vector_norm(hidden)) - row['hiddenNorm']))
        x = torch.from_numpy(np.asarray(row['observation']['normalized'], dtype=np.float32))[None]
        action, hidden = model(x, hidden)
        action_error = max(action_error, float(np.max(np.abs(action[0].numpy() - row['policyProposal']))))
sampled_targets = bool(manifest.get('outcomeTraining'))
if (not sampled_targets and action_error > 3e-6) or norm_error > 1e-5:
    raise AssertionError((action_error, norm_error))
print(json.dumps({'frames': len(rows), 'requests': sum(r.get('request') is not None for r in rows),
                  'acceptedSteps': len(accepted), 'maxActionError': action_error, 'maxHiddenNormError': norm_error,
                  'sampledCommandTargets': sampled_targets, 'hiddenAncestryVerified': True,
                  'traceSha256': hashlib.sha256(Path(args.trace).read_bytes()).hexdigest(),
                  'scope': 'Accepted-only recurrent history matches recorded hidden state. Sampled targets intentionally differ from raw NN actions; no physical improvement claim.'}))
