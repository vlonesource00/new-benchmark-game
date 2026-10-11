"""Hardware proof, not a synthetic estimate of racing capability."""
import argparse
import json
import platform
import time
from pathlib import Path
import numpy as np
import torch

from model import PulsePolicy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--schema', default='artifacts/schema.json')
    parser.add_argument('--out', default='artifacts/doctor.json')
    args = parser.parse_args()
    schema = json.loads(Path(args.schema).read_text())
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable. PULSE training has not passed the GPU gate.')
    torch.manual_seed(7)
    device = torch.device('cuda')
    model = PulsePolicy(schema).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    obs = torch.randn(64, schema['size'], device=device).clamp(-1, 1)
    start = schema['groups']['rivals']['offset']
    obs[:, start:].reshape(64, 8, -1)[:, :, 0] = 1
    hidden = torch.zeros(64, schema['hidden'], device=device)
    before = next(model.parameters()).detach().clone()
    action, hidden = model(obs, hidden)
    loss = action.square().mean() + hidden.square().mean()
    loss.backward()
    optimizer.step()
    torch.cuda.synchronize()
    changed = bool((before != next(model.parameters())).any().item())
    if not changed or not torch.isfinite(loss):
        raise RuntimeError('Real CUDA backward/optimizer step failed')
    measurements = {}
    model.eval()
    with torch.inference_mode():
        for batch in [1, 16]:
            x = obs[:batch]
            h = hidden[:batch]
            for _ in range(20):
                _, h = model(x, h)
            torch.cuda.synchronize()
            samples = []
            for _ in range(100):
                t = time.perf_counter()
                a, h = model(x, h)
                # Include actual output transfer; GPU dispatch time alone is misleading.
                a.cpu().numpy()
                torch.cuda.synchronize()
                samples.append((time.perf_counter() - t) * 1000)
            measurements[str(batch)] = {f'p{p}': float(np.percentile(samples, p)) for p in [50, 95, 99]}
            measurements[str(batch)]['max'] = max(samples)
    result = {
        'python': platform.python_version(), 'torch': torch.__version__, 'cuda': torch.version.cuda,
        'gpu': torch.cuda.get_device_name(0), 'capability': list(torch.cuda.get_device_capability(0)),
        'memoryGiB': torch.cuda.get_device_properties(0).total_memory / 2**30,
        'parameters': sum(p.numel() for p in model.parameters()), 'cudaBackward': changed,
        'loss': float(loss.detach()), 'gpuEndToEndMs': measurements,
        'scope': 'Untrained network hardware test. Does not measure simulator throughput or browser inference.'
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
