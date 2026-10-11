"""Export completed fixed-epoch actors; never overwrite a completed experiment."""
import argparse
import hashlib
import json
from pathlib import Path
import torch
import onnx
from model import PulsePolicy

p = argparse.ArgumentParser()
p.add_argument('--run', required=True)
args = p.parse_args()
root = Path(args.run)
metadata = json.loads((root / 'metadata.json').read_text())  # Completed trainer only.
parity_inputs = [r['observation'] for r in json.loads((root / 'parity.json').read_text())]
torch.set_num_threads(4)
for source in sorted((root / 'checkpoints').glob('epoch-*.pt')):
    checkpoint = torch.load(source, map_location='cpu', weights_only=True)
    schema, config = checkpoint['schema'], checkpoint['modelConfig']
    if schema != metadata['schema'] or config != metadata['modelConfig']:
        raise ValueError('Snapshot differs from completed run contract')
    out = root / source.stem
    if out.exists():
        raise ValueError(f'Export exists: {out}')
    out.mkdir()
    model = PulsePolicy(schema, **config).eval()
    model.load_state_dict(checkpoint['weights'])
    torch.save(checkpoint, out / 'model.pt')
    for n in [1, 16]:
        torch.onnx.export(model, (torch.zeros(n, schema['size']), torch.zeros(n, schema['hidden'])), out / f'policy-{n}.onnx',
                          dynamo=False, opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        graph = onnx.load(out / f'policy-{n}.onnx'); graph.ir_version = 10
        onnx.checker.check_model(graph); onnx.save(graph, out / f'policy-{n}.onnx')
    parity, hidden = [], torch.zeros(1, schema['hidden'])
    with torch.inference_mode():
        for x in parity_inputs:
            action, hidden = model(torch.tensor([x], dtype=torch.float32), hidden)
            parity.append({'observation': x, 'action': action[0].tolist(), 'hidden': hidden[0].tolist()})
    (out / 'parity.json').write_text(json.dumps(parity))
    epoch = checkpoint['epoch']
    row = next(r for r in json.loads((root / 'training.json').read_text())['history'] if r['epoch'] == epoch)
    snapshot_metadata = {**metadata, 'checkpointEpoch': epoch, 'imitationLossAtCheckpoint': row['validationLoss'],
                         'checkpointDirectory': out.as_posix(),
                         'bestValidationLoss': None, 'checkpointSelection': 'fixed epoch; reused development driving fixtures are not an unseen test',
                         'snapshotSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                         'snapshotExporterDigest': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                         'modelSha256': {str(n): hashlib.sha256((out / f'policy-{n}.onnx').read_bytes()).hexdigest() for n in [1, 16]}}
    (out / 'metadata.json').write_text(json.dumps(snapshot_metadata, indent=2))
    print(json.dumps({'exported': str(out), 'epoch': epoch}))
