"""A small exportable GRU policy. Opponent order and padding have no semantics."""
import torch
from torch import nn


def transfer_observations(weights, parent_schema, schema):
    """Explicit v1→v2 transfer; every old field/function is preserved initially."""
    if parent_schema['version'] != 'pulse-observation-v1' or schema['version'] != 'pulse-observation-v2':
        raise ValueError('Only the explicit public-state v1-to-v2 transfer is supported')
    if parent_schema['hidden'] != schema['hidden'] or parent_schema['action'] != schema['action'] or parent_schema['groups']['rivals']['width'] != schema['groups']['rivals']['width']:
        raise ValueError('Action/memory/rival contracts changed')
    by_name = {f['name']: (i, f) for i, f in enumerate(schema['fields'])}
    if any(f['name'] not in by_name or by_name[f['name']][1] != f for f in parent_schema['fields']):
        raise ValueError('Existing fields changed scale or definition')
    old_size, new_size = parent_schema['groups']['rivals']['offset'], schema['groups']['rivals']['offset']
    weights = dict(weights)
    old = weights['context.0.weight']
    expanded = torch.zeros((old.shape[0], new_size), dtype=old.dtype, device=old.device)
    for i, f in enumerate(parent_schema['fields'][:old_size]):
        expanded[:, by_name[f['name']][0]] = old[:, i]
    weights['context.0.weight'] = expanded
    return weights


