"""Convert a v1-contract checkpoint to v2 (learner/contract.py). Writes a new file; never overwrites.
  python learner/migrate.py runs/tt-e2/snap-30-ema.pt runs/tt-e2/snap-30-ema-v2.pt
"""
import os
import sys

import torch

from contract import layout_of, migrate_v1_v2
from model import Slipstream
from ppo import SUBJECT

src, dst = (os.path.join(SUBJECT, p) for p in sys.argv[1:3])
assert not os.path.exists(dst), f'{dst} exists'
ck = torch.load(src, map_location='cpu', weights_only=False)
torch.save(migrate_v1_v2(ck, [n for n, _ in Slipstream(layout_of(ck)).named_parameters()]), dst)
print('wrote', dst)
