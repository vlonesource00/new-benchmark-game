"""Admission checks for the independent outcome-training path."""
import json
import tempfile
from pathlib import Path
from outcome_data import outcome_episodes, assert_outcome_disjoint, physical_family, accepted_request_rows
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


def seat_records():
    rs = records()
    rs[0]['settings']['transport'] = 'seat-frame'
    rs[0]['requestHistory'] = 'accepted-seat-requests-v1'
    rs[0]['settings']['seconds'] = rs[-1]['seconds'] = 4
    rows = []
    for i in range(240):
        r = json.loads(json.dumps(rs[1]))
        r['reset'], r['time'], r['inFlight'] = i == 0, i / 60, i % 2 == 1
        r['acceptedBefore'] = r['acceptedSequence'] = (i + 1) // 2
        if i % 2:
            r['request'] = None
            r['outcomeTarget'] = None
        else:
            r['request'] = {'seq': i // 2 + 1, 'base': i // 2, 'at': i / 60, 'dt': 1 / 30}
        rows.append(r)
    return [rs[0], *rows, rs[-1]]


seat = load(seat_records())[0]
assert len(seat['x']) == 120 and seat['recordedFrames'] == 240 and seat['fresh']
checks.append('busy frames do not advance the learned recurrent state')
rs = seat_records()
rs[2]['acceptedBefore'] = rs[2]['acceptedSequence'] = 0
rs[3]['acceptedBefore'] = rs[3]['acceptedSequence'] = rs[3]['request']['base'] = 0
seat = load(rs)[0]
assert len(seat['x']) == 119 and seat['fresh']
checks.append('rejected first reply is omitted; the next accepted request still starts at zero memory')
rs = seat_records(); rs[3]['request']['base'] = 0
try:
    load(rs)
    raise AssertionError('incorrect parent accepted')
except ValueError:
    checks.append('false request ancestry is rejected')
rs = seat_records(); rs[2]['outcomeTarget'] = [0, 1]
try:
    load(rs)
    raise AssertionError('busy-frame target accepted')
except ValueError:
    checks.append('a frame without inference cannot supply a neural target')
rs = seat_records(); del rs[0]['requestHistory']
try:
    load(rs)
    raise AssertionError('undeclared timing contract accepted')
except ValueError:
    checks.append('seat data cannot silently fall back to a frame-by-frame unroll')
same_scene = {**e['manifest'], 'settings': {**e['manifest']['settings'], 'transport': 'seat-frame',
    'frameSteps': 4, 'lagFrames': 2, 'frameJitter': 2, 'lagJitter': 1, 'replyServiceMs': 0, 'scheduleSeed': 43}}
assert physical_family(same_scene) == physical_family(e['manifest'])
checks.append('frame cadence, lag and schedule seeds cannot manufacture holdout independence')
print(json.dumps({'passed': len(checks), 'checks': checks}))
