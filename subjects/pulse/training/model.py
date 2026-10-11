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
    def __init__(self, schema, reactive=False, contextSkip=False, instant=False, motorHistoryMask=False, splitMotor=False, trafficResidual=False, trafficMemory=False, motorTune=False):
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
        self.traffic_residual = trafficResidual
        self.traffic_memory = trafficMemory
        self.motor_tune = motorTune
        self.traffic_memory_size = 64
        if instant and (reactive or contextSkip):
            raise ValueError('Instant actor is a separate bounded control experiment')
        if motorHistoryMask and not instant:
            raise ValueError('Command-shortcut masking is an instantaneous motor experiment')
        if splitMotor and not instant:
            raise ValueError('Pedal isolation requires an instantaneous motor actor')
        if trafficResidual and not (instant and splitMotor):
            raise ValueError('Traffic residual requires the preserved split motor')
        if trafficMemory and not trafficResidual:
            raise ValueError('Traffic memory requires the preserved traffic residual')
        if motorTune and not (instant and splitMotor):
            raise ValueError('Motor refitting requires an existing split motor')
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
        if trafficResidual:
            # Empty-rival motor is preserved. A learned traffic correction can
            # change both actuators without retraining the clean-air motor.
            if trafficMemory:
                self.traffic_input_gates = nn.Linear(self.hidden_size, self.traffic_memory_size * 3)
                self.traffic_hidden_gates = nn.Linear(self.traffic_memory_size, self.traffic_memory_size * 3)
            self.traffic = nn.Sequential(nn.Linear(self.hidden_size + self.own_size + (self.traffic_memory_size if trafficMemory else 0), 64), nn.Tanh(), nn.Linear(64, 2), nn.Tanh())
            nn.init.zeros_(self.traffic[2].weight)
            nn.init.zeros_(self.traffic[2].bias)
            for parameter in self.parameters():
                parameter.requires_grad_(False)
            branches = [self.opponent, self.traffic]
            if trafficMemory:
                branches += [self.traffic_input_gates, self.traffic_hidden_gates]
            for branch in branches:
                for parameter in branch.parameters():
                    parameter.requires_grad_(True)
        if motorTune:
            # Explicit corrective experiment: refit the existing clean-air
            # motor, keeping traffic weights fixed. Topology and inference
            # initially match the parent; clean-air parity after learning is
            # intentionally no longer guaranteed and must pass driving gates.
            for parameter in self.parameters():
                parameter.requires_grad_(False)
            for branch in [self.context, self.head, self.pedals]:
                for parameter in branch.parameters():
                    parameter.requires_grad_(True)

    def features(self, observation):
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
        return own_input, own, mean, maximum, mask.sum(1).clamp(0, 1)

    def traffic_sequence(self, observation, burn, fresh):
        """Training-only sequence batching; exported control remains stepwise.

        cuDNN runs uninterrupted traffic sequences. Windows crossing an empty
        traffic state use the exact reset-aware cell. Mid-episode burn-in is
        detached, matching rollout_loss's existing truncated-gradient contract.
        """
        batch, length, _ = observation.shape
        own_input, own, mean, maximum, present = self.features(observation.reshape(-1, observation.shape[-1]))
        encoded = torch.cat([own, mean, maximum], 1).reshape(batch, length, -1)
        present = present.reshape(batch, length, 1)
        motor = torch.cat([own, torch.zeros_like(mean), torch.zeros_like(maximum)], 1)
        base = torch.cat([self.head(motor)[:, :1], self.pedals(torch.cat([motor, own_input], 1))], 1)
        # This scratch module aliases the registered gate parameters. It is not
        # registered or serialized as a second recurrent model, and forward()
        # never uses it; exported ONNX still contains only the basic cell ops.
        gru = self.__dict__.get('_training_gru')
        if gru is None:
            gru = nn.GRU(self.hidden_size, self.traffic_memory_size, batch_first=True).to(observation.device)
            gru.weight_ih_l0, gru.weight_hh_l0 = self.traffic_input_gates.weight, self.traffic_hidden_gates.weight
            gru.bias_ih_l0, gru.bias_hh_l0 = self.traffic_input_gates.bias, self.traffic_hidden_gates.bias
            gru.flatten_parameters()
            self.__dict__['_training_gru'] = gru
        memory = torch.zeros(batch, length, self.traffic_memory_size, device=observation.device)
        uninterrupted = (present == 1).all(1).squeeze(1)
        for is_fresh in [False, True]:
            indices = torch.where(uninterrupted & (fresh.bool() == is_fresh))[0]
            if not indices.numel():
                continue
            inputs = encoded[indices]
            if burn and not is_fresh:
                with torch.no_grad():
                    prefix, initial = gru(inputs[:, :burn])
                suffix, _ = gru(inputs[:, burn:], initial.detach())
                values = torch.cat([prefix, suffix], 1)
            else:
                values, _ = gru(inputs)
            memory = memory.index_copy(0, indices, values)
        mixed = torch.where(~uninterrupted & (present > 0).any(1).squeeze(1))[0]
        if mixed.numel():
            h = torch.zeros(mixed.numel(), self.traffic_memory_size, device=observation.device)
            values = []
            for t in range(length):
                ir, iz, inn = self.traffic_input_gates(encoded[mixed, t]).chunk(3, 1)
                hr, hz, hn = self.traffic_hidden_gates(h).chunk(3, 1)
                reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
                h = ((1 - update) * torch.tanh(inn + reset * hn) + update * h) * present[mixed, t]
                values.append(h)
                if t < burn:
                    h = torch.where(fresh[mixed, None].bool(), h, h.detach())
            memory = memory.index_copy(0, mixed, torch.stack(values, 1))
        inputs = torch.cat([encoded.reshape(-1, self.hidden_size), own_input, memory.reshape(-1, self.traffic_memory_size)], 1)
        correction = self.traffic(inputs) * present.reshape(-1, 1)
        action = torch.cat([(base[:, :1] + .75 * correction[:, :1]).clamp(-1, 1),
                            (base[:, 1:] + correction[:, 1:]).clamp(-1, 1)], 1)
        return action.reshape(batch, length, 2)

    def forward(self, observation, hidden):
        own_input, own, mean, maximum, present = self.features(observation)
        if self.instant:
            # Diagnostic motor actor: current public state alone chooses pedals.
            # Preserve the mailbox's hidden-state shape, but do not claim learned
            # temporal planning or let untrained memory alter physical feedback.
            encoded = torch.cat([own, mean, maximum], 1)
            motor = torch.cat([own, torch.zeros_like(mean), torch.zeros_like(maximum)], 1) if self.traffic_residual else encoded
            action = self.head(motor)
            if self.split_motor:
                longitudinal = self.pedals(torch.cat([motor, own_input], 1))
                action = torch.cat([action[:, :1], longitudinal], 1)
            if self.traffic_residual:
                traffic_inputs = [encoded, own_input]
                next_hidden = hidden
                if self.traffic_memory:
                    ir, iz, inn = self.traffic_input_gates(encoded).chunk(3, 1)
                    hr, hz, hn = self.traffic_hidden_gates(hidden[:, :self.traffic_memory_size]).chunk(3, 1)
                    reset, update = torch.sigmoid(ir + hr), torch.sigmoid(iz + hz)
                    candidate = torch.tanh(inn + reset * hn)
                    memory = ((1 - update) * candidate + update * hidden[:, :self.traffic_memory_size]) * present
                    next_hidden = torch.cat([memory, torch.zeros_like(hidden[:, self.traffic_memory_size:])], 1)
                    traffic_inputs.append(memory)
                correction = self.traffic(torch.cat(traffic_inputs, 1))
                # No deterministic lane or expert command enters this branch.
                # The mask guarantees unchanged clean-air outputs after learning.
                action = torch.cat([(action[:, :1] + .75 * correction[:, :1] * present).clamp(-1, 1),
                                    (action[:, 1:] + correction[:, 1:] * present).clamp(-1, 1)], 1)
                return action, next_hidden
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
        if self.traffic_memory:
            weights = dict(weights)
            weights.update({k: v for k, v in self.state_dict().items()
                            if k.startswith(('traffic_input_gates.', 'traffic_hidden_gates.')) and k not in weights})
            if 'traffic.0.weight' in weights and weights['traffic.0.weight'].shape[1] == self.hidden_size + self.own_size:
                expanded = torch.zeros_like(self.traffic[0].weight)
                expanded[:, :self.hidden_size + self.own_size] = weights['traffic.0.weight']
                weights['traffic.0.weight'] = expanded
        if self.traffic_residual and 'traffic.0.weight' not in weights:
            weights = dict(weights)
            weights.update({k: v for k, v in self.state_dict().items() if k.startswith('traffic.')})
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
