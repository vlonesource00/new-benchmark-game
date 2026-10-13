"""Pilot learned intentions with a frozen public-state/memory encoder.

The output has three spatial lateral knots and a speed, never wheel/pedals.
Its four-float wire contract is distinct from the original two actuators.
"""
import torch
from torch import nn
from model import PulsePolicy
from segmented_gru import segmented_memory


class PlanPolicy(nn.Module):
    # commit: an adapter branch reads the head input plus the previous intent (the masked pre-noise output, carried in
    # hidden[64:68]; the wire contract is unchanged because the runtime feeds nextHidden back verbatim) and adds to the
    # head's pre-tanh output. The BC head's first layer is ~95% saturated (|z| median ~17), so new inputs wired into it
    # would get ~1% of a gradient; the adapter starts unsaturated, with a zero output layer (initially the parent head).
    COMMIT = slice(64, 68)

    def __init__(self, schema, encoder_config, commit=False):
        super().__init__()
        self.schema, self.commit = schema, False
        self.encoder = PulsePolicy(schema, **encoder_config)
        self.width = schema['hidden'] + self.encoder.own_size + 64
        self.intent = nn.Sequential(nn.Linear(self.width, 64), nn.Tanh(), nn.Linear(64, 4), nn.Tanh())
        nn.init.zeros_(self.intent[2].weight)
        nn.init.zeros_(self.intent[2].bias)
        for parameter in self.encoder.parameters():
            parameter.requires_grad_(False)
        if commit:
            self.add_commit()

    def add_commit(self, units=32):
        """Adapter branch with a zero output layer: the policy is unchanged until training moves it."""
        assert not self.commit
        device = self.intent[0].weight.device
        self.adapter = nn.Sequential(nn.Linear(self.width + 4, units), nn.Tanh(), nn.Linear(units, 4)).to(device)
        nn.init.zeros_(self.adapter[2].weight); nn.init.zeros_(self.adapter[2].bias)
        self.commit = True

    def encoded(self, observation):
        own_input, own, mean, maximum, present = self.encoder.features(observation)
        return own_input, torch.cat([own, mean, maximum], 1), present

    def head_input(self, observation, hidden):
        """(head input, presence, traffic memory): forward split at the head, shared by training and export.
        With commit the head input ends with the previous intent (4 columns)."""
        own, encoded, present = self.encoded(observation)
        ir, iz, inn = self.encoder.traffic_input_gates(encoded).chunk(3, 1)
        hr, hz, hn = self.encoder.traffic_hidden_gates(hidden[:, :64]).chunk(3, 1)
        reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
        memory = ((1 - update) * torch.tanh(inn + reset * hn) + update * hidden[:, :64]) * present
        parts = [encoded, own, memory] + ([hidden[:, self.COMMIT]] if self.commit else [])
        return torch.cat(parts, 1), present, memory

    def head(self, feat):
        """Unmasked intent from a head input (multiply by presence)."""
        if not self.commit:
            return self.intent(feat)
        base = feat[:, :self.width]
        return torch.tanh(self.intent[2](self.intent[1](self.intent[0](base))) + self.adapter(feat))

    def next_hidden(self, memory, intent, hidden):
        """Recurrent state after a decision: traffic memory, then (commit) the masked pre-noise intent."""
        if not self.commit:
            return torch.cat([memory, torch.zeros_like(hidden[:, 64:])], 1)
        return torch.cat([memory, intent, torch.zeros_like(hidden[:, 68:])], 1)

    def forward(self, observation, hidden):
        feat, present, memory = self.head_input(observation, hidden)
        intent = self.head(feat) * present
        return intent, self.next_hidden(memory, intent, hidden)

    def sequence_inputs(self, observation):
        """Only accepted request observations enter this frozen history."""
        assert not self.commit, 'sequence_inputs is the BC path of the original head'
        own, encoded, present = self.encoded(observation)
        with torch.random.fork_rng(devices=[]):
            gru = nn.GRU(self.schema['hidden'], 64, batch_first=True).to(observation.device)
        gru.weight_ih_l0 = self.encoder.traffic_input_gates.weight
        gru.weight_hh_l0 = self.encoder.traffic_hidden_gates.weight
        gru.bias_ih_l0 = self.encoder.traffic_input_gates.bias
        gru.bias_hh_l0 = self.encoder.traffic_hidden_gates.bias
        gru.flatten_parameters()
        memory = segmented_memory(gru, encoded[None], present[None])[0]
        return torch.cat([encoded, own, memory], 1), present
