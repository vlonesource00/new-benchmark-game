"""Load admitted simulation winners. Expert commands are never these targets."""
import hashlib
import json
from pathlib import Path
import numpy as np
from data import light_rub_prefix
from data import assert_disjoint


def physical_family(manifest):
    # Longer/shorter recordings or a different inference schedule must not turn
    # the same initial encounter into an independent validation family.
    scheduling = {'seconds', 'rate', 'motorRate', 'lagMs', 'stallMs', 'stallAt',
                  'spikeMs', 'spikeAt', 'fastMotor', 'mode', 'observationVersion', 'expertDriver'}
    physical = {k: v for k, v in manifest['settings'].items() if k not in scheduling}
    # Explicit defaults introduced by the tail-arrival fixture do not create
    # a new scene or an independent holdout for legacy recordings.
    for key, default in [('tailGapDelta', 0), ('tailSpeed', None)]:
        if physical.get(key, default) == default:
            physical.pop(key, None)
    return json.dumps(physical, sort_keys=True)


def assert_outcome_disjoint(train, validation):
    assert_disjoint(train, validation)
    if {physical_family(e['manifest']) for e in train} & {physical_family(e['manifest']) for e in validation}:
        raise ValueError('Same physical encounter across outcome splits')


def outcome_episodes(directory, schema, split):
    result = []
    for path in sorted(Path(directory).glob('*.jsonl')):
        records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        m, s = records[0], records[-1]
        selected, baseline = m.get('outcome', {}).get('selected', {}), m.get('outcome', {}).get('baseline', {})
        if (m.get('type') != 'manifest' or m.get('split') != split or not m.get('trainingOnly')
                or not m.get('outcomeTraining') or m.get('neverTraining') or m.get('labelSource') != 'selected-policy-proposal; teacherControls are ignored'
                or m.get('settings', {}).get('mode') != 'policy' or m.get('episodeId') != m.get('outcome', {}).get('familyId')):
            raise ValueError('Not an admitted outcome family: ' + path.name)
        if not selected.get('admissible') or not np.isfinite(selected.get('costSeconds', float('nan'))):
            raise ValueError('Selected trial did not pass the outcome gate')
        if m['outcome']['candidate']['label'] == 'baseline':
            raise ValueError('An unchanged policy is not an improvement label')
        gain = m['outcome'].get('gainSeconds')
        if baseline.get('admissible'):
            measured = baseline['costSeconds'] - selected['costSeconds']
            if gain is None or not np.isfinite(gain) or abs(gain - measured) > 1e-7 or gain < .05:
                raise ValueError('No meaningful measured improvement')
        elif gain is not None:
            raise ValueError('Failed baselines have no numeric advantage')
        if (s.get('type') != 'summary' or s.get('endedEarly') or s.get('dq') or s.get('minFuel', 0) < 1
                or s.get('seconds', 0) < m['settings']['seconds'] - 1e-6
                or any(s.get(k, 1) for k in ['trackLimitSeconds', 'severe', 'expertRows', 'expertActuatorRows', 'missingRows'])
                or not 0 <= s.get('cumulativeDamage', 1) <= .03):
            raise ValueError('Incomplete, unsafe or assisted winner')
        steps = [r for r in records if r['type'] == 'step']
        if len(steps) < 64 or light_rub_prefix(steps) != len(steps):
            raise ValueError('Damage, repair or rescue in selected trajectory')
        for r in steps:
            if (r.get('actionSource') not in ['pulse-policy', 'pulse-two-rate-policy']
                    or r['observation'].get('missing') or not np.isfinite(r.get('legalTrackLimit', float('nan')))
                    or abs(r['before']['lateral']) > r['legalTrackLimit']):
                raise ValueError('Invalid control source, sensors or legality')
        x = np.asarray([r['observation']['normalized'] for r in steps], dtype=np.float32)
        y = np.asarray([r['outcomeTarget'] for r in steps], dtype=np.float32)
        if x.shape != (len(steps), schema['size']) or y.shape != (len(steps), 2) or not np.isfinite(x).all() or not np.isfinite(y).all() or (np.abs(y) > 1).any():
            raise ValueError('Invalid outcome inputs/targets')
        # One winner per physical family. Opposite sampled controls at the same
        # state are not averaged into an unexecutable compromise.
        result.append({'manifest': m, 'x': x, 'y': y, 'path': path.name, 'start_index': 0,
                       'corrective': False, 'fresh': bool(steps[0].get('reset')),
                       'weight': 1 + min(4, int(max(0, gain or 0) / .25)),
                       'fingerprint': hashlib.sha256(x.tobytes() + y.tobytes()).hexdigest(),
                       'fileDigest': hashlib.sha256(path.read_bytes()).hexdigest()})
    if not result:
        raise ValueError('No admitted simulation winners in ' + str(directory))
    families = [e['manifest']['episodeId'] for e in result]
    if len(families) != len(set(families)):
        raise ValueError('Conflicting winners from the same physical family')
    initial_states = [physical_family(e['manifest']) for e in result]
    if len(initial_states) != len(set(initial_states)):
        raise ValueError('Same physical encounter with different durations/schedules')
    return result