class PulsePolicy(nn.Module):
    def __init__(self, schema, reactive=False, contextSkip=False, instant=False, motorHistoryMask=False, splitMotor=False):
        super().__init__()
        self.schema = schema
        group = schema['groups']['rivals']
        self.own_size = group['offset']
        self.rivals = group['count']
        self.rival_width = group['width']
        self.hidden_size = schema['hidden']
        self.reactive = reactive
        self.context_skip = contextSkip
        self.instant = instant
        self.motor_history_mask = motorHistoryMask
        self.split_motor = splitMotor
        if instant and (reactive or contextSkip):
            raise ValueError('Instant actor is a separate bounded control experiment')
        if motorHistoryMask and not instant:
            raise ValueError('Command-shortcut masking is an instantaneous motor experiment')
        if splitMotor and not instant:
            raise ValueError('Pedal isolation requires an instantaneous motor actor')
        history_names = ['ego.previousSteer', 'ego.previousLongitudinal', 'ego.heldSteer', 'ego.heldLongitudinal', 'ego.steering']
        input_mask = torch.ones(self.own_size)
        for i, f in enumerate(schema['fields'][:self.own_size]):
            if f['name'] in history_names:
                input_mask[i] = 0
        self.register_buffer('motor_input_mask', input_mask, persistent=False)
        # Public instantaneous motion feedback reaches the learned head directly.
        # Recurrent context still supplies trajectory/traffic memory. No ideal
        # route, teacher command or deterministic steering rule is introduced.
        names = ['ego.speed', 'ego.forwardSpeed', 'ego.sideSpeed', 'ego.headingSin',
                 'ego.yawRate', 'ego.ax', 'ego.ay', 'ego.roadOffset', 'ego.steering']
        self.feedback_indices = [next(i for i, f in enumerate(schema['fields']) if f['name'] == name) for name in names]
        self.register_buffer('feedback_scale', torch.tensor([1, 1, 2, 6, 4, 1, 1, 3, 8], dtype=torch.float32), persistent=False)
        self.context = nn.Sequential(nn.Linear(self.own_size, 128), nn.Tanh(), nn.Linear(128, 64), nn.Tanh())
        self.opponent = nn.Sequential(nn.Linear(self.rival_width - 1, 64), nn.Tanh(), nn.Linear(64, 32), nn.Tanh())
        if not instant:
            self.input_gates = nn.Linear(128, self.hidden_size * 3)
            self.hidden_gates = nn.Linear(self.hidden_size, self.hidden_size * 3)
        self.head = nn.Sequential(nn.Linear(self.hidden_size + (len(names) if reactive else 0) + (64 if contextSkip else 0), 64), nn.Tanh(), nn.Linear(64, 2), nn.Tanh())
        if splitMotor:
            # Preserve the learned steering response while fitting pedals to
            # current public motion/road state. No expert output or route enters
            # this head, and no expert actuator is used during evaluation.
            self.pedals = nn.Sequential(nn.Linear(self.hidden_size + self.own_size, 64), nn.Tanh(), nn.Linear(64, 1), nn.Tanh())
            for parameter in self.parameters():
                parameter.requires_grad_(False)
            for parameter in self.pedals.parameters():
                parameter.requires_grad_(True)

    def forward(self, observation, hidden):
        own_input = observation[:, :self.own_size]
        if self.motor_history_mask:
            # Apply the same mask in training and exported inference. Motion,
            # tyre dynamics and road/rivals remain; a prior command cannot be
            # used as an almost-perfect teacher-forced steering shortcut.
            own_input = own_input * self.motor_input_mask
        own = self.context(own_input)
        cars = observation[:, self.own_size:].reshape(-1, self.rivals, self.rival_width)
        mask = cars[:, :, :1]
        car_features = self.opponent(cars[:, :, 1:])
        mean = (car_features * mask).sum(1) / mask.sum(1).clamp(min=1)
        maximum = (car_features * mask - (1 - mask) * 10000).amax(1)
        maximum = maximum * (mask.sum(1) > 0).to(observation.dtype)
        if self.instant:
            # Diagnostic motor actor: current public state alone chooses pedals.
            # Preserve the mailbox's hidden-state shape, but do not claim learned
            # temporal planning or let untrained memory alter physical feedback.
            encoded = torch.cat([own, mean, maximum], 1)
            action = self.head(encoded)
            if self.split_motor:
                longitudinal = self.pedals(torch.cat([encoded, own_input], 1))
                action = torch.cat([action[:, :1], longitudinal], 1)
            return action, hidden
        ir, iz, inn = self.input_gates(torch.cat([own, mean, maximum], 1)).chunk(3, 1)
        hr, hz, hn = self.hidden_gates(hidden).chunk(3, 1)
        reset = torch.sigmoid(ir + hr)
        update = torch.sigmoid(iz + hz)
        candidate = torch.tanh(inn + reset * hn)
        next_hidden = (1 - update) * candidate + update * hidden
        feedback = (observation[:, self.feedback_indices] * self.feedback_scale).clamp(-2, 2)
        inputs = [next_hidden]
        if self.reactive:
            inputs.append(feedback)
        if self.context_skip:
            # Present road/motion features can influence a command without first
            # passing through the recurrent filter. Rivals remain in memory.
            inputs.append(own)
        head_input = torch.cat(inputs, 1)
        return self.head(head_input), next_hidden

    def load_parent(self, weights):
        if self.split_motor and 'pedals.0.weight' not in weights:
            # Initially identical to the parent, including pedal output. New
            # public-state columns start at zero so attribution is controlled.
            weights = dict(weights)
            expanded = torch.zeros_like(self.pedals[0].weight)
            expanded[:, :self.hidden_size] = weights['head.0.weight']
            weights.update({'pedals.0.weight': expanded, 'pedals.0.bias': weights['head.0.bias'].clone(),
                            'pedals.2.weight': weights['head.2.weight'][1:2].clone(), 'pedals.2.bias': weights['head.2.bias'][1:2].clone()})
        incoming = weights['head.0.weight'].shape[1]
        if incoming != self.head[0].weight.shape[1]:
            if incoming not in [self.hidden_size, self.hidden_size + len(self.feedback_indices)] or incoming > self.head[0].weight.shape[1] or (incoming > self.hidden_size and not self.reactive):
                raise ValueError('Cannot drop or reorder a parent head branch')
            weights = dict(weights)
            expanded = torch.zeros_like(self.head[0].weight)
            expanded[:, :incoming] = weights['head.0.weight']
            weights['head.0.weight'] = expanded
        self.load_state_dict(weights)
