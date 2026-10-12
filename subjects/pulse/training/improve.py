"""Outcome-selected distillation, not an unrestricted RL performance claim."""
import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path
import numpy as np
import torch
import onnx
from model import PulsePolicy
from data import assert_disjoint, episodes, windows
from outcome_data import outcome_episodes, assert_outcome_disjoint
from train import batch, rollout_loss
from checkpoint_state import atomic_checkpoint, atomic_json, capture_state, restore_state


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--data', required=True)
    p.add_argument('--resume', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--epochs', type=int, default=25)
    p.add_argument('--length', type=int, default=128)
    p.add_argument('--burn', type=int, default=16)
    p.add_argument('--batch', type=int, default=32)
    p.add_argument('--lr', type=float, default=2e-5)
    p.add_argument('--seed', type=int, default=19)
    p.add_argument('--anchor-data', help='Student-state prefixes; only the parent NN outputs are used as targets')
    p.add_argument('--anchor-weight', type=float, default=.1)
    p.add_argument('--checkpoint-every', type=int, default=5)
    p.add_argument('--whole-episode', action='store_true', help='Use the complete recorded recurrent history; batch 1 and burn 0')
    p.add_argument('--continue-run', action='store_true', help='Continue this output from its atomic optimizer/RNG checkpoint')
    p.add_argument('--packed-memory', action='store_true', help='Batch reset-separated traffic intervals during training only')
    p.add_argument('--traffic-gate', action='store_true', help='Fit a small public-state gain head while preserving the parent NN')
    p.add_argument('--traffic-gate-mode', choices=['raw', 'clipped'], help='Explicit gain contract; new calibrators default to post-clip actuator deltas')
    args = p.parse_args()
    if not (1 <= args.epochs <= 100 and 64 <= args.length <= 512 and 0 <= args.burn < args.length
            and 1 <= args.batch <= 128 and 0 < args.lr <= (.003 if args.traffic_gate else .0005) and 0 <= args.anchor_weight <= 1
            and 1 <= args.checkpoint_every <= args.epochs):
        raise ValueError('Invalid bounded improvement settings')
    if args.whole_episode and (args.batch != 1 or args.burn != 0):
        raise ValueError('Whole-episode fitting needs batch 1 and burn 0')
    if args.traffic_gate_mode and not args.traffic_gate:
        raise ValueError('Gain contract requires --traffic-gate')
    out, root = Path(args.out), Path(args.resume)
    if out.exists() and not args.continue_run:
        raise ValueError('Preserve completed experiments; choose a new output')
    if args.continue_run and (not (out / 'resume.pt').exists() or (out / 'metadata.json').exists()):
        raise ValueError('Continue requires an unfinished run with a full resume checkpoint')
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA training required')
    torch.set_num_threads(4); torch.manual_seed(args.seed)
    parent = json.loads((root / 'metadata.json').read_text())
    checkpoint = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    schema, config = checkpoint['schema'], {**checkpoint['modelConfig'], 'motorTune': False}
    if args.traffic_gate:
        config['trafficGate'] = True
        mode = args.traffic_gate_mode or (checkpoint['modelConfig'].get('trafficGateMode', 'raw')
                                         if checkpoint['modelConfig'].get('trafficGate') else 'clipped')
        if checkpoint['modelConfig'].get('trafficGate') and mode != checkpoint['modelConfig'].get('trafficGateMode', 'raw'):
            raise ValueError('Do not reinterpret an existing calibrated checkpoint; start from its ungated parent')
        config['trafficGateMode'] = mode
    if not all(config[k] for k in ['instant', 'splitMotor', 'trafficResidual', 'trafficMemory']):
        raise ValueError('Improvement requires the preserved motor and traffic memory')
    train = outcome_episodes(Path(args.data) / 'train', schema, 'train')
    validation = outcome_episodes(Path(args.data) / 'validation', schema, 'validation')
    assert_outcome_disjoint(train, validation)
    identities = ['schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest']
    if any(e['manifest']['versions'][k] != parent[k] for e in train + validation for k in identities):
        raise ValueError('Outcome source does not match this physical/input contract')
    anchors = episodes(Path(args.anchor_data) / 'train', schema, 'train', corrective=True) if args.anchor_data else []
    if anchors:
        assert_disjoint(anchors, validation)
        if any(e['manifest']['versions'][k] != parent[k] for e in anchors for k in identities):
            raise ValueError('Parent-anchor source is incompatible')
    model = PulsePolicy(schema, **config).to('cuda'); model.load_parent(checkpoint['weights'])
    reference = PulsePolicy(schema, **config).to('cuda').eval(); reference.load_parent(checkpoint['weights'])
    model.packed_traffic_training = reference.packed_traffic_training = args.packed_memory
    for parameter in reference.parameters():
        parameter.requires_grad_(False)
    frozen = {k: v.detach().cpu().clone() for k, v in model.named_parameters() if not v.requires_grad}
    if args.whole_episode:
        if any(not e['fresh'] or not 64 <= len(e['x']) <= 8192 for e in train + validation + anchors):
            raise ValueError('Whole histories require explicit episode resets and at most 8192 steps')
        train_windows = [(i, 0) for i, e in enumerate(train) for _ in range(e['weight'])]
        valid_windows = [(i, 0) for i in range(len(validation))]
        anchor_windows = [(i, 0) for i in range(len(anchors))]
    else:
        train_windows = [(i, start) for i, e in enumerate(train) for _ in range(e['weight'])
                         for start in range(0, len(e['x']) - args.length + 1, args.length // 2)]
        valid_windows = windows(validation, args.length, args.length)
        anchor_windows = windows(anchors, args.length, args.length) if anchors else []
    if not train_windows or not valid_windows:
        raise ValueError('Insufficient complete winner windows')
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=args.lr, weight_decay=1e-4)
    rng = np.random.default_rng(args.seed)
    sources = ['improve.py', 'outcome_data.py', 'model.py', 'train.py', 'data.py', 'checkpoint_state.py', 'segmented_gru.py']
    source_hash = lambda: hashlib.sha256(b''.join((Path(__file__).parent / f).read_bytes() for f in sources)).hexdigest()
    started_hash = source_hash()
    contract = {'arguments': {k: v for k, v in vars(args).items() if k != 'continue_run'},
                'trainerDigest': started_hash,
                'parentCheckpointSha256': hashlib.sha256((root / 'model.pt').read_bytes()).hexdigest(),
                'outcomes': [{'file': e['path'], 'sha256': e['fileDigest']} for e in train + validation],
                'anchors': [{'file': e['path'], 'fingerprint': e['fingerprint']} for e in anchors]}
    source_archive = out / 'trainer-source'
    first_epoch, elapsed, best, history, best_checkpoint = 1, 0.0, float('inf'), [], None
    if args.continue_run:
        archived_hash = hashlib.sha256(b''.join((source_archive / f).read_bytes() for f in sources)).hexdigest()
        if archived_hash != started_hash:
            raise ValueError('Archived training source changed; preserve this experiment')
        saved = restore_state(out / 'resume.pt', model, optimizer, rng, contract)
        first_epoch, elapsed = saved['epoch'] + 1, saved['seconds']
        history, best_checkpoint = saved['history'], saved['bestCheckpoint']
        best = min(row['validationLoss'] for row in history)
        if any(not torch.equal(dict(model.named_parameters())[k].detach().cpu(), v) for k, v in frozen.items()):
            raise ValueError('Resume changed the preserved motor')
        atomic_checkpoint(out / 'model.pt', best_checkpoint)
        print(json.dumps({'resumedAfterEpoch': saved['epoch'], 'optimizerAndRngRestored': True}), flush=True)
    else:
        out.mkdir(parents=True, exist_ok=False); source_archive.mkdir()
        for filename in sources:
            shutil.copy2(Path(__file__).parent / filename, source_archive / filename)
        atomic_json(out / 'run.json', {'contract': contract, 'status': 'running', 'plannedEpochs': args.epochs})
    started = time.perf_counter()
    for epoch in range(first_epoch, args.epochs + 1):
        model.train(); losses, anchor_losses = [], []
        permutation = rng.permutation(len(train_windows))
        for start in range(0, len(permutation), args.batch):
            indices = [train_windows[i] for i in permutation[start:start + args.batch]]
            length = len(train[indices[0][0]]['x']) if args.whole_episode else args.length
            x, y = batch(train, indices, length, 'cuda')
            fresh = torch.tensor([s == 0 and train[i]['fresh'] for i, s in indices], device='cuda', dtype=torch.float32)
            loss = rollout_loss(model, x, y, args.burn, fresh, 10)
            if anchor_windows and args.anchor_weight:
                selected = [anchor_windows[i] for i in rng.integers(len(anchor_windows), size=len(indices))]
                anchor_length = len(anchors[selected[0][0]]['x']) if args.whole_episode else args.length
                ax, _ignored_expert_labels = batch(anchors, selected, anchor_length, 'cuda')
                af = torch.tensor([s == 0 and anchors[i]['fresh'] for i, s in selected], device='cuda', dtype=torch.float32)
                with torch.no_grad():
                    parent_actions = reference.traffic_sequence(ax, args.burn, af)
                anchor_loss = rollout_loss(model, ax, parent_actions, args.burn, af, 10)
                loss = loss + args.anchor_weight * anchor_loss; anchor_losses.append(float(anchor_loss.detach()))
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite outcome loss')
            optimizer.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1); optimizer.step(); losses.append(float(loss.detach()))
        model.eval(); values = []
        with torch.inference_mode():
            for start in range(0, len(valid_windows), args.batch):
                indices = valid_windows[start:start + args.batch]
                length = len(validation[indices[0][0]]['x']) if args.whole_episode else args.length
                x, y = batch(validation, indices, length, 'cuda')
                fresh = torch.tensor([s == 0 and validation[i]['fresh'] for i, s in indices], device='cuda', dtype=torch.float32)
                values.append(float(rollout_loss(model, x, y, args.burn, fresh, 10)))
        row = {'epoch': epoch, 'trainLoss': float(np.mean(losses)), 'validationLoss': float(np.mean(values)),
               'parentAnchorLoss': float(np.mean(anchor_losses)) if anchor_losses else None}
        history.append(row)
        if row['validationLoss'] < best:
            best = row['validationLoss']
            best_checkpoint = {'weights': {k: v.detach().cpu().clone() for k, v in model.state_dict().items()},
                               'schema': schema, 'modelConfig': config, 'epoch': epoch}
            atomic_checkpoint(out / 'model.pt', best_checkpoint)
        if epoch % args.checkpoint_every == 0:
            folder = out / 'checkpoints'; folder.mkdir(exist_ok=True)
            atomic_checkpoint(folder / ('epoch-' + str(epoch) + '.pt'),
                              {'weights': model.state_dict(), 'schema': schema, 'modelConfig': config, 'epoch': epoch})
        seconds = elapsed + time.perf_counter() - started
        atomic_checkpoint(out / 'resume.pt', capture_state(model, optimizer, rng, contract, epoch, best_checkpoint, history, seconds))
        print(json.dumps(row), flush=True)
        atomic_json(out / 'training.json', {'history': history, 'seconds': seconds})
    if source_hash() != started_hash:
        raise RuntimeError('Training source changed mid-run')
    if any(not torch.equal(dict(model.named_parameters())[k].detach().cpu(), v) for k, v in frozen.items()):
        raise RuntimeError('Outcome training changed the preserved motor')
    best_checkpoint = torch.load(out / 'model.pt', map_location='cpu', weights_only=True)
    model = PulsePolicy(schema, **config).cpu().eval(); model.load_state_dict(best_checkpoint['weights'])
    for n in [1, 16]:
        torch.onnx.export(model, (torch.zeros(n, schema['size']), torch.zeros(n, schema['hidden'])), out / ('policy-' + str(n) + '.onnx'),
                          dynamo=False, opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        graph = onnx.load(out / ('policy-' + str(n) + '.onnx')); graph.ir_version = 10
        onnx.checker.check_model(graph); onnx.save(graph, out / ('policy-' + str(n) + '.onnx'))
    parity, hidden = [], torch.zeros(1, schema['hidden'])
    with torch.inference_mode():
        for x in train[0]['x'][:32]:
            a, hidden = model(torch.from_numpy(x[None]), hidden)
            parity.append({'observation': x.tolist(), 'action': a[0].tolist(), 'hidden': hidden[0].tolist()})
    (out / 'parity.json').write_text(json.dumps(parity))
    metadata = {**parent, 'modelConfig': config, 'training': vars(args), 'stage': 'M3 outcome-selected distillation; superiority unproven',
                'checkpointSelection': 'minimum held-out selected-action error; independent physical gates required',
                'parentModelSha256': parent['modelSha256'], 'trainerDigest': started_hash,
                'parentTrainerDigest': parent['trainerDigest'], 'parentStage': parent['stage'],
                'recurrentTraining': ('complete accepted request chain from recorded reset' if any(e['manifest']['settings'].get('transport') == 'seat-frame' for e in train + validation)
                                      else 'complete episode from recorded reset') if args.whole_episode else 'reset windows with burn-in',
                'trainerSourceDirectory': 'trainer-source',
                'parameters': sum(p.numel() for p in model.parameters()),
                'trainableParameters': sum(p.numel() for p in model.parameters() if p.requires_grad),
                'trafficGainCalibration': bool(config.get('trafficGate')),
                'architecture': parent['architecture'] + ('-GAIN-16' if config.get('trafficGate') and not parent.get('trafficGainCalibration') else ''),
                'bestValidationLoss': best, 'emptyTrafficMotorPreservedBitwise': True,
                'trainEpisodes': [e['path'] for e in train], 'validationEpisodes': [e['path'] for e in validation],
                'outcomeDatasets': [{'file': e['path'], 'split': e['manifest']['split'], 'familyId': e['manifest']['episodeId'],
                                     'sha256': e['fileDigest'], 'weight': e['weight'], 'outcome': e['manifest']['outcome'],
                                     'requestHistory': e['manifest'].get('requestHistory', 'native-accepted-sequence'),
                                     'recordedFrames': e['recordedFrames'], 'acceptedSteps': e['acceptedSteps']} for e in train + validation],
                'outcomeTargets': 'admitted sampled-policy proposals; no expert command targets',
                'parentAnchorData': args.anchor_data, 'parentAnchorTargets': 'frozen parent NN predictions, never teacherControls',
                'modelSha256': {str(n): hashlib.sha256((out / ('policy-' + str(n) + '.onnx')).read_bytes()).hexdigest() for n in [1, 16]},
                'seconds': elapsed + time.perf_counter() - started,
                'completedEpochs': args.epochs, 'trainingStatus': 'complete',
                'checkpointEpoch': best_checkpoint['epoch'], 'atomicResumeState': 'resume.pt'}
    # Parent imitation datasets are lineage, not the inputs of this new trainer.
    metadata['parentImitationDatasets'] = metadata.pop('datasets', metadata.get('parentImitationDatasets', []))
    inherited = ['imitationLossAtCheckpoint', 'checkpointDirectory', 'snapshotSha256', 'snapshotExporterDigest']
    metadata['parentCheckpointMetadata'] = {k: metadata.pop(k) for k in inherited if k in metadata}
    atomic_json(out / 'metadata.json', metadata)
    atomic_json(out / 'run.json', {'contract': contract, 'status': 'complete', 'completedEpochs': args.epochs})
    print(json.dumps({'complete': True, 'seconds': metadata['seconds'], 'preservedMotor': True}))


if __name__ == '__main__':
    main()
