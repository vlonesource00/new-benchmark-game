"""Bounded CUDA pilot. Fit intentions to two admitted own-policy trajectories;
physical development runs, rather than label error, decide whether to keep it.
Every epoch is resumable and all source/data contracts are pinned.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import torch
import onnx
from plan_model import PlanPolicy
from checkpoint_state import atomic_json, atomic_checkpoint, capture_state, restore_state


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--data', required=True); p.add_argument('--parent', required=True)
    p.add_argument('--out', required=True); p.add_argument('--epochs', type=int, default=80)
    p.add_argument('--seed', type=int, default=7421); p.add_argument('--lr', type=float, default=.001)
    p.add_argument('--continue-run', action='store_true')
    args = p.parse_args()
    if not 1 <= args.epochs <= 200 or not 0 < args.lr <= .003:
        raise ValueError('Invalid bounded fit')
    out, root = Path(args.out), Path(args.parent)
    if out.exists() and not args.continue_run:
        raise ValueError('Preserve previous experiment; choose a new output')
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA required')
    torch.set_num_threads(4); torch.manual_seed(args.seed)
    parent = json.loads((root / 'metadata.json').read_text())
    checkpoint = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    schema, config = checkpoint['schema'], checkpoint['modelConfig']
    if not config.get('trafficMemory') or config.get('trafficGate'):
        raise ValueError('Frozen ungated memory encoder required')
    model = PlanPolicy(schema, config).to('cuda')
    model.encoder.load_state_dict(checkpoint['weights'], strict=True)
    frozen = {k: v.detach().cpu().clone() for k, v in model.encoder.state_dict().items()}
    data, families, source_files = {}, {}, []
    for split in ['train', 'validation']:
        data[split], families[split] = [], set()
        for file in sorted((Path(args.data) / split).glob('*.jsonl')):
            records = [json.loads(line) for line in file.read_text().splitlines() if line.strip()]
            m, rows = records[0], records[1:]
            if (m['format'] != 'pulse-plan-targets-v1' or m['split'] != split or not m['trainingOnly']
                    or m['schema'] != schema or m['contract']['version'] != 'pulse-route-speed-v3'):
                raise ValueError('Invalid plan label contract')
            if not rows or not rows[0]['reset'] or rows[0]['request']['base'] != 0:
                raise ValueError('Plan history must begin at its actual memory reset')
            previous = 0
            for row in rows:
                if row['request']['base'] != previous or row['request']['seq'] <= previous:
                    raise ValueError('Plan labels are not the accepted request ancestry')
                previous = row['request']['seq']
            for key in ['schemaDigest', 'simulatorDigest', 'observationDigest']:
                if m['versions'][key] != parent[key]:
                    raise ValueError('Changed source contract')
            x = torch.tensor([r['observation'] for r in rows], device='cuda')
            y = torch.tensor([r['target'] for r in rows], device='cuda')
            if x.shape != (len(rows), schema['size']) or y.shape != (len(rows), 4) or not torch.isfinite(x).all() or not torch.isfinite(y).all() or y.abs().max() > 1:
                raise ValueError('Invalid plan targets')
            with torch.inference_mode():
                inputs, present = model.sequence_inputs(x)
            data[split].append({'x': x, 'inputs': inputs.clone(), 'present': present.clone(), 'y': y})
            families[split].add(m['physicalFamily'])
            source_files.append({'file': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
        if not data[split]:
            raise ValueError('Missing explicit data split')
    if families['train'] & families['validation'] or None in families['train'] | families['validation']:
        raise ValueError('Physical families are missing or overlap')
    sources = ['fit_plan.py', 'plan_model.py', 'model.py', 'segmented_gru.py', 'checkpoint_state.py']
    source_digest = hashlib.sha256(b''.join((Path(__file__).parent / f).read_bytes() for f in sources)).hexdigest()
    contract = {'arguments': {k: v for k, v in vars(args).items() if k != 'continue_run'},
                'actionContract': 'pulse-route-speed-v3', 'trainerDigest': source_digest,
                'parent': hashlib.sha256((root / 'model.pt').read_bytes()).hexdigest(), 'data': source_files}
    optimizer = torch.optim.AdamW(model.intent.parameters(), lr=args.lr, weight_decay=1e-4)
    rng = np.random.default_rng(args.seed)
    first, elapsed, history, best_checkpoint = 1, 0., [], None
    if args.continue_run:
        saved = restore_state(out / 'resume.pt', model, optimizer, rng, contract)
        first, elapsed, history, best_checkpoint = saved['epoch'] + 1, saved['seconds'], saved['history'], saved['bestCheckpoint']
    else:
        out.mkdir(parents=True); archive = out / 'trainer-source'; archive.mkdir()
        for f in sources:
            (archive / f).write_bytes((Path(__file__).parent / f).read_bytes())
    for k, v in model.encoder.state_dict().items():
        if not torch.equal(v.cpu(), frozen[k]):
            raise ValueError('Resume changed frozen encoder')
    best = min((h['validationLoss'] for h in history), default=float('inf'))
    started = time.perf_counter(); seconds = elapsed
    def loss(sample):
        predicted = model.intent(sample['inputs']) * sample['present']
        return ((predicted - sample['y']).square() * predicted.new_tensor([4., 4., 4., 1.])).mean()
    for epoch in range(first, args.epochs + 1):
        model.train(); losses = []
        for i in rng.permutation(len(data['train'])):
            sample = data['train'][i]
            order = rng.permutation(len(sample['y']))
            for start in range(0, len(order), 512):
                indices = torch.tensor(order[start:start + 512], device='cuda')
                batch = {k: v[indices] for k, v in sample.items() if k != 'x'}
                optimizer.zero_grad(set_to_none=True); error = loss(batch); error.backward()
                torch.nn.utils.clip_grad_norm_(model.intent.parameters(), 1.)
                optimizer.step(); losses.append(error.item())
        model.eval()
        with torch.no_grad():
            validation = sum(loss(s).item() for s in data['validation']) / len(data['validation'])
        history.append({'epoch': epoch, 'trainLoss': float(np.mean(losses)), 'validationLoss': validation})
        if validation < best:
            best = validation; best_checkpoint = {'epoch': epoch, 'weights': {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
        seconds = elapsed + time.perf_counter() - started
        atomic_checkpoint(out / 'resume.pt', capture_state(model, optimizer, rng, contract, epoch, best_checkpoint, history, seconds))
        if epoch % 20 == 0 or epoch == args.epochs:
            atomic_checkpoint(out / f'epoch-{epoch}.pt', {'epoch': epoch, 'contract': contract,
                'weights': model.state_dict(), 'history': history, 'seconds': seconds})
        atomic_json(out / 'progress.json', {'complete': False, 'phase': 'exporting' if epoch == args.epochs else 'training', 'history': history, 'seconds': seconds,
                                         'selectedEpoch': best_checkpoint['epoch'], 'contract': contract})
        if epoch == 1 or epoch % 20 == 0:
            print(json.dumps(history[-1]), flush=True)
    model.load_state_dict(best_checkpoint['weights']); model.eval().cpu()
    if any(not torch.equal(v, frozen[k]) for k, v in model.encoder.state_dict().items()):
        raise ValueError('Fitting changed the preserved encoder')
    atomic_checkpoint(out / 'model.pt', {'format': 'pulse-plan-policy-v1', 'weights': model.state_dict(),
                                       'schema': schema, 'encoderConfig': config, 'contract': contract})
    for n in [1, 16]:
        torch.onnx.export(model, (torch.zeros(n, schema['size']), torch.zeros(n, schema['hidden'])),
                          out / f'policy-{n}.onnx', dynamo=False, opset_version=17,
                          input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        graph = onnx.load(out / f'policy-{n}.onnx'); graph.ir_version = 10
        onnx.checker.check_model(graph); onnx.save(graph, out / f'policy-{n}.onnx')
    h, parity = torch.zeros(1, schema['hidden']), []
    with torch.inference_mode():
        for x in data['train'][0]['x'][:32].cpu():
            action, h = model(x[None], h)
            parity.append({'observation': x.tolist(), 'action': action[0].tolist(), 'hidden': h[0].tolist()})
    atomic_json(out / 'parity.json', parity)
    metadata = {k: parent[k] for k in ['schemaVersion', 'schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest', 'supportedTracks', 'supportedClasses']}
    metadata.update({'schema': schema, 'actionContract': 'pulse-route-speed-v3', 'actionSize': 4, 'architecture': 'PULSE-FROZEN-ENCODER-ROUTE-64',
                     'checkpointDirectory': out.as_posix(),
                     'activeMemoryUnits': 64, 'trainableParameters': sum(p.numel() for p in model.intent.parameters()),
                     'parameters': sum(p.numel() for p in model.parameters()), 'selectedEpoch': best_checkpoint['epoch'],
                     'bestValidationLoss': best, 'frozenEncoderBitwise': True, 'datasets': source_files,
                     'trainerDigest': source_digest, 'parentModelSha256': parent['modelSha256'],
                     'modelSha256': {str(n): hashlib.sha256((out / f'policy-{n}.onnx').read_bytes()).hexdigest() for n in [1, 16]},
                     'stage': 'Two-family intention pilot; matched autonomous driving required before selection',
                     'strategy': 'Unchanged laboratory strategy; no learned stint/energy/weather management',
                     'checkpointSelection': 'Minimum label validation loss proposes a candidate; physical development outcomes must approve it'})
    atomic_json(out / 'metadata.json', metadata)
    atomic_json(out / 'progress.json', {'complete': True, 'phase': 'complete', 'history': history, 'seconds': seconds,
                                     'selectedEpoch': best_checkpoint['epoch'], 'contract': contract})
    print(json.dumps({'complete': True, 'selectedEpoch': metadata['selectedEpoch'], 'parameters': metadata['parameters'],
                      'trainableParameters': metadata['trainableParameters'], 'seconds': seconds}), flush=True)


if __name__ == '__main__':
    main()
