"""Checks semi_gae against closed forms.  python learner/test_gae.py"""
import numpy as np

from ppo import semi_gae

rng = np.random.default_rng(0)
T, N, G, L = 40, 6, 0.99, 0.95
ok = True


def standard(rs, v, done, ended, gamma, lam):
    adv, last = np.zeros_like(rs), np.zeros(rs.shape[1])
    for t in reversed(range(len(rs))):
        last = rs[t] + gamma * v[t + 1] * (1 - done[t]) - v[t] + gamma * lam * (1 - ended[t]) * last
        adv[t] = last
    return adv


# 1. Every row a decision: identical to standard per-tick GAE (with terminal and truncated ends).
rs, v = rng.normal(size=(T, N)), rng.normal(size=(T + 1, N))
done = (rng.random((T, N)) < 0.05).astype(float)
trunc = (rng.random((T, N)) < 0.05).astype(float) * (1 - done)
ended = np.clip(done + trunc, 0, 1)
a = semi_gae(rs, v, done, ended, np.ones((T + 1, N)), G, L)
e1 = np.abs(a - standard(rs, v, done, ended, G, L)).max()
ok &= e1 < 1e-5
print('all-decide == standard GAE', e1)

# 2. lambda = 1, no ends, random busy rows: advantage = discounted reward-to-go to row T + bootstrap - V(t).
dec = (rng.random((T + 1, N)) < 0.6).astype(float)
z = np.zeros((T, N))
a = semi_gae(rs, v, z, z, dec, G, 1.0)
ref = np.zeros((T, N))
for t in range(T):
    ref[t] = sum(G ** (k - t) * rs[k] for k in range(t, T)) + G ** (T - t) * v[T] - v[t]
e2 = np.abs((a - ref)[dec[:T] > 0.5]).max()
ok &= e2 < 1e-4 and np.all(a[dec[:T] < 0.5] == 0)
print('lambda=1 busy rows == reward-to-go', e2)

# 3. lambda = 0: one-decision TD — rewards summed with per-tick discount up to the next decision, then its value.
a = semi_gae(rs, v, z, z, dec, G, 0.0)
e3 = 0.0
for n in range(N):
    for t in range(T):
        if dec[t, n] < 0.5:
            continue
        k, R = t, 0.0
        while True:
            R += G ** (k - t) * rs[k, n]
            k += 1
            if k == T or dec[k, n] > 0.5:
                break
        e3 = max(e3, abs(a[t, n] - (R + G ** (k - t) * v[k, n] - v[t, n])))
ok &= e3 < 1e-4
print('lambda=0 semi-MDP TD', e3)

# 4. A terminal end inside a busy stretch: no value or advantage crosses it.
d = np.ones((T + 1, N)); d[5:9] = 0; d[6] = 1  # ended row 6 is always a decide row (env guarantees it)
dn = np.zeros((T, N)); dn[5] = 1               # transition 5 -> 6 is terminal
a = semi_gae(rs, v, dn, dn, d, G, 1.0)
e4 = np.abs(a[4] - (rs[4] + G * rs[5] - v[4])).max()
ok &= e4 < 1e-5
print('terminal inside busy stretch', e4)
print('PASS' if ok else 'FAIL')
