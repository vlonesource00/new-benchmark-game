"""Teacher (INTERCEPT) sequences for an imitation term next to PPO (env/teacher.mjs writes them).

The network is recurrent, so imitation runs on chunks: the memory starts empty at the chunk start, the first `burn`
decisions only warm it up, and the loss is the squared error between the policy mean and INTERCEPT's [steer, pedal] on
the remaining clean decisions.
  python learner/teacher.py --ckpt runs/tt-p1/snap-30-ema.pt --files t2-harbor-ring-s7,...   (per-track agreement report)
"""
import argparse
import json
import os

import numpy as np
import torch

SUBJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEACHER_DIR = os.path.join(SUBJECT, 'runs', 'teacher')


class TeacherData:
    def __init__(self, names, obs_dim, dev):
        self.seqs = []
        for n in names:
            meta = json.load(open(os.path.join(TEACHER_DIR, n + '.json')))
            assert meta['obs'] == obs_dim, f'{n}: teacher obs {meta["obs"]} != network {obs_dim} (contract v2 needed: --migrate)'
            raw = np.fromfile(os.path.join(TEACHER_DIR, n + '.bin'), np.float32).reshape(-1, meta['width'])
            t = torch.from_numpy(raw).to(dev)
            self.seqs.append({'name': n, 'track': meta['track'], 'x': t[:, :obs_dim], 'y': t[:, obs_dim:obs_dim + 2],
                              's': t[:, obs_dim + 2], 'clean': t[:, obs_dim + 3]})
        self.w = np.array([len(q['x']) for q in self.seqs], np.float64)
        self.w /= self.w.sum()
        self.dev = dev

    def batch(self, B, C, rng):
        """B chunks of C consecutive decisions, files drawn by size: x [C,B,D], y [C,B,2], clean [C,B]."""
        xs, ys, cs = [], [], []
        for k in rng.choice(len(self.seqs), size=B, p=self.w):
            q = self.seqs[k]
            i = int(rng.integers(0, len(q['x']) - C))
            xs.append(q['x'][i:i + C]); ys.append(q['y'][i:i + C]); cs.append(q['clean'][i:i + C])
        return torch.stack(xs, 1), torch.stack(ys, 1), torch.stack(cs, 1)


def torch_norm(norm, dev):
    """The learner's RunningNorm as a GPU function (same clip and raw binary columns)."""
    mean = torch.as_tensor(norm.mean, dtype=torch.float32, device=dev)
    sd = torch.as_tensor(np.sqrt(norm.var + 1e-8), dtype=torch.float32, device=dev)
    skip = torch.as_tensor(norm.skip if norm.skip is not None else [], dtype=torch.long, device=dev)

    def f(x):
        y = ((x - mean) / sd).clamp(-10, 10)
        if len(skip):
            y[..., skip] = x[..., skip]
        return y
    return f


def bc_loss(net, x, y, clean, nf, burn):
    C, B = x.shape[:2]
    first = torch.zeros(C, B, device=x.device); first[0] = 1
    mu, _ = net.sequence(nf(x), torch.zeros(B, net.hidden, device=x.device), first, torch.ones(C, B, device=x.device))
    m = clean.clone(); m[:burn] = 0
    return ((((mu - y) ** 2).sum(2)) * m).sum() / m.sum().clamp(min=1)


def main():
    from contract import layout_of, obs_len
    from model import Slipstream
    from ppo import RunningNorm, binary_columns
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--files', required=True)
    a = ap.parse_args()
    dev = torch.device('cuda')
    ck = torch.load(os.path.join(SUBJECT, a.ckpt), map_location=dev, weights_only=False)
    lay = layout_of(ck)
    net = Slipstream(lay).to(dev).eval(); net.load_state_dict(ck['model'])
    norm = RunningNorm(obs_len(lay), binary_columns(lay)); norm.load(ck['norm'])
    data = TeacherData(a.files.split(','), obs_len(lay), dev)
    nf, rng = torch_norm(norm, dev), np.random.default_rng(0)
    with torch.no_grad():
        for q in data.seqs:
            sub = TeacherData.__new__(TeacherData); sub.seqs, sub.w, sub.dev = [q], np.ones(1), dev
            x, y, c = sub.batch(64, 128, rng)
            print(f"{q['name']:28s} imitation mse {bc_loss(net, x, y, c, nf, 32).item():.4f}")


if __name__ == '__main__':
    main()
