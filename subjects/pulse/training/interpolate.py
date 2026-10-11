"""Fixed pedal-weight interpolation. One exported policy, no runtime arbitration."""
import argparse
import hashlib
import json
from pathlib import Path
import torch
import onnx
from model import PulsePolicy


def pedal_weights(a, b, amount):
    if not 0 <= amount <= 1 or a.keys() != b.keys():
        raise ValueError('Interpolation contract mismatch')
    result = {}
    for name in a:
        if a[name].shape != b[name].shape:
            raise ValueError('Tensor shapes differ')
        if name.startswith('pedals.'):
            result[name] = a[name] * (1 - amount) + b[name] * amount
        else:
            if not torch.equal(a[name], b[name]):
                raise ValueError('Frozen steering/encoder differ; cannot attribute pedal interpolation')
            result[name] = a[name].clone()
    return result


def load(path):
    metadata = json.loads((path / 'metadata.json').read_text())
    if not metadata['modelConfig'].get('splitMotor'):
        raise ValueError('Only the isolated learned pedal head can be interpolated')
    for n in [1, 16]:
        if hashlib.sha256((path / f'policy-{n}.onnx').read_bytes()).hexdigest() != metadata['modelSha256'][str(n)]:
            raise ValueError('Parent graph integrity mismatch')
    checkpoint = torch.load(path / 'model.pt', map_location='cpu', weights_only=True)
    if checkpoint['schema'] != metadata['schema'] or checkpoint['modelConfig'] != metadata['modelConfig']:
        raise ValueError('Parent checkpoint contract mismatch')
    model = PulsePolicy(checkpoint['schema'], **checkpoint['modelConfig']).eval()
    model.load_state_dict(checkpoint['weights'])
    parity = json.loads((path / 'parity.json').read_text())
    hidden = torch.zeros(1, checkpoint['schema']['hidden'])
    with torch.inference_mode():
        for row in parity:
            action, hidden = model(torch.tensor([row['observation']]), hidden)
            if not torch.allclose(action[0], torch.tensor(row['action']), atol=2e-4) or not torch.allclose(hidden[0], torch.tensor(row['hidden']), atol=2e-4):
                raise ValueError('Parent weights differ from the recorded graph parity')
    return metadata, checkpoint, parity


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--a', required=True); p.add_argument('--b', required=True)
    p.add_argument('--amount', type=float, required=True); p.add_argument('--out', required=True)
    args = p.parse_args()
    if not 0 < args.amount < 1 or Path(args.out).exists():
        raise ValueError('Use a fresh output and an interpolation amount between 0 and 1')
    torch.set_num_threads(4)
    a, ca, samples = load(Path(args.a)); b, cb, _ = load(Path(args.b))
    for key in ['schema', 'modelConfig', 'schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest']:
        if a[key] != b[key]:
            raise ValueError(f'Parent {key} differs')
    weights = pedal_weights(ca['weights'], cb['weights'], args.amount)
    schema, config = ca['schema'], ca['modelConfig']
    model = PulsePolicy(schema, **config).eval(); model.load_state_dict(weights)
    out = Path(args.out); out.mkdir(parents=True)
    torch.save({'weights': weights, 'schema': schema, 'modelConfig': config}, out / 'model.pt')
    for n in [1, 16]:
        torch.onnx.export(model, (torch.zeros(n, schema['size']), torch.zeros(n, schema['hidden'])), out / f'policy-{n}.onnx',
                          dynamo=False, opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        graph = onnx.load(out / f'policy-{n}.onnx'); graph.ir_version = 10
        onnx.checker.check_model(graph); onnx.save(graph, out / f'policy-{n}.onnx')
    parity, hidden = [], torch.zeros(1, schema['hidden'])
    with torch.inference_mode():
        for sample in samples:
            action, hidden = model(torch.tensor([sample['observation']]), hidden)
            parity.append({'observation': sample['observation'], 'action': action[0].tolist(), 'hidden': hidden[0].tolist()})
    (out / 'parity.json').write_text(json.dumps(parity))
    datasets = {json.dumps(row, sort_keys=True): row for parent in [a, b] for row in parent['datasets']}
    metadata = {**a, 'stage': 'M1 research: fixed learned pedal-weight interpolation; driving must be validated',
                'checkpointEpoch': None, 'checkpointDirectory': out.as_posix(), 'bestValidationLoss': None,
                'checkpointSelection': 'Fixed interpolation; reused development fixtures are not an unseen test',
                'training': {'out': out.as_posix(), 'interpolation': vars(args), 'sourceRuns': [a['training'], b['training']]},
                'parentModelSha256': [a['modelSha256'], b['modelSha256']], 'datasets': list(datasets.values()),
                'trainEpisodes': sorted(set(a['trainEpisodes']) | set(b['trainEpisodes'])),
                'validationEpisodes': sorted(set(a['validationEpisodes']) | set(b['validationEpisodes'])),
                'seconds': 0, 'gradientUpdates': 0,
                'supportedTracks': sorted(set(a['supportedTracks']) & set(b['supportedTracks'])),
                'supportedClasses': sorted(set(a['supportedClasses']) & set(b['supportedClasses'])),
                'interpolationDigest': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'modelSha256': {str(n): hashlib.sha256((out / f'policy-{n}.onnx').read_bytes()).hexdigest() for n in [1, 16]}}
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    print(json.dumps({'exported': out.as_posix(), 'amount': args.amount, 'parameters': sum(p.numel() for p in model.parameters())}))


if __name__ == '__main__':
    main()
