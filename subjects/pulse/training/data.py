"""Episode splits and contiguous expert-labelled correction sequences."""
import hashlib
import json
from pathlib import Path
import numpy as np


def episodes(directory, schema, expected_split, corrective=False, optional=False):
    result = []
    for path in sorted(Path(directory).glob('*.jsonl')):
        records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        manifest = records[0]
        if manifest['type'] != 'manifest' or manifest['split'] != expected_split:
            raise ValueError(f'Bad manifest/split: {path.name}')
        mode = manifest['settings']['mode']
        if corrective and mode not in ['policy', 'dagger']:
            raise ValueError('Correction data must contain student-visited states')
        if not corrective and mode not in ['teacher', 'shadow']:
            raise ValueError('Initial cloning cannot train on student execution targets')
        if records[-1]['type'] != 'summary' or records[-1]['minFuel'] < 1 or records[-1].get('endedEarly'):
            raise ValueError(f'Incomplete/fuel-starved episode: {path.name}')
        steps = [r for r in records if r['type'] == 'step']
        if not steps:
            continue
        x = np.array([r['observation']['normalized'] for r in steps], dtype=np.float32)
        if corrective:
            if any(not r.get('teacherControls') for r in steps):
                raise ValueError(f'Correction lacks expert labels: {path.name}')
            y = np.array([[r['teacherControls']['steer'], r['teacherControls']['throttle'] - r['teacherControls']['brake']]
                          for r in steps], dtype=np.float32)
        else:
            y = np.array([r['target'] for r in steps], dtype=np.float32)
        if x.shape != (len(steps), schema['size']) or y.shape != (len(steps), 2) or not np.isfinite(x).all() or not np.isfinite(y).all():
            raise ValueError(f'Invalid numeric data: {path.name}')
        if any(r['observation']['missing'] for r in steps):
            raise ValueError(f'Missing sensors: {path.name}')
        # Never stitch around a damaged/reversed/remote off-road state. The next
        # clean stretch is a new sequence, with burn-in rather than a false reset.
        valid = np.ones(len(steps), dtype=bool)
        if corrective:
            for i, r in enumerate(steps):
                half_width = r['observation']['preview'][0]['halfWidth']
                valid[i] = r['before']['damage'] <= .02 and abs(r['observation']['road']['lateral']) <= half_width + 1
                valid[i] &= r['observation']['raw'][1] >= -1
        starts = np.where(valid & np.r_[True, ~valid[:-1]])[0]
        ends = np.where(valid & np.r_[~valid[1:], True])[0] + 1
        for start, end in zip(starts, ends):
            if end - start < 64:
                continue
            xs, ys = x[start:end].copy(), y[start:end].copy()
            result.append({'manifest': manifest, 'x': xs, 'y': ys, 'path': path.name, 'start_index': int(start),
                           'corrective': corrective, 'fresh': start == 0 and bool(steps[0].get('reset')),
                           'fingerprint': hashlib.sha256(xs.tobytes() + ys.tobytes()).hexdigest()})
    if not result and not optional:
        raise ValueError(f'No complete sequences >=64 steps in {directory}')
    return result


def assert_disjoint(train, validation):
    if {e['manifest']['episodeId'] for e in train} & {e['manifest']['episodeId'] for e in validation}:
        raise ValueError('Episode leakage between training and validation')
    if {e['fingerprint'] for e in train} & {e['fingerprint'] for e in validation}:
        raise ValueError('Identical numeric episodes across splits, even if seeds/names differ')


def windows(data, length, stride, corrective_weight=1):
    return [(i, start) for i, e in enumerate(data)
            for _ in range(corrective_weight if e['corrective'] else 1)
            for start in range(0, len(e['x']) - length + 1, stride)]
