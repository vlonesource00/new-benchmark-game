"""Atomic, self-contained epoch saves for the outcome trainer."""
import json
import os
import tempfile
from pathlib import Path
import torch


def atomic_write(path, writer):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as output:
            writer(output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path, value):
    # Serialize before touching an existing save.
    contents = (json.dumps(value, indent=2, allow_nan=False) + '\n').encode('utf-8')
    atomic_write(path, lambda output: output.write(contents))


def atomic_checkpoint(path, value):
    atomic_write(path, lambda output: torch.save(value, output))


def capture_state(model, optimizer, rng, contract, epoch, best_checkpoint, history, seconds):
    return {'format': 'pulse-outcome-resume-v1', 'contract': contract, 'epoch': epoch,
            'weights': model.state_dict(), 'optimizer': optimizer.state_dict(),
            'torchRng': torch.get_rng_state(),
            'cudaRng': torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
            'numpyRng': rng.bit_generator.state, 'bestCheckpoint': best_checkpoint,
            'history': history, 'seconds': seconds}


def restore_state(path, model, optimizer, rng, contract):
    state = torch.load(path, map_location='cpu', weights_only=True)
    if state.get('format') != 'pulse-outcome-resume-v1' or state.get('contract') != contract:
        raise ValueError('Resume source, parent, data or arguments changed; use a new experiment')
    history = state['history']
    if not history or [row['epoch'] for row in history] != list(range(1, state['epoch'] + 1)):
        raise ValueError('Incomplete resume history')
    best_epoch = min(history, key=lambda row: row['validationLoss'])['epoch']
    if state['bestCheckpoint']['epoch'] != best_epoch:
        raise ValueError('Resume best weights do not match the saved selection')
    for weights in [state['weights'], state['bestCheckpoint']['weights']]:
        if any(not torch.isfinite(value).all() for value in weights.values()):
            raise ValueError('Nonfinite resume weights')
    model.load_state_dict(state['weights'], strict=True)
    optimizer.load_state_dict(state['optimizer'])
    torch.set_rng_state(state['torchRng'])
    if state['cudaRng']:
        if not torch.cuda.is_available() or len(state['cudaRng']) != torch.cuda.device_count():
            raise ValueError('Exact resume needs the original CUDA device count')
        torch.cuda.set_rng_state_all(state['cudaRng'])
    rng.bit_generator.state = state['numpyRng']
    return state
