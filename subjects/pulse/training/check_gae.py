"""GAE checks for ppo_gpu.Rollout on the CPU (the trainer may hold the GPU): terminal rows, elapsed-time discounting,
episode resets inside a rollout. The GPU-only imports of ppo_gpu are stubbed; only Rollout is exercised."""
import sys, types
import torch

for name in ('onnx', 'cuda_env', 'fit_rivals', 'job_progress', 'plan_model', 'checkpoint_state'):
    stub = types.ModuleType(name)
    stub.__getattr__ = lambda attr: None
    sys.modules[name] = stub
from ppo_gpu import Rollout

checks = []


def returns(rows, E, rate=0., gamma=.995, lam=.95):
    """rows: (env, decision time, reward, value, done, cut) in collection order; done ends the env's episode."""
    ro = Rollout(4096, 1, E, device='cpu')
    for e, t, r, v, done, cut in rows:
        idx, z = torch.tensor([e]), torch.zeros(1)
        ro.add(idx, torch.zeros(1, 1), torch.ones(1, 1), torch.zeros(1, 4), z, torch.tensor([float(v)]), torch.tensor([True]), torch.tensor([float(t)]))
        ro.credit(idx, torch.tensor([float(r)]))
        if done:
            k = ro.last[idx]; ro.done[k] = True; ro.cut[k] = cut; ro.last[idx] = -1
    adv, ret = ro.gae(gamma, lam, rate)
    assert torch.isfinite(adv).all() and torch.isfinite(ret).all(), ret
    return ret


def check(name, ok):
    checks.append(name)
    assert ok, name


# A terminal failure (severe early stop) does not bootstrap from its own value: reward -10, value +5 -> -10.
for rate in (0., 30.):
    check(f'terminal does not bootstrap (rate {rate})', torch.allclose(returns([(0, 0, -10, 5, True, False)], 1, rate), torch.tensor([-10.])))
check('a cut bootstraps its own value', torch.allclose(returns([(0, 0, -10, 5, True, True)], 1), torch.tensor([-10 + .995 * 5])))

# Reset inside a rollout: a terminal at t = 60 s, then the same env's next episode starting at t = 0 (clock restarts).
reset = [(0, 60, -10, 0, True, False), (0, 0, 1, 0, True, False)]
for rate in (0., 30.):
    check(f'reset boundary finite and separated (rate {rate})', torch.allclose(returns(reset, 1, rate), torch.tensor([-10., 1.])))
# ... and with live rows before and after the reset (the next episode's value must not leak into the terminal row).
seq = [(0, 59.9, 0, 2, False, False), (0, 60, -10, 3, True, False), (0, 0, 0, 4, False, False), (0, .1, 1, 0, True, False)]
for rate in (0., 30.):
    r = returns(seq, 1, rate)
    check(f'terminal row isolated from the next episode (rate {rate})', torch.isclose(r[1], torch.tensor(-10.)))

# Elapsed-time discounting: a reward 6 s ahead gets the same credit whether decisions come at 60 Hz or 15 Hz.
hz60 = [(0, k / 60, 1. if k == 360 else 0., 0, k == 360, False) for k in range(361)]
hz15 = [(1, k / 15, 1. if k == 90 else 0., 0, k == 90, False) for k in range(91)]
per_s = returns(hz60 + hz15, 2, 30.)
check('per-second credit is rate independent', torch.isclose(per_s[0], per_s[361], rtol=1e-4))
per_req = returns(hz60 + hz15, 2, 0.)
check('per-request credit (original) depends on rate', per_req[361] > 100 * per_req[0])

print(f'check_gae: {len(checks)} checks passed')
