# Attack, defence and sustained pace — 9 September 2026

The current v1.1 driving baseline remains the release behaviour. Faster experimental lap times did not consistently translate into better whole-field racing. The accepted changes improve threat explanations and diagnostics; they do not claim a pace gain.

## Delivered

- Rear awareness distinguishes the nearest pursuer from the car with the shortest current-speed time to overlap. It checks every intervening rear car before describing a separate attacking lane.
- The race engineer retains the nearest rear car, adds a distinct closing threat to its forecast table, and explains front and rear objectives together. Warnings remain separate from the actual committed target.
- The orange on-track rear forecast follows the closing threat when present. Existing selected, candidate, rejected, front-progress and rear-protection paths remain available.
- `node tests/chase-benchmark.mjs --check` adds a reproducible 60-second equal-skill chase diagnostic, with `SIM_ROOT` support for comparing source snapshots.

## Controlled findings

These are deterministic headless fixtures, not direct comparisons with the phone screenshot. All experiments used the same underlying vehicle physics. Outside-track figures below aggregate vehicle-seconds across the field, counting the car centre beyond the track edge (less than half the car inside).

| Experiment | Benefit observed | Reason not released |
| --- | --- | --- |
| Cover a faster second pursuer when it has a separate lane | Six-car race P2, 4:05.767, best 1:18.700; red car stayed within track limits | Other cars accumulated 15.43 seconds outside the limit, despite both eight-car checks passing |
| Release more pace calibration when traffic is distant | Equal-skill chase gained 17.68 metres over 60 seconds and reduced braking | Eight-car normal field accumulated 10.44 seconds outside the limit and spread widened to 712.4 metres |
| Include alongside cars continuously in front/rear exit scoring | Some six-car runs were faster | Repeated whole-field excursions; scoring changes exposed insufficient control robustness |
| Align braking prediction and commanded brake authority | Identified a calibration question worth testing | First implementation worsened close-racing fixtures and produced a severe contact; reverted |

The retained chase baseline begins 80 metres behind and ends 175.74 metres behind after 60 seconds, despite equal nominal driver skill. The follower travels 2036.51 metres, brakes for 14.125 seconds, and has zero off-track time, damage or severe contacts. This demonstrates sustained chase loss in this fixture; it does not isolate one cause by itself.

## Highest-value next engineering work

1. **Traffic-dependent pace calibration.** The current traffic state reduces the pace-limit blend to 0.45 and control blend to 0.35. Replace the broad release experiment with segment-level evidence: record target speed, braking cause, tracking error and grip use for leader and follower at matched track positions. Release only the limitation actually responsible for lost pace.
2. **Finish passes through the exit.** `packExitCost` currently excludes cars within five metres longitudinally. Existing collision and overlap handling still apply, but this exit-scoring term loses the alongside rival. Add a physically feasible continuation comparison through the next corner exit before altering weights; the attempted continuous weighting alone was insufficient.
3. **Defend against multiple pursuers without disruptive lane changes.** Awareness can now reveal a faster second car, but choosing it as the target needs a reachable corridor and a prediction of the intervening car's movement. The observed separate lane is useful evidence, not a guaranteed route.
4. **Validate braking and steering predictions against actual motion.** Log predicted versus realised speed, yaw and lateral position over the control horizon. Use this to explain why modest tactical changes sometimes create track-limit excursions before increasing aggression further.

A release candidate must preserve full candidate/rejected visualisation and pass the existing pack, flow, default six-car showcase and both eight-car quality checks. A faster red-car lap alone is insufficient. Keep main as the original baseline and development on v1.1.

## Validation of this diagnostics update

80 unit tests, the three pack fixtures, the new chase check and the default six-car showcase check pass. The final showcase matches the retained driving baseline: P4, 4:12.258, best 1:22.525, zero whole-field off-track time, damage and severe contacts. The production build succeeds with the existing bundle-size warning. A narrow browser preview renders the simultaneous cards, paths and forecast table without browser warnings or errors. No experimental controller or target-selection changes are included.
