"""Export the existing learned motor for synchronous local inference."""
import argparse
import hashlib
import json
from pathlib import Path
import torch
from model import PulsePolicy

p = argparse.ArgumentParser()
p.add_argument('--model', required=True)
args = p.parse_args()
root = Path(args.model)
out = root / 'fast-motor.json'
if out.exists():
    raise ValueError('Motor export exists; preserve it')
metadata = json.loads((root / 'metadata.json').read_text())
config = metadata['modelConfig']
if not (config.get('instant') and config.get('splitMotor') and config.get('trafficResidual')):
    raise ValueError('Local motor requires the explicit preserved traffic-residual actor')
checkpoint = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
if checkpoint['schema'] != metadata['schema'] or checkpoint['modelConfig'] != config:
    raise ValueError('Checkpoint and declared model differ')
model = PulsePolicy(checkpoint['schema'], **config).eval()
model.load_state_dict(checkpoint['weights'])
layers = {}
for name in ['context.0', 'context.2', 'head.0', 'head.2', 'pedals.0', 'pedals.2']:
    weights = checkpoint['weights'][name + '.weight']
    bias = checkpoint['weights'][name + '.bias']
    layers[name] = {'shape': list(weights.shape), 'weight': weights.flatten().tolist(), 'bias': bias.tolist()}
payload = {'format': 'pulse-fast-motor-v1', 'schemaVersion': metadata['schemaVersion'],
           'schemaDigest': metadata['schemaDigest'], 'modelSha256': metadata['modelSha256'],
           'ownSize': model.own_size, 'observationSize': metadata['schema']['size'],
           'mask': model.motor_input_mask.tolist() if config.get('motorHistoryMask') else [1.] * model.own_size,
           'layers': layers, 'sourceCheckpointSha256': hashlib.sha256((root / 'model.pt').read_bytes()).hexdigest(),
           'exporterDigest': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
serialized = json.dumps(payload, separators=(',', ':'))
out.write_text(json.dumps({'payloadJson': serialized, 'sha256': hashlib.sha256(serialized.encode()).hexdigest()}))
print(json.dumps({'file': str(out), 'parameters': sum(len(v['weight']) + len(v['bias']) for v in layers.values()),
                  'scope': 'Same learned motor weights; no expert controller or racing line'}))
