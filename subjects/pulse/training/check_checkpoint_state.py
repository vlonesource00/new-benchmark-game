"""Prove optimizer/RNG continuation and atomic failure handling."""
import copy
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
import torch
from checkpoint_state import atomic_checkpoint, atomic_json, capture_state, restore_state


def run():
    torch.set_num_threads(4)
    results = []
    for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
        torch.manual_seed(98)
        rng = np.random.default_rng(98)
        model = torch.nn.Linear(3, 2).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=.001)

        def step():
            x = torch.randn(5, 3, device=device) * float(rng.uniform(.5, 1.5))
            optimizer.zero_grad(set_to_none=True)
            loss = model(x).square().mean()
            loss.backward(); optimizer.step()
            return float(loss.detach())

        step()
        best = {'weights': copy.deepcopy(model.state_dict()), 'epoch': 1}
        history = [{'epoch': 1, 'validationLoss': .1}]
        contract = {'source': 'test', 'data': 'test', 'arguments': {'seed': 98}}
        with tempfile.TemporaryDirectory() as directory:
            saved = Path(directory) / 'resume.pt'
            atomic_checkpoint(saved, capture_state(model, optimizer, rng, contract, 1, best, history, 1.0))
            expected = step(); expected_weights = copy.deepcopy(model.state_dict())
            torch.manual_seed(55); rng = np.random.default_rng(55)
            model = torch.nn.Linear(3, 2).to(device)
            optimizer = torch.optim.AdamW(model.parameters(), lr=.001)
            restored = restore_state(saved, model, optimizer, rng, contract)
            actual = step()
            assert expected == actual and all(torch.equal(value, model.state_dict()[name]) for name, value in expected_weights.items())
            assert restored['epoch'] == 1 and restored['bestCheckpoint']['epoch'] == 1
            try:
                restore_state(saved, model, optimizer, rng, {**contract, 'source': 'changed'})
                raise AssertionError('Changed source accepted')
            except ValueError:
                pass
            original = saved.read_bytes()
            with patch('checkpoint_state.torch.save', side_effect=RuntimeError('Interrupted write')):
                try:
                    atomic_checkpoint(saved, {})
                except RuntimeError:
                    pass
            assert saved.read_bytes() == original and not list(Path(directory).glob('*.tmp'))
            report = Path(directory) / 'progress.json'
            atomic_json(report, {'epoch': 1})
            try:
                atomic_json(report, {'loss': float('nan')})
                raise AssertionError('Nonfinite progress accepted')
            except ValueError:
                pass
            assert json.loads(report.read_text()) == {'epoch': 1}
        results.append({'device': device, 'exactNextStep': True, 'optimizerAndRngRestored': True,
                        'changedContractRejected': True, 'interruptedWritePreserved': True})
    print(json.dumps({'passed': len(results), 'checks': results}))


if __name__ == '__main__':
    run()
