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
        # contract v3: race-context values after the v2 block, concatenated onto the ego and rival-token inputs
        self.ex, self.rx = layout.get('egoX', 0), layout.get('rivalX', 0)
        self.v2 = self.ego_f + self.k * self.rf_f + self.rn * self.rv_f
        self.ego = mlp(self.ego_f + self.ex, 128, 128)
        self.road = mlp(self.k * self.rf_f, 256, 128)
        self.tok = mlp(self.rv_f + self.rx, 64, 64)
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
        # Risk critic: the value of the safety-cost part of the reward (env row's risk value); v then values the rest.
        # Starts at zero, so a network from before it values exactly as it did. Registered last: older optimizer
        # states keep their parameter order (ppo maps them by name). split_v: value outputs [task, risk], else their sum.
        self.vr = mlp(hidden + feat, 256, 1)
        nn.init.zeros_(self.vr[-1].weight)
        nn.init.zeros_(self.vr[-1].bias)
        self.split_v = False

    def load_state_dict(self, sd, strict=True, **kw):
        if strict and not any(k.startswith('vr.') for k in sd):  # from before the risk critic: keep its zero init
            sd = {**sd, **{'vr.' + k: v for k, v in self.vr.state_dict().items()}}
        return super().load_state_dict(sd, strict=strict, **kw)

    def value(self, z):
        v = torch.cat([self.v(z), self.vr(z)], -1)
        return v if self.split_v else v.sum(-1)

    def value_params(self):
        return [*self.v.parameters(), *self.vr.parameters()]

    def features(self, x):
        b = x.shape[0]
        ein = x[:, :self.ego_f] if not self.ex else torch.cat([x[:, :self.ego_f], x[:, self.v2:self.v2 + self.ex]], 1)
        e = self.ego(ein)
        r0 = self.ego_f + self.k * self.rf_f
        r = self.road(x[:, self.ego_f:r0])
        riv = x[:, r0:r0 + self.rn * self.rv_f].reshape(b, self.rn, self.rv_f)
        present = riv[:, :, 0] > 0.5
        if self.rx:
            x0 = self.v2 + self.ex
            riv = torch.cat([riv, x[:, x0:x0 + self.rn * self.rx].reshape(b, self.rn, self.rx)], 2)
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
        return self.pi(z), self.value(z), h

    def sequence(self, x, h0, first, decide=None, with_h=False):
        """x [T,B,obs], first/decide [T,B]: recomputes the memory through a rollout segment (held on non-decide ticks).
        with_h: also the memory after each tick [T,B,H]."""
        T, B = x.shape[:2]
        f = self.features(x.reshape(T * B, -1)).reshape(T, B, -1)
        p = self.pre(f)
        h, hs = h0, []
        for t in range(T):
            hn = self.gru(p[t], h * (1 - first[t]).unsqueeze(1))
            h = hn if decide is None else torch.where(decide[t].unsqueeze(1) > 0.5, hn, h)
            hs.append(h)
        hs = torch.stack(hs)
        z = torch.cat([hs, f], 2)
        return (self.pi(z), self.value(z), hs) if with_h else (self.pi(z), self.value(z))


