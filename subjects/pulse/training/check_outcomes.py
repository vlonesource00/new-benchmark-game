"""Admission checks for the independent outcome-training path."""
import json
import tempfile
from pathlib import Path
from outcome_data import outcome_episodes, assert_outcome_disjoint, physical_family
from data import assert_disjoint

checks = []
schema = {'size': 4}


def records():
    m = {'type': 'manifest', 'split': 'train', 'trainingOnly': True, 'outcomeTraining': True,
         'labelSource': 'selected-policy-proposal; teacherControls are ignored', 'episodeId': 'family-a',
         'settings': {'mode': 'policy', 'seconds': 2},
         'outcome': {'familyId': 'family-a', 'candidate': {'label': 'sampled-control'},
                     'selected': {'admissible': True, 'costSeconds': 9},
                     'baseline': {'admissible': True, 'costSeconds': 10}, 'gainSeconds': 1}}
    rows = [{'type': 'step', 'reset': i == 0, 'legalTrackLimit': 9, 'actionSource': 'pulse-two-rate-policy',
             'before': {'damage': 0, 'lateral': 0}, 'post': {'damage': 0},
             'observation': {'normalized': [0, 0, 0, 0], 'missing': []},
             'outcomeTarget': [.02, .8], 'teacherControls': {'steer': -.9, 'throttle': 0, 'brake': 1}} for i in range(120)]
    s = {'type': 'summary', 'seconds': 2, 'endedEarly': False, 'dq': False, 'minFuel': 50,
         'trackLimitSeconds': 0, 'severe': 0, 'expertRows': 0, 'expertActuatorRows': 0, 'missingRows': 0, 'cumulativeDamage': 0}
    return [m, *rows, s]


def load(rs, duplicate=False):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / 'episode.jsonl'
        path.write_text('\n'.join(json.dumps(r) for r in rs))
        if duplicate:
            (Path(d) / 'other.jsonl').write_text(path.read_text())
        return outcome_episodes(d, schema, 'train')


def reject(name, change):
    rs = records(); change(rs)
    try:
        load(rs)
    except ValueError:
        checks.append(name); return
    raise AssertionError(name + ' was accepted')


e = load(records())[0]
assert abs(float(e['y'][0, 0]) - .02) < 1e-6 and abs(float(e['y'][0, 1]) - .8) < 1e-6
checks.append('winner proposals supply targets, opposing expert commands are ignored')
reject('legacy imitation cannot be silently reclassified', lambda r: r[0].update(outcomeTraining=False))
reject('unchanged baseline cannot be called new behavior', lambda r: r[0]['outcome']['candidate'].update(label='baseline'))
reject('small or fictitious gains cannot train', lambda r: r[0]['outcome'].update(gainSeconds=.01))
reject('false admissibility cannot hide trajectory damage', lambda r: r[1]['post'].update(damage=.1))
reject('assisted winner cannot train', lambda r: r[-1].update(expertActuatorRows=1))
reject('assisted rows cannot train even with false clean summary', lambda r: r[1].update(actionSource='training-expert'))
reject('illegal row cannot hide behind a clean summary', lambda r: r[1]['before'].update(lateral=10))
reject('nonfinite neural targets cannot train', lambda r: r[1].update(outcomeTarget=[float('nan'), 0]))
reject('out of range neural targets cannot train', lambda r: r[1].update(outcomeTarget=[2, 0]))
try:
    load(records(), duplicate=True)
    raise AssertionError('duplicate family accepted')
except ValueError:
    checks.append('one coherent winner per physical family')
try:
    assert_disjoint([e], [{**e, 'manifest': {**e['manifest'], 'split': 'validation'}}])
    raise AssertionError('family leakage accepted')
except ValueError:
    checks.append('physical family cannot leak across train and validation')
other = {**e, 'manifest': {**e['manifest'], 'episodeId': 'different-id', 'settings': {
    **e['manifest']['settings'], 'seconds': 3, 'rate': 30, 'lagMs': 17}}, 'fingerprint': 'different-labels'}
assert physical_family(e['manifest']) == physical_family(other['manifest'])
checks.append('duration and reply timing do not create a new physical family')
try:
    assert_outcome_disjoint([e], [other])
    raise AssertionError('schedule/duration leakage accepted')
except ValueError:
    checks.append('same encounter cannot validate itself with different labels or scheduling')
distinct = {**other, 'manifest': {**other['manifest'], 'settings': {**other['manifest']['settings'], 'seed': 23}}}
assert_outcome_disjoint([e], [distinct])
checks.append('physically different encounter remains an allowed holdout')
defaults = {**e['manifest'], 'settings': {**e['manifest']['settings'], 'tailGapDelta': 0, 'tailSpeed': None}}
assert physical_family(defaults) == physical_family(e['manifest'])
checks.append('explicit tail defaults do not manufacture holdout independence')
print(json.dumps({'passed': len(checks), 'checks': checks}))
