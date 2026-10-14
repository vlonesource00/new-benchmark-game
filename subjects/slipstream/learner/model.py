"""SLIPSTREAM actor-critic: road / ego / rival-attention encoders -> GRU memory -> steer + signed pedal.

The whole actor is trained; there is no scripted driving layer or route fallback.
The critic sees the same features plus the actor's memory (privileged sim inputs can be appended later).
"""
import torch
import torch.nn as nn


def mlp(i, h, o, n=2):
    layers, d = [], i
    for _ in range(n - 1):
        layers += [nn.Linear(d, h), nn.ELU()]
        d = h
    layers.append(nn.Linear(d, o))
    return nn.Sequential(*layers)


class Slipstream(nn.Module):
    def __init__(self, layout, hidden=256):
        super().__init__()
        self.ego_f, self.k, self.rf_f, self.rn, self.rv_f = layout['ego'], layout['roadK'], layout['roadF'], layout['rivalN'], layout['rivalF']
        self.ego = mlp(self.ego_f, 128, 128)
        self.road = mlp(self.k * self.rf_f, 256, 128)
        self.tok = mlp(self.rv_f, 64, 64)
        self.query = nn.Linear(256, 64)
        self.null = nn.Parameter(torch.zeros(1, 1, 64))
        self.attn = nn.MultiheadAttention(64, 4, batch_first=True)
        feat = 128 + 128 + 64
        self.pre = nn.Sequential(nn.Linear(feat, hidden), nn.ELU())
        self.gru = nn.GRUCell(hidden, hidden)
        self.pi = mlp(hidden + feat, 256, 2)
        self.v = mlp(hidden + feat, 256, 1)
        self.log_std = nn.Parameter(torch.full((2,), -0.7))
        nn.init.orthogonal_(self.pi[-1].weight, 0.01)
        nn.init.zeros_(self.pi[-1].bias)
        self.hidden = hidden

    def features(self, x):
        b = x.shape[0]
        e = self.ego(x[:, :self.ego_f])
        r0 = self.ego_f + self.k * self.rf_f
        r = self.road(x[:, self.ego_f:r0])
        riv = x[:, r0:r0 + self.rn * self.rv_f].reshape(b, self.rn, self.rv_f)
        present = riv[:, :, 0] > 0.5
        t = torch.cat([self.null.expand(b, 1, 64), self.tok(riv)], 1)
        mask = torch.cat([torch.zeros(b, 1, dtype=torch.bool, device=x.device), ~present], 1)
        q = self.query(torch.cat([e, r], 1)).unsqueeze(1)
        a, _ = self.attn(q, t, t, key_padding_mask=mask, need_weights=False)
        return torch.cat([e, r, a.squeeze(1)], 1)

    def step(self, x, h, first, decide=None):
        """One tick: x [B,obs] (normalised), h [B,H], first [B] (1 = episode start -> fresh memory).
        decide [B]: 1 where the NN is actually queried; elsewhere the memory is held (the browser never saw that state)."""
        f = self.features(x)
        hn = self.gru(self.pre(f), h * (1 - first).unsqueeze(1))
        h = hn if decide is None else torch.where(decide.unsqueeze(1) > 0.5, hn, h)
        z = torch.cat([h, f], 1)
        return self.pi(z), self.v(z).squeeze(1), h

    def sequence(self, x, h0, first, decide=None):
        """x [T,B,obs], first/decide [T,B]: recomputes the memory through a rollout segment (held on non-decide ticks)."""
        T, B = x.shape[:2]
        f = self.features(x.reshape(T * B, -1)).reshape(T, B, -1)
        p = self.pre(f)
        h, hs = h0, []
        for t in range(T):
            hn = self.gru(p[t], h * (1 - first[t]).unsqueeze(1))
            h = hn if decide is None else torch.where(decide[t].unsqueeze(1) > 0.5, hn, h)
            hs.append(h)
        z = torch.cat([torch.stack(hs), f], 2)
        return self.pi(z), self.v(z).squeeze(2)


class GraphedSequence:
    """net.sequence for training, captured once per input shape as a CUDA graph (forward and backward) and replayed.
    The recurrent pass is 128 small steps whose cost is kernel launches, not arithmetic; a replay launches them as one
    unit. Same kernels, same order: outputs and gradients are bit-identical to net.sequence. Shapes must repeat (PPO
    minibatches and imitation batches do); parameters are read in place, so optimizer steps and loads stay live.
    One backward per forward: the captured backward reuses the forward's saved-activation memory, so a second backward
    (retain_graph) reads clobbered values. Anything that differentiates twice must use net.sequence."""

    class _Seq(nn.Module):
        def __init__(self, net):
            super().__init__()
            self.net = net

        def forward(self, x, h0, first, decide):
            mu, v = self.net.sequence(x, h0, first, decide)
            return mu + 0 * self.net.log_std, v  # every parameter in the graph (capture differentiates them all)

    def __init__(self, net):
        self.net, self.graphs = net, {}

    def __call__(self, x, h0, first, decide):
        key = (tuple(x.shape), tuple(h0.shape))
        if key not in self.graphs:
            # one wrapper per shape: capturing a module replaces its forward with that graph
            self.graphs[key] = torch.cuda.make_graphed_callables(
                self._Seq(self.net), (x.detach().clone(), h0.detach().clone(), first.clone(), decide.clone()), num_warmup_iters=3)
        return self.graphs[key](x, h0, first, decide)

