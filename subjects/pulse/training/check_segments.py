"""Compare a packed reset-aware GRU against the exported cell equations."""
import argparse
import copy
import json
import time
from pathlib import Path
import torch
from segmented_gru import segmented_memory
from model import PulsePolicy


def cell_sequence(gru, encoded, present):
    h = encoded.new_zeros(encoded.shape[0], gru.hidden_size)
    rows = []
    for t in range(encoded.shape[1]):
        ir, iz, inn = torch.nn.functional.linear(encoded[:, t], gru.weight_ih_l0, gru.bias_ih_l0).chunk(3, 1)
        hr, hz, hn = torch.nn.functional.linear(h, gru.weight_hh_l0, gru.bias_hh_l0).chunk(3, 1)
        reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
        h = ((1 - update) * torch.tanh(inn + reset * hn) + update * h) * present[:, t]
        rows.append(h)
    return torch.stack(rows, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--length', type=int, default=512)
    args = parser.parse_args()
    if not 64 <= args.length <= 4096:
        raise ValueError('Bounded benchmark length required')
    torch.set_num_threads(4)
    torch.manual_seed(97)
    report = {'checks': [], 'actorChecks': [], 'timings': [], 'scope': 'Training algorithm parity/performance; no driver behavior claim.'}
    for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
        for case in ['uninterrupted', 'empty', 'reset-gap', 'alternating', 'unequal-intervals']:
            length = 32
            mask = torch.ones(2, length, 1, device=device)
            if case == 'empty': mask.zero_()
            if case == 'reset-gap': mask[:, 8:13] = 0
            if case == 'alternating': mask[:, ::2] = 0
            if case == 'unequal-intervals': mask[0, 3:17] = 0; mask[1, 20:] = 0
            first = torch.nn.GRU(128, 64, batch_first=True).to(device)
            second = copy.deepcopy(first)
            first.flatten_parameters(); second.flatten_parameters()
            x1 = torch.randn(2, length, 128, device=device, requires_grad=True)
            x2 = x1.detach().clone().requires_grad_()
            expected = cell_sequence(first, x1, mask)
            actual = segmented_memory(second, x2, mask)
            error = float((actual - expected).abs().max().detach())
            assert error < 2e-6, (device, case, error)
            grad_error = 0
            if case != 'empty':
                probe = torch.randn_like(expected)
                (expected * probe).sum().backward(); (actual * probe).sum().backward()
                gradients = [float((x1.grad - x2.grad).abs().max())]
                gradients += [float((p.grad - q.grad).abs().max()) for p, q in zip(first.parameters(), second.parameters())]
                grad_error = max(gradients)
                assert grad_error < 3e-5, (device, case, grad_error)
            assert not actual[mask.squeeze(-1) == 0].count_nonzero(), 'An empty observation retained memory'
            report['checks'].append({'device': device, 'case': case, 'actionMemoryError': error, 'gradientError': grad_error})
        schema = json.loads(Path('artifacts/schema-v2.json').read_text())
        for case, burn in [('reset-gap', 0), ('alternating', 0), ('burn-in-fallback', 4)]:
            first = PulsePolicy(schema, instant=True, motorHistoryMask=True, splitMotor=True,
                                trafficResidual=True, trafficMemory=True).to(device)
            with torch.no_grad():
                first.traffic[2].weight.normal_(0, .07)
            second = copy.deepcopy(first)
            second.packed_traffic_training = True
            x = torch.randn(2, 32, schema['size'], device=device)
            group = schema['groups']['rivals']
            cars = x[:, :, group['offset']:].reshape(2, 32, group['count'], group['width'])
            cars[:, :, :, 0] = 0; cars[:, :, :2, 0] = 1
            if case == 'alternating': cars[:, ::2, :, 0] = 0
            else: cars[:, 8:13, :, 0] = 0
            fresh = torch.tensor([1, 0], device=device)
            rng_before = torch.get_rng_state().clone()
            expected = first.traffic_sequence(x, burn, fresh)
            actual = second.traffic_sequence(x, burn, fresh)
            assert torch.equal(rng_before, torch.get_rng_state()), 'Scratch GRU creation changed the resume RNG'
            action_error = float((actual - expected).abs().max().detach())
            assert action_error < 2e-6, (device, case, action_error)
            expected.square().mean().backward(); actual.square().mean().backward()
            gradient_errors = []
            for (name, p), (other, q) in zip(first.named_parameters(), second.named_parameters()):
                assert name == other and (p.grad is None) == (q.grad is None)
                if p.grad is not None: gradient_errors.append(float((p.grad - q.grad).abs().max()))
            grad_error = max(gradient_errors)
            assert grad_error < 3e-5, (device, case, grad_error)
            assert first.state_dict().keys() == second.state_dict().keys(), 'Training helper changed exported topology'
            h = torch.randn(2, schema['hidden'], device=device)
            for old, new in zip(first(x[:, 0], h), second(x[:, 0], h)):
                assert torch.equal(old, new), 'Training flag changed stepwise inference'
            report['actorChecks'].append({'device': device, 'case': case, 'actionError': action_error,
                                          'gradientError': grad_error, 'inferenceBitwiseUnchanged': True})
        if device == 'cuda':
            gru = torch.nn.GRU(128, 64, batch_first=True).to(device)
            x = torch.randn(1, args.length, 128, device=device)
            mask = torch.ones(1, args.length, 1, device=device)
            mask[:, args.length // 2:args.length // 2 + 30] = 0
            for name, implementation in [('cell', cell_sequence), ('packed', segmented_memory)]:
                with torch.no_grad(): implementation(gru, x, mask)
                samples = []
                for _ in range(3):
                    gru.zero_grad(set_to_none=True); torch.cuda.synchronize(); started = time.perf_counter()
                    y = implementation(gru, x, mask); y.square().mean().backward()
                    torch.cuda.synchronize(); samples.append((time.perf_counter() - started) * 1000)
                report['timings'].append({'method': name, 'length': args.length, 'forwardBackwardMs': samples})
    report['passed'] = len(report['checks']) + len(report['actorChecks'])
    Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
