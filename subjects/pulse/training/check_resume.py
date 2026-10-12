"""Interrupt the actual CUDA trainer after an epoch save and compare its resume."""
import argparse
import json
import sys
from pathlib import Path
from unittest.mock import patch
import torch
import improve


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--data', default='data/outcome-08')
    parser.add_argument('--parent', default='artifacts/models/c75-arrival-and-continuation/epoch-100')
    args = parser.parse_args()
    out = Path(args.out)
    if out.exists():
        raise ValueError('Preserve previous checks; use a new output')
    out.mkdir(parents=True)
    common = ['--data', args.data, '--resume', args.parent, '--epochs', '2', '--checkpoint-every', '1',
              '--batch', '1', '--burn', '0', '--whole-episode', '--lr', '.0002', '--seed', '100', '--packed-memory']

    def train(folder, continuing=False):
        with patch.object(sys, 'argv', ['improve.py', *common, '--out', str(folder), *(['--continue-run'] if continuing else [])]):
            improve.main()

    partial, control = out / 'interrupted', out / 'continuous'
    original = improve.atomic_checkpoint

    def interrupted_write(path, value):
        original(path, value)
        if Path(path).name == 'resume.pt':
            raise RuntimeError('Simulated shutdown after durable epoch save, before progress JSON')

    try:
        with patch.object(improve, 'atomic_checkpoint', interrupted_write):
            train(partial)
        raise AssertionError('Interruption was not injected')
    except RuntimeError as error:
        if 'Simulated shutdown' not in str(error):
            raise
    assert (partial / 'resume.pt').is_file() and not (partial / 'metadata.json').exists()
    assert not (partial / 'training.json').exists(), 'Test did not hit the progress-write gap'
    train(partial, continuing=True)
    train(control)
    resumed = torch.load(partial / 'resume.pt', map_location='cpu', weights_only=True)
    uninterrupted = torch.load(control / 'resume.pt', map_location='cpu', weights_only=True)
    assert resumed['epoch'] == uninterrupted['epoch'] == 2
    assert resumed['history'] == uninterrupted['history'], 'Resumed training losses differ'
    assert all(torch.equal(value, uninterrupted['weights'][name]) for name, value in resumed['weights'].items()), 'Final weights differ'
    assert all(torch.equal(value, uninterrupted['bestCheckpoint']['weights'][name]) for name, value in resumed['bestCheckpoint']['weights'].items()), 'Best weights differ'
    assert torch.equal(resumed['torchRng'], uninterrupted['torchRng'])
    assert resumed['numpyRng'] == uninterrupted['numpyRng']
    assert all(torch.equal(a, b) for a, b in zip(resumed['cudaRng'], uninterrupted['cudaRng']))
    metadata = json.loads((partial / 'metadata.json').read_text())
    assert metadata['trainingStatus'] == 'complete' and metadata['emptyTrafficMotorPreservedBitwise']
    report = {'passed': True, 'realCudaTrainer': True, 'interruptionAfterEpoch': 1, 'finishedEpoch': 2,
              'progressJsonWasMissing': True, 'lossHistoryBitwiseEqual': True, 'weightsBitwiseEqual': True,
              'bestWeightsBitwiseEqual': True, 'rngBitwiseEqual': True, 'preservedMotor': True}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
