"""Training-only batching of independent traffic intervals.

An empty-traffic observation resets the live cell to zero. Nonempty intervals
can therefore share one packed GRU call without sharing memory with each other.
The outcome trainer can opt in for complete histories with no burn-in.
Exported stepwise inference never uses this helper.
"""
import torch
from torch.nn.utils.rnn import pack_sequence, pad_packed_sequence


def segmented_memory(gru, encoded, present):
    batch, length, _ = encoded.shape
    if present.shape != (batch, length, 1):
        raise ValueError('Traffic presence must match the sequence shape')
    masks = present.detach().to(device='cpu').squeeze(-1).tolist()
    sequences, locations = [], []
    for b, row in enumerate(masks):
        start = None
        for t, value in enumerate(row + [0]):
            if value not in (0, 1):
                raise ValueError('Packed resets require binary traffic presence')
            if value == 1 and start is None:
                start = t
            elif value == 0 and start is not None:
                sequences.append(encoded[b, start:t])
                locations.append((b, start, t))
                start = None
    memory = encoded.new_zeros(batch * length, gru.hidden_size)
    if not sequences:
        return memory.reshape(batch, length, gru.hidden_size)
    packed = pack_sequence(sequences, enforce_sorted=False)
    # Match the exported float32 cell instead of allowing cuDNN to use TF32.
    with torch.backends.cudnn.flags(allow_tf32=False):
        values, _ = gru(packed)
    padded, _ = pad_packed_sequence(values, batch_first=True)
    indices = torch.cat([torch.arange(b * length + start, b * length + end,
                                     device=encoded.device) for b, start, end in locations])
    active = torch.cat([padded[i, :end - start] for i, (_, start, end) in enumerate(locations)])
    return memory.index_copy(0, indices, active).reshape(batch, length, gru.hidden_size)