class SlipstreamMoE(nn.Module):
    """Two experts and a learned router. `base` is a frozen pace expert (a track specialist: its weights and its own
    input normaliser are fixed, so combat training cannot erode its driving); `cmb` is the trainable combat expert,
    whose value head is the critic. The router reads the combat expert's policy input (memory + ego/road/rival-attention
    features) and outputs g in [0, 1]; the action mean is (1 - g) * base + g * cmb. Inputs arrive normalised by the
    training normaliser (frozen for MoE runs); the base expert's view is re-normalised from them with its own statistics.
    Memory is the two GRU states side by side: h = [h_base, h_cmb].
    Residual mode (buffer `residual`): the action mean is base + g * cmb, so the combat expert's head is a correction
    to the pace expert's driving, not a replacement for it; with that head at zero the network drives exactly as the
    specialist (tt-moe3: replacing the specialist in traffic traded contact for offs).
    v4 wiring (layout with corrX, contract v4): the correction sees what it corrects and what decides contact. The combat
    expert's pre layer also reads the collision-corridor block; its policy head and the router also read the pace
    expert's action mean and that block; the critic further reads the pace expert's memory, the router output and the
    applied action mean (no gradient into those). New columns enter only through widened first layers
    (contract.moe_widths), so a migrated v3 MoE (zero columns) computes exactly what it did."""

    def __init__(self, layout, hidden=256, gate_bias=-2.0):
        super().__init__()
        self.base, self.cmb = Slipstream(layout, hidden), Slipstream(layout, hidden)
        self.base.requires_grad_(False)
        self.cx = layout.get('corrX', 0)
        D = self.cmb.v2 + self.cmb.ex + self.cmb.rn * self.cmb.rx + self.cx
        self.c0 = D - self.cx
        feat = 128 + 128 + 64
        ax = 2 + self.cx if self.cx else 0
        self.gate = mlp(hidden + feat + ax, 64, 1)
        if self.cx:
            vx = ax + hidden + 1 + 2
            self.cmb.pre[0] = nn.Linear(feat + self.cx, hidden)
            self.cmb.pi[0] = nn.Linear(hidden + feat + ax, 256)
            self.cmb.v[0] = nn.Linear(hidden + feat + vx, 256)
            self.cmb.vr[0] = nn.Linear(hidden + feat + vx, 256)
        nn.init.zeros_(self.gate[-1].weight)
        nn.init.constant_(self.gate[-1].bias, gate_bias)
        self.log_std = self.cmb.log_std
        for k in ('t_mean', 't_std', 'b_mean', 'b_std'):
            self.register_buffer(k, torch.zeros(D) if 'mean' in k else torch.ones(D))
        self.register_buffer('skip', torch.zeros(D, dtype=torch.bool))
        self.register_buffer('residual', torch.zeros((), dtype=torch.bool))
        self.hidden, self.eh = 2 * hidden, hidden

    def value_params(self):
        return self.cmb.value_params()

    def load_state_dict(self, sd, strict=True, **kw):
        if 'residual' not in sd:  # checkpoints from before residual mode are blends
            sd = {**sd, 'residual': torch.zeros((), dtype=torch.bool)}
        for e in ('base', 'cmb'):  # from before the risk critic: keep its zero init
            if strict and not any(k.startswith(e + '.vr.') for k in sd):
                sd = {**sd, **{f'{e}.vr.' + k: v for k, v in getattr(self, e).vr.state_dict().items()}}
        return super().load_state_dict(sd, strict=strict, **kw)

    def make_residual(self):
        """Switch to residual mode: the combat head restarts near zero (a correction to learn), trunk and router kept."""
        self.residual.fill_(True)
        nn.init.orthogonal_(self.cmb.pi[-1].weight, 0.01)
        nn.init.zeros_(self.cmb.pi[-1].bias)

    def set_norms(self, train, base, skip):
        """train/base: (mean, std) arrays of the training and base normalisers; skip: raw (unnormalised) columns."""
        for k, val in (('t_mean', train[0]), ('t_std', train[1]), ('b_mean', base[0]), ('b_std', base[1])):
            getattr(self, k).copy_(torch.as_tensor(val, dtype=torch.float32))
        self.skip.zero_()
        self.skip[torch.as_tensor(skip, dtype=torch.long)] = True

    def base_view(self, x):
        raw = x * self.t_std + self.t_mean
        xb = ((raw - self.b_mean) / self.b_std).clamp(-10, 10)
        return torch.where(self.skip, x, xb)

    def mix(self, mb, mc, za):
        g = torch.sigmoid(self.gate(za))
        # torch.where, not a Python branch on the buffer: no host sync, so CUDA-graph capture stays legal
        return torch.where(self.residual, mb + g * mc, (1 - g) * mb + g * mc), g.squeeze(-1)

    def step(self, x, h, first, decide=None, with_gate=False):
        hb, hc = h[:, :self.eh], h[:, self.eh:]
        mb, _, hb = self.base.step(self.base_view(x), hb, first, decide)
        fc = self.cmb.features(x)
        corr = x[:, self.c0:self.c0 + self.cx]
        hn = self.cmb.gru(self.cmb.pre(torch.cat([fc, corr], 1) if self.cx else fc), hc * (1 - first).unsqueeze(1))
        hc = hn if decide is None else torch.where(decide.unsqueeze(1) > 0.5, hn, hc)
        zc = torch.cat([hc, fc], 1)
        za = torch.cat([zc, mb, corr], 1) if self.cx else zc
        mu, g = self.mix(mb, self.cmb.pi(za), za)
        zv = torch.cat([za, hb.detach(), g.detach().unsqueeze(-1), mu.detach()], 1) if self.cx else zc
        out = (mu, self.cmb.value(zv), torch.cat([hb, hc], 1))
        return (*out, g) if with_gate else out

    def sequence(self, x, h0, first, decide=None):
        """Returns (mu, v, g, d): the router output g [T,B] is trained by the PPO loss through mu and regularised there;
        d [T,B,2] is the action mean minus the pace expert's (the correction actually applied; the anchor cost's input)."""
        T, B = x.shape[:2]
        with torch.no_grad():
            mb, _, hb = self.base.sequence(self.base_view(x.reshape(T * B, -1)).reshape(T, B, -1), h0[:, :self.eh], first, decide, with_h=True)
        f = self.cmb.features(x.reshape(T * B, -1)).reshape(T, B, -1)
        corr = x[:, :, self.c0:self.c0 + self.cx]
        p = self.cmb.pre(torch.cat([f, corr], 2) if self.cx else f)
        h, hs = h0[:, self.eh:], []
        for t in range(T):
            hn = self.cmb.gru(p[t], h * (1 - first[t]).unsqueeze(1))
            h = hn if decide is None else torch.where(decide[t].unsqueeze(1) > 0.5, hn, h)
            hs.append(h)
        zc = torch.cat([torch.stack(hs), f], 2)
        za = torch.cat([zc, mb, corr], 2) if self.cx else zc
        mu, g = self.mix(mb, self.cmb.pi(za), za)
        zv = torch.cat([za, hb, g.detach().unsqueeze(-1), mu.detach()], 2) if self.cx else zc
        return mu, self.cmb.value(zv), g, mu - mb


