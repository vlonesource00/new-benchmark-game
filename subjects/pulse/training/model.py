"""A small exportable GRU policy. Opponent order and padding have no semantics."""
import torch
from torch import nn


class PulsePolicy(nn.Module):
    def __init__(self, schema, reactive=False):
        super().__init__()
        self.schema = schema
        group = schema['groups']['rivals']
        self.own_size = group['offset']
        self.rivals = group['count']
        self.rival_width = group['width']
        self.hidden_size = schema['hidden']
        self.reactive = reactive
        # Public instantaneous motion feedback reaches the learned head directly.
        # Recurrent context still supplies trajectory/traffic memory. No ideal
        # route, teacher command or deterministic steering rule is introduced.
        names = ['ego.speed', 'ego.forwardSpeed', 'ego.sideSpeed', 'ego.headingSin',
                 'ego.yawRate', 'ego.ax', 'ego.ay', 'ego.roadOffset', 'ego.steering']
        self.feedback_indices = [next(i for i, f in enumerate(schema['fields']) if f['name'] == name) for name in names]
        self.register_buffer('feedback_scale', torch.tensor([1, 1, 2, 6, 4, 1, 1, 3, 8], dtype=torch.float32), persistent=False)
        self.context = nn.Sequential(nn.Linear(self.own_size, 128), nn.Tanh(), nn.Linear(128, 64), nn.Tanh())
        self.opponent = nn.Sequential(nn.Linear(self.rival_width - 1, 64), nn.Tanh(), nn.Linear(64, 32), nn.Tanh())
        self.input_gates = nn.Linear(128, self.hidden_size * 3)
        self.hidden_gates = nn.Linear(self.hidden_size, self.hidden_size * 3)
        self.head = nn.Sequential(nn.Linear(self.hidden_size + (len(names) if reactive else 0), 64), nn.Tanh(), nn.Linear(64, 2), nn.Tanh())

    def forward(self, observation, hidden):
        own = self.context(observation[:, :self.own_size])
        cars = observation[:, self.own_size:].reshape(-1, self.rivals, self.rival_width)
        mask = cars[:, :, :1]
        car_features = self.opponent(cars[:, :, 1:])
        mean = (car_features * mask).sum(1) / mask.sum(1).clamp(min=1)
        maximum = (car_features * mask - (1 - mask) * 10000).amax(1)
        maximum = maximum * (mask.sum(1) > 0).to(observation.dtype)
        ir, iz, inn = self.input_gates(torch.cat([own, mean, maximum], 1)).chunk(3, 1)
        hr, hz, hn = self.hidden_gates(hidden).chunk(3, 1)
        reset = torch.sigmoid(ir + hr)
        update = torch.sigmoid(iz + hz)
        candidate = torch.tanh(inn + reset * hn)
        next_hidden = (1 - update) * candidate + update * hidden
        feedback = (observation[:, self.feedback_indices] * self.feedback_scale).clamp(-2, 2)
        head_input = torch.cat([next_hidden, feedback], 1) if self.reactive else next_hidden
        return self.head(head_input), next_hidden

    def load_parent(self, weights):
        if self.reactive and weights['head.0.weight'].shape[1] == self.hidden_size:
            weights = dict(weights)
            expanded = torch.zeros_like(self.head[0].weight)
            expanded[:, :self.hidden_size] = weights['head.0.weight']
            weights['head.0.weight'] = expanded
        self.load_state_dict(weights)
