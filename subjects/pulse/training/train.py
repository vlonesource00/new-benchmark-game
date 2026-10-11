"""Bounded recurrent behavior cloning, with whole-episode holdout and burn-in."""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import torch

from model import PulsePolicy
from data import episodes, assert_disjoint, windows


def batch(data, indices, length, device):
    x = torch.from_numpy(np.stack([data[i]['x'][s:s+length] for i, s in indices])).to(device)
    y = torch.from_numpy(np.stack([data[i]['y'][s:s+length] for i, s in indices])).to(device)
    return x, y


def rollout_loss(model, x, y, burn, fresh, steer_weight):
    h = torch.zeros(x.shape[0], model.hidden_size, device=x.device)
    losses = []
    for t in range(x.shape[1]):
        if t < burn and not fresh.any():
            with torch.no_grad():
                _, h = model(x[:, t], h)
        else:
            action, h = model(x[:, t], h)
            weight = 1 + 2 * (y[:, t, 1:] < -.05).float()
            error = ((action - y[:, t]).square() * torch.cat([torch.ones_like(weight) * steer_weight, weight], 1)).mean(1)
            if t < burn:
                # A real episode start must learn its first command. Only mid-episode
                # windows burn in; otherwise initial steering can be unconstrained.
                error = (error * fresh).sum() / fresh.sum().clamp(min=1)
                h = torch.where(fresh[:, None].bool(), h, h.detach())
            else:
                error = error.mean()
            losses.append(error)
    return torch.stack(losses).mean()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--schema', default='artifacts/schema.json')
    p.add_argument('--data', default='data')
    p.add_argument('--out', default='artifacts/model')
    p.add_argument('--epochs', type=int, default=20)
    p.add_argument('--batch', type=int, default=64)
    p.add_argument('--length', type=int, default=64)
    p.add_argument('--burn', type=int, default=8)
    p.add_argument('--steer-weight', type=float, default=10)
    p.add_argument('--seed', type=int, default=7)
    p.add_argument('--corrections', action='append', default=[], help='Roots with train/validation expert-labelled student episodes')
    p.add_argument('--corrective-weight', type=int, default=3)
    p.add_argument('--resume', help='Completed compatible checkpoint directory')
    p.add_argument('--lr', type=float, default=3e-4)
    p.add_argument('--history-dropout', type=float, default=0, help='Training-only whole-window dropout of previous/held request features')
    p.add_argument('--reactive', action='store_true', help='Learn direct motion feedback alongside recurrent context')
    args = p.parse_args()
    if args.epochs < 1 or args.epochs > 200 or not 0 <= args.burn < args.length or not 8 <= args.length <= 512 or not 1 <= args.batch <= 512 or not 1 <= args.corrective_weight <= 10 or not 0 < args.lr < .01 or not 0 <= args.history_dropout <= .9:
        raise ValueError('Invalid bounded training settings')
    out = Path(args.out)
    if out.exists():
        raise ValueError('Output already exists. Preserve it and use a new --out experiment directory.')
    if not torch.cuda.is_available():
        raise RuntimeError('Run the GPU doctor first; CUDA training is required for this test')
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(4)
    schema = json.loads(Path(args.schema).read_text())
    history_indices = [i for i, f in enumerate(schema['fields']) if f['name'] in
                       ['ego.previousSteer', 'ego.previousLongitudinal', 'ego.heldSteer', 'ego.heldLongitudinal']]
    train = episodes(Path(args.data) / 'train', schema, 'train')
    validation = episodes(Path(args.data) / 'validation', schema, 'validation')
    for root in args.corrections:
        train.extend(episodes(Path(root) / 'train', schema, 'train', corrective=True))
        validation.extend(episodes(Path(root) / 'validation', schema, 'validation', corrective=True, optional=True))
    assert_disjoint(train, validation)
    identities = ['schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest']
    version = train[0]['manifest']['versions']
    for key in identities:
        if len({e['manifest']['versions'][key] for e in train + validation}) != 1:
            raise ValueError(f'Mixed {key}; rerecord compatible episodes')
    model = PulsePolicy(schema, reactive=args.reactive).to('cuda')
    parent = None
    if args.resume:
        parent = json.loads((Path(args.resume) / 'metadata.json').read_text())
        if any(parent[key] != version[key] for key in identities):
            raise ValueError('Resume checkpoint is incompatible with the dataset')
        checkpoint = torch.load(Path(args.resume) / 'model.pt', map_location='cuda', weights_only=True)
        if checkpoint['schema'] != schema:
            raise ValueError('Resume schema mismatch')
        model.load_parent(checkpoint['weights'])
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    train_windows = windows(train, args.length, args.length // 2, args.corrective_weight)
    valid_windows = windows(validation, args.length, args.length)
    if not train_windows or not valid_windows:
        raise ValueError('No sequences long enough for the requested window')
    rng = np.random.default_rng(args.seed)
    out.mkdir(parents=True, exist_ok=False)
    best, history, started = float('inf'), [], time.perf_counter()
    for epoch in range(args.epochs):
        model.train(); permutation = rng.permutation(len(train_windows)); losses = []
        for j in range(0, len(permutation), args.batch):
            indices = [train_windows[k] for k in permutation[j:j+args.batch]]
            x, y = batch(train, indices, args.length, 'cuda')
            if args.history_dropout:
                # These are highly correlated with expert targets on teacher
                # trajectories. Prevent a shortcut that copies them instead of
                # learning corrective feedback from current physical sensors.
                keep = (torch.rand(x.shape[0], 1, 1, device='cuda') >= args.history_dropout).to(x.dtype)
                x[:, :, history_indices] *= keep
            optimizer.zero_grad(set_to_none=True)
            fresh = torch.tensor([s == 0 and train[i]['fresh'] for i, s in indices], device='cuda', dtype=torch.float32)
            loss = rollout_loss(model, x, y, args.burn, fresh, args.steer_weight)
            if not torch.isfinite(loss):
                raise RuntimeError('Non-finite loss')
            loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1); optimizer.step()
            losses.append(float(loss.detach()))
        model.eval(); valid = []
        with torch.inference_mode():
            for j in range(0, len(valid_windows), args.batch):
                indices = valid_windows[j:j+args.batch]
                x, y = batch(validation, indices, args.length, 'cuda')
                fresh = torch.tensor([s == 0 and validation[i]['fresh'] for i, s in indices], device='cuda', dtype=torch.float32)
                valid.append(float(rollout_loss(model, x, y, args.burn, fresh, args.steer_weight)))
        row = {'epoch': epoch + 1, 'trainLoss': float(np.mean(losses)), 'validationLoss': float(np.mean(valid))}
        history.append(row)
        if row['validationLoss'] < best:
            best = row['validationLoss']
            torch.save({'weights': model.state_dict(), 'schema': schema, 'modelConfig': {'reactive': args.reactive}}, out / 'model.pt')
        print(json.dumps(row), flush=True)
        (out / 'training.json').write_text(json.dumps({'history': history, 'seconds': time.perf_counter() - started}, indent=2))
    checkpoint = torch.load(out / 'model.pt', map_location='cpu', weights_only=True)
    model = PulsePolicy(schema, reactive=args.reactive).cpu().eval(); model.load_state_dict(checkpoint['weights'])
    for n in [1, 16]:
        x = torch.zeros(n, schema['size']); h = torch.zeros(n, schema['hidden'])
        torch.onnx.export(model, (x, h), out / f'policy-{n}.onnx', dynamo=False, opset_version=17,
                          input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        # Basic operators permit WebGPU; explicit legacy IR also permits pinned JS ORT.
        import onnx
        graph = onnx.load(out / f'policy-{n}.onnx'); graph.ir_version = 10
        onnx.checker.check_model(graph); onnx.save(graph, out / f'policy-{n}.onnx')
    samples = train[0]['x'][:32]
    parity = []
    h = torch.zeros(1, schema['hidden'])
    with torch.inference_mode():
        for x in samples:
            a, h = model(torch.from_numpy(x[None]), h)
            parity.append({'observation': x.tolist(), 'action': a[0].tolist(), 'hidden': h[0].tolist()})
    (out / 'parity.json').write_text(json.dumps(parity))
    metadata = {**version, 'schema': schema, 'architecture': 'PULSE-GRU-128-REACTIVE' if args.reactive else 'PULSE-GRU-128',
                'modelConfig': {'reactive': args.reactive}, 'parameters': sum(p.numel() for p in model.parameters()),
                'stage': 'M2 corrective imitation prototype; independent racing unproven' if args.corrections else 'M1 prototype behavior clone; competitive driving unproven', 'training': vars(args),
                'parentModelSha256': parent['modelSha256'] if parent else None,
                'trainerDigest': hashlib.sha256(b''.join((Path(__file__).parent / file).read_bytes() for file in ['train.py', 'model.py', 'data.py'])).hexdigest(),
                'dependencyDigest': hashlib.sha256(b''.join(Path(file).read_bytes() for file in ['uv.lock', 'package-lock.json'])).hexdigest(),
                'bestValidationLoss': best, 'trainEpisodes': [e['path'] for e in train], 'validationEpisodes': [e['path'] for e in validation],
                'supportedTracks': sorted({e['manifest']['settings']['track'] for e in train}),
                'supportedClasses': sorted({e['manifest']['settings']['classId'] for e in train}),
                'datasets': [{'file': e['path'], 'episodeId': e['manifest']['episodeId'], 'startIndex': e['start_index'],
                              'steps': len(e['x']), 'corrective': e['corrective'], 'sha256': e['fingerprint'],
                              'policySha256': e['manifest'].get('policy', {}).get('modelSha256') if e['manifest'].get('policy') else None} for e in train + validation],
                'modelSha256': {str(n): hashlib.sha256((out / f'policy-{n}.onnx').read_bytes()).hexdigest() for n in [1, 16]},
                'seconds': time.perf_counter() - started, 'gitAtRecording': version['git']}
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    print(json.dumps({'complete': True, 'parameters': metadata['parameters'], 'bestValidationLoss': best, 'seconds': metadata['seconds']}))


if __name__ == '__main__':
    main()
