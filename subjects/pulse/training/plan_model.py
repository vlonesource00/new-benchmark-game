"""Pilot learned intentions with a frozen public-state/memory encoder.

The output has three spatial lateral knots and a speed, never wheel/pedals.
Its four-float wire contract is distinct from the original two actuators.
"""
import torch
from torch import nn
from model import PulsePolicy
from segmented_gru import segmented_memory


class PlanPolicy(nn.Module):
    def __init__(self, schema, encoder_config):
        super().__init__()
        self.schema = schema
        self.encoder = PulsePolicy(schema, **encoder_config)
        self.intent = nn.Sequential(nn.Linear(schema['hidden'] + self.encoder.own_size + 64, 64),
                                    nn.Tanh(), nn.Linear(64, 4), nn.Tanh())
        nn.init.zeros_(self.intent[2].weight)
        nn.init.zeros_(self.intent[2].bias)
        for parameter in self.encoder.parameters():
            parameter.requires_grad_(False)

    def encoded(self, observation):
        own_input, own, mean, maximum, present = self.encoder.features(observation)
        return own_input, torch.cat([own, mean, maximum], 1), present

    def forward(self, observation, hidden):
        own, encoded, present = self.encoded(observation)
        ir, iz, inn = self.encoder.traffic_input_gates(encoded).chunk(3, 1)
        hr, hz, hn = self.encoder.traffic_hidden_gates(hidden[:, :64]).chunk(3, 1)
        reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
        memory = ((1 - update) * torch.tanh(inn + reset * hn) + update * hidden[:, :64]) * present
        next_hidden = torch.cat([memory, torch.zeros_like(hidden[:, 64:])], 1)
        return self.intent(torch.cat([encoded, own, memory], 1)) * present, next_hidden

    def sequence_inputs(self, observation):
        """Only accepted request observations enter this frozen history."""
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
