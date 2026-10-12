"""JSON decoding for PPO updates, run in worker processes (imports no torch)."""
import json
from pathlib import Path
import numpy as np


def parse_rollout(file):
    # Runs in a worker process: JSON decoding is the CPU-bound part of an update.
    lines = [json.loads(l) for l in Path(file).read_text().splitlines() if l.strip()]
    head, steps, summary = lines[0], [l for l in lines if l['type'] == 'step'], lines[-1]
    return head, summary, {k: np.array([s[k] for s in steps], dtype=np.float32) for k in
                           ('observation', 'action', 'raw', 'fresh', 'time', 'progress', 'damage', 'lateral', 'steer')}


def parse_targets(file, stride):
    rows = [json.loads(l) for l in Path(file).read_text().splitlines()[1:] if l.strip()][::stride]
    return np.array([r['observation'] for r in rows], dtype=np.float32), np.array([r['target'] for r in rows], dtype=np.float32)