def build_net(ck_or_layout, hidden=256):
    """The network a checkpoint holds (plain or MoE), from the checkpoint dict or a layout."""
    if isinstance(ck_or_layout, dict) and 'moe' in ck_or_layout:
        return SlipstreamMoE(ck_or_layout['layout'], hidden)
    lay = ck_or_layout['layout'] if isinstance(ck_or_layout, dict) and 'layout' in ck_or_layout and 'ego' not in ck_or_layout else ck_or_layout
    return Slipstream(lay, hidden)


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
            out = self.net.sequence(x, h0, first, decide)  # (mu, v) or, for the MoE, (mu, v, gate)
            return (out[0] + 0 * self.net.log_std, *out[1:])  # every parameter in the graph (capture differentiates them all)

    def __init__(self, net):
        self.net, self.graphs = net, {}

    def __call__(self, x, h0, first, decide):
        key = (tuple(x.shape), tuple(h0.shape))
        if key not in self.graphs:
            # one wrapper per shape: capturing a module replaces its forward with that graph
            self.graphs[key] = torch.cuda.make_graphed_callables(
                self._Seq(self.net), (x.detach().clone(), h0.detach().clone(), first.clone(), decide.clone()), num_warmup_iters=3)
        return self.graphs[key](x, h0, first, decide)

