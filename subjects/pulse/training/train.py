"""Bounded recurrent behavior cloning, with whole-episode holdout and burn-in."""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import torch

from model import PulsePolicy, transfer_observations
from data import episodes, assert_disjoint, windows


def batch(data, indices, length, device):
    x = torch.from_numpy(np.stack([data[i]['x'][s:s+length] for i, s in indices])).to(device)
    y = torch.from_numpy(np.stack([data[i]['y'][s:s+length] for i, s in indices])).to(device)
    return x, y


def rollout_loss(model, x, y, burn, fresh, steer_weight):
    if model.instant:
        # Same supervised objective/burn mask, vectorized because actuation has
        # no recurrent dependence. The fresh physical state supplies feedback.
        if model.traffic_memory:
            a = model.traffic_sequence(x, burn, fresh)
        else:
            a, _ = model(x.reshape(-1, x.shape[-1]), torch.zeros(x.shape[0] * x.shape[1], model.hidden_size, device=x.device))
            a = a.reshape_as(y)
        weight = 1 + 2 * (y[:, :, 1:] < -.05).float()
        error = ((a - y).square() * torch.cat([torch.ones_like(weight) * steer_weight, weight], 2)).mean(2)
        if burn and fresh.any():
            first = (error[:, :burn] * fresh[:, None]).sum(0) / fresh.sum()
            return torch.cat([first, error[:, burn:].mean(0)]).mean()
        return error[:, burn:].mean()
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
    p.add_argument('--expert-data', action='append', default=[], help='Additional clean whole-episode expert recoveries')
    p.add_argument('--out', default='artifacts/model')
    p.add_argument('--epochs', type=int, default=20)
    p.add_argument('--batch', type=int, default=64)
    p.add_argument('--length', type=int, default=64)
    p.add_argument('--burn', type=int, default=8)
    p.add_argument('--steer-weight', type=float, default=10)
    p.add_argument('--seed', type=int, default=7)
    p.add_argument('--corrections', action='append', default=[], help='Roots with train/validation expert-labelled student episodes')
    p.add_argument('--corrective-weight', type=int, default=3)
    p.add_argument('--strict-contact-prefixes', action='store_true', help='A/B control: end even explicitly permitted light-rub prefixes at the first damage')
    p.add_argument('--resume', help='Completed compatible checkpoint directory')
    p.add_argument('--transfer-schema', action='store_true', help='Explicitly transfer unchanged v1 inputs into the public v2 conditioning experiment')
    p.add_argument('--lr', type=float, default=3e-4)
    p.add_argument('--history-dropout', type=float, default=0, help='Training-only whole-window dropout of previous/held request features')
    p.add_argument('--reactive', action='store_true', help='Learn direct motion feedback alongside recurrent context')
    p.add_argument('--context-skip', action='store_true', help='Learn a direct current-road/motion path around recurrent filtering')
    p.add_argument('--instant', action='store_true', help='M1 diagnostic: current-state motor actor, without recurrent actuation')
    p.add_argument('--motor-history-mask', action='store_true', help='Instant motor experiment: ignore request history and actual steering in training/inference')
    p.add_argument('--checkpoint-every', type=int, default=0, help='Save fixed-epoch weights for closed-loop development comparisons')
    p.add_argument('--split-motor', action='store_true', help='Freeze learned steering and fit a separate public-state pedal head')
    p.add_argument('--traffic-residual', action='store_true', help='Preserve the empty-rival motor and fit learned traffic corrections')
    p.add_argument('--traffic-memory', action='store_true', help='Learn 64 traffic-memory units while preserving the current-state clean-air motor')
    p.add_argument('--motor-tune', action='store_true', help='Opt-in refit of the clean-air motor; freeze traffic weights and recheck all driving gates')
    args = p.parse_args()
    if args.epochs < 1 or args.epochs > 200 or not 0 <= args.burn < args.length or not 8 <= args.length <= 512 or not 1 <= args.batch <= 512 or not 1 <= args.corrective_weight <= 10 or not 0 < args.lr < .01 or not 0 <= args.history_dropout <= .9:
        raise ValueError('Invalid bounded training settings')
    if not 0 <= args.checkpoint_every <= args.epochs:
        raise ValueError('Invalid snapshot interval')
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
    for root in args.expert_data:
        train.extend(episodes(Path(root) / 'train', schema, 'train'))
        validation.extend(episodes(Path(root) / 'validation', schema, 'validation'))
    for root in args.corrections:
        train.extend(episodes(Path(root) / 'train', schema, 'train', corrective=True, strict_contacts=args.strict_contact_prefixes))
        validation.extend(episodes(Path(root) / 'validation', schema, 'validation', corrective=True, optional=True, strict_contacts=args.strict_contact_prefixes))
    assert_disjoint(train, validation)
    identities = ['schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest']
    version = train[0]['manifest']['versions']
    for key in identities:
        if len({e['manifest']['versions'][key] for e in train + validation}) != 1:
            raise ValueError(f'Mixed {key}; rerecord compatible episodes')
    config = {'reactive': args.reactive, 'contextSkip': args.context_skip, 'instant': args.instant, 'motorHistoryMask': args.motor_history_mask, 'splitMotor': args.split_motor, 'trafficResidual': args.traffic_residual, 'trafficMemory': args.traffic_memory, 'motorTune': args.motor_tune}
    if args.split_motor and not args.resume:
        raise ValueError('Pedal isolation must preserve an existing learned steering policy')
    model = PulsePolicy(schema, **config).to('cuda')
    parent = None
    if args.resume:
        parent = json.loads((Path(args.resume) / 'metadata.json').read_text())
        required_identities = ['simulatorDigest', 'teacherDigest'] if args.transfer_schema else identities
        if any(parent[key] != version[key] for key in required_identities):
            raise ValueError('Resume checkpoint is incompatible with the dataset')
        checkpoint = torch.load(Path(args.resume) / 'model.pt', map_location='cuda', weights_only=True)
        if checkpoint['schema'] != schema and not args.transfer_schema:
            raise ValueError('Resume schema mismatch')
        weights = transfer_observations(checkpoint['weights'], checkpoint['schema'], schema) if args.transfer_schema else checkpoint['weights']
        model.load_parent(weights)
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=args.lr, weight_decay=1e-4)
    # Architecture initialization consumes a different number of random draws.
    # Reset stochastic training here so paired resumed models see identical
    # dropout masks; NumPy also uses the same seeded batch permutation below.
    torch.manual_seed(args.seed)
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
        if args.checkpoint_every and (epoch + 1) % args.checkpoint_every == 0:
            snapshots = out / 'checkpoints'
            snapshots.mkdir(exist_ok=True)
            torch.save({'weights': model.state_dict(), 'schema': schema, 'modelConfig': config, 'epoch': epoch + 1}, snapshots / f'epoch-{epoch + 1}.pt')
        if row['validationLoss'] < best:
            best = row['validationLoss']
            torch.save({'weights': model.state_dict(), 'schema': schema, 'modelConfig': config}, out / 'model.pt')
        print(json.dumps(row), flush=True)
        (out / 'training.json').write_text(json.dumps({'history': history, 'seconds': time.perf_counter() - started}, indent=2))
    checkpoint = torch.load(out / 'model.pt', map_location='cpu', weights_only=True)
    model = PulsePolicy(schema, **config).cpu().eval(); model.load_state_dict(checkpoint['weights'])
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
    architecture = 'PULSE-CURRENT-128' + ('-SPLIT-MOTOR' if args.split_motor else '') if args.instant else 'PULSE-GRU-128' + ('-REACTIVE' if args.reactive else '') + ('-CONTEXT-SKIP' if args.context_skip else '')
    if args.traffic_residual:
        architecture += '-TRAFFIC-RESIDUAL'
    if args.traffic_memory:
        architecture += '-MEMORY-64'
    if args.motor_tune:
        architecture += '-MOTOR-REFIT'
    metadata = {**version, 'schema': schema, 'architecture': architecture,
                'modelConfig': config, 'parameters': sum(p.numel() for p in model.parameters()),
                'trainableParameters': sum(p.numel() for p in model.parameters() if p.requires_grad),
                'trainingRandomnessResetAfterInitialization': True,
                'actuationUsesRecurrentMemory': not args.instant or args.traffic_memory,
                'activeMemoryUnits': 64 if args.traffic_memory else (0 if args.instant else schema['hidden']),
                'stage': 'M2 corrective imitation prototype; independent racing unproven' if args.corrections else 'M1 prototype behavior clone; competitive driving unproven', 'training': vars(args),
                'parentModelSha256': parent['modelSha256'] if parent else None,
                'trainerDigest': hashlib.sha256(b''.join((Path(__file__).parent / file).read_bytes() for file in ['train.py', 'model.py', 'data.py'])).hexdigest(),
                'dependencyDigest': hashlib.sha256(b''.join(Path(file).read_bytes() for file in ['uv.lock', 'package-lock.json'])).hexdigest(),
                'bestValidationLoss': best, 'trainEpisodes': [e['path'] for e in train], 'validationEpisodes': [e['path'] for e in validation],
                'checkpointSelection': 'minimum held-out imitation loss; autonomous driving must be tested separately',
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
