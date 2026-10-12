"""Export verified best weights without marking an interrupted run complete."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
import onnx
import torch
from model import PulsePolicy
from train import batch, rollout_loss
from outcome_data import outcome_episodes, assert_outcome_disjoint
from checkpoint_state import atomic_checkpoint, atomic_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', required=True)
    parser.add_argument('--parent', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--planned-epochs', type=int, required=True)
    args = parser.parse_args()
    run, root, out = Path(args.run), Path(args.parent), Path(args.out)
    if out.exists() or (run / 'metadata.json').exists():
        raise ValueError('Use an unfinished source and a new recovery output')
    progress = json.loads((run / 'training.json').read_text())
    history = progress['history']
    if not history or [r['epoch'] for r in history] != list(range(1, len(history) + 1)) or len(history) >= args.planned_epochs:
        raise ValueError('Not a valid interrupted epoch history')
    best = min(history, key=lambda row: row['validationLoss'])
    saved = torch.load(run / 'model.pt', map_location='cpu', weights_only=True)
    parent_weights = torch.load(root / 'model.pt', map_location='cpu', weights_only=True)
    parent = json.loads((root / 'metadata.json').read_text())
    schema, config = saved['schema'], saved['modelConfig']
    if schema != parent['schema'] or config != parent['modelConfig']:
        raise ValueError('Recovery needs the unchanged parent architecture')
    torch.set_num_threads(4)
    model = PulsePolicy(schema, **config).to('cuda').eval()
    model.load_state_dict(saved['weights'], strict=True)
    if any(not torch.isfinite(v).all() for v in saved['weights'].values()):
        raise ValueError('Invalid saved weights')
    frozen = [name for name, parameter in model.named_parameters() if not parameter.requires_grad]
    if any(not torch.equal(saved['weights'][name], parent_weights['weights'][name]) for name in frozen):
        raise ValueError('Recovery changed the preserved motor')
    train = outcome_episodes(Path(args.data) / 'train', schema, 'train')
    validation = outcome_episodes(Path(args.data) / 'validation', schema, 'validation')
    assert_outcome_disjoint(train, validation)
    for episode in train + validation:
        if any(episode['manifest']['versions'][key] != parent[key] for key in
               ['schemaDigest', 'observationDigest', 'simulatorDigest', 'teacherDigest']):
            raise ValueError('Recovered data does not match the parent contract')
    values = []
    with torch.inference_mode():
        for index, episode in enumerate(validation):
            x, y = batch(validation, [(index, 0)], len(episode['x']), 'cuda')
            values.append(float(rollout_loss(model, x, y, 0, torch.ones(1, device='cuda'), 10)))
    measured = sum(values) / len(values)
    if abs(measured - best['validationLoss']) > 1e-7:
        raise ValueError(f'Saved weights do not reproduce the recorded best loss: {measured} vs {best}')
    sources = ['improve.py', 'outcome_data.py', 'model.py', 'train.py', 'data.py']
    trainer_digest = hashlib.sha256(b''.join((run / 'trainer-source' / f).read_bytes() for f in sources)).hexdigest()
    out.mkdir(parents=True, exist_ok=False)
    shutil.copytree(run / 'trainer-source', out / 'trainer-source')
    model = model.cpu().eval()
    atomic_checkpoint(out / 'model.pt', {**saved, 'epoch': best['epoch'], 'recoveredFromInterruptedRun': True})
    for n in [1, 16]:
        target = out / f'policy-{n}.onnx'
        torch.onnx.export(model, (torch.zeros(n, schema['size']), torch.zeros(n, schema['hidden'])), target,
                          dynamo=False, opset_version=17, input_names=['observation', 'hidden'], output_names=['action', 'nextHidden'])
        graph = onnx.load(target); graph.ir_version = 10
        onnx.checker.check_model(graph); onnx.save(graph, target)
    parity, hidden = [], torch.zeros(1, schema['hidden'])
    with torch.inference_mode():
        for x in train[0]['x'][:32]:
            action, hidden = model(torch.from_numpy(x[None]), hidden)
            parity.append({'observation': x.tolist(), 'action': action[0].tolist(), 'hidden': hidden[0].tolist()})
    atomic_json(out / 'parity.json', parity)
    metadata = {**parent, 'stage': 'M3 recovered interrupted outcome fit; physical superiority unproven',
                'trainingStatus': 'interrupted-recovered', 'completedEpochs': len(history), 'plannedEpochs': args.planned_epochs,
                'checkpointEpoch': best['epoch'], 'bestValidationLoss': measured,
                'checkpointSelection': 'recorded minimum validation loss, independently reproduced; interrupted run',
                'training': None, 'recovery': vars(args), 'exactOptimizerResumeAvailable': False,
                'recoveredCheckpointSha256': hashlib.sha256((run / 'model.pt').read_bytes()).hexdigest(),
                'recoveryExporterDigest': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'trainerDigest': trainer_digest, 'trainerSourceDirectory': 'trainer-source',
                'parentTrainerDigest': parent['trainerDigest'], 'parentModelSha256': parent['modelSha256'],
                'parentStage': parent['stage'], 'modelConfig': config, 'emptyTrafficMotorPreservedBitwise': True,
                'parameters': sum(p.numel() for p in model.parameters()),
                'trainableParameters': sum(p.numel() for p in model.parameters() if p.requires_grad),
                'trainEpisodes': [e['path'] for e in train], 'validationEpisodes': [e['path'] for e in validation],
                'outcomeDatasets': [{'file': e['path'], 'split': e['manifest']['split'], 'familyId': e['manifest']['episodeId'],
                                     'sha256': e['fileDigest'], 'weight': e['weight'], 'outcome': e['manifest']['outcome']} for e in train + validation],
                'outcomeTargets': 'admitted sampled-policy proposals; no expert command targets',
                'recurrentTraining': 'complete episode from recorded reset',
                'modelSha256': {str(n): hashlib.sha256((out / f'policy-{n}.onnx').read_bytes()).hexdigest() for n in [1, 16]}}
    metadata['parentImitationDatasets'] = metadata.pop('datasets', metadata.get('parentImitationDatasets', []))
    atomic_json(out / 'training.json', progress)
    atomic_json(out / 'metadata.json', metadata)
    print(json.dumps({'recovered': str(out), 'completedEpochs': len(history), 'plannedEpochs': args.planned_epochs,
                      'savedBestEpoch': best['epoch'], 'reproducedValidationLoss': measured, 'preservedMotor': True,
                      'exactOptimizerResumeAvailable': False}))


if __name__ == '__main__':
    main()
