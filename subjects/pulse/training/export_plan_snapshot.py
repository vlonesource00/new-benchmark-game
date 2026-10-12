"""Export an exact saved intention epoch; never refit or select by label error."""
import argparse
import hashlib
import itertools
import json
import sys
from pathlib import Path
import torch
import onnx


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--run', required=True)
    p.add_argument('--epoch', type=int, required=True)
    args = p.parse_args()
    root = Path(args.run).resolve()
    archive = root / 'trainer-source'
    sys.path.insert(0, str(archive))
    from plan_model import PlanPolicy
    from checkpoint_state import atomic_json, atomic_checkpoint
    meta = json.loads((root / 'metadata.json').read_text())
    if meta['actionContract'] != 'pulse-route-speed-v3' or args.epoch < 1:
        raise ValueError('Explicit four-output intention epoch required')
    source = root / f'epoch-{args.epoch}.pt'
    if not source.exists():
        source = root / 'resume.pt'
    saved = torch.load(source, map_location='cpu', weights_only=True)
    parent = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    if saved['epoch'] != args.epoch or saved['contract'] != parent['contract']:
        raise ValueError('Exact requested epoch with the original contract is unavailable')
    sources = ['fit_plan.py', 'plan_model.py', 'model.py', 'segmented_gru.py', 'checkpoint_state.py']
    archived = hashlib.sha256(b''.join((archive / f).read_bytes() for f in sources)).hexdigest()
    if archived != saved['contract']['trainerDigest']:
        raise ValueError('Archived trainer changed')
    for k, v in saved['weights'].items():
        if not torch.isfinite(v).all():
            raise ValueError('Nonfinite saved weight')
        if k.startswith('encoder.') and not torch.equal(v, parent['weights'][k]):
            raise ValueError('Frozen encoder changed')
    out = root / f'epoch-{args.epoch}'
    if out.exists():
        raise ValueError('Preserve existing snapshot')
    model = PlanPolicy(parent['schema'], parent['encoderConfig'])
    model.load_state_dict(saved['weights'], strict=True)
    model.eval()
    out.mkdir()
    atomic_checkpoint(out / 'model.pt', {**parent, 'weights': saved['weights']})
    schema = parent['schema']
    for n in [1, 16]:
        torch.onnx.export(model, (torch.zeros(n, schema['size']), torch.zeros(n, schema['hidden'])),
                          out / f'policy-{n}.onnx', dynamo=False, opset_version=17,
                          input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        graph = onnx.load(out / f'policy-{n}.onnx')
        graph.ir_version = 10
        onnx.checker.check_model(graph)
        onnx.save(graph, out / f'policy-{n}.onnx')
    dataset = saved['contract']['data'][0]
    file = Path(dataset['file'])
    if hashlib.sha256(file.read_bytes()).hexdigest() != dataset['sha256']:
        raise ValueError('Parity dataset changed')
    with file.open() as f:
        rows = [json.loads(line) for line in itertools.islice(f, 1, 33)]
    hidden, parity = torch.zeros(1, schema['hidden']), []
    with torch.inference_mode():
        for row in rows:
            observation = torch.tensor([row['observation']])
            action, hidden = model(observation, hidden)
            parity.append({'observation': row['observation'], 'action': action[0].tolist(), 'hidden': hidden[0].tolist()})
    atomic_json(out / 'parity.json', parity)
    selected = next(row for row in saved['history'] if row['epoch'] == args.epoch)
    meta.update({'selectedEpoch': args.epoch, 'checkpointEpoch': args.epoch,
        'labelMinimumValidationLoss': meta['bestValidationLoss'], 'bestValidationLoss': selected['validationLoss'],
        'checkpointDirectory': 'artifacts/models/' + root.name + '/' + out.name,
        'checkpointSelection': 'Fixed saved epoch; physical outcomes required before promotion',
        'snapshotSource': source.name, 'snapshotSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'modelSha256': {str(n): hashlib.sha256((out / f'policy-{n}.onnx').read_bytes()).hexdigest() for n in [1, 16]}})
    atomic_json(out / 'metadata.json', meta)
    print(json.dumps({'exported': str(out), 'epoch': args.epoch, 'frozenEncoderBitwise': True}))


if __name__ == '__main__':
    main()
