# Harbor handling follow-up

**Historical experiment, reverted at the user's request.** The active controller and tactical scoring now use v1.1 behaviour, with only track-width and class-specification compatibility adaptations. The custom Harbor entry arc, feedback rollout changes and subsequent experimental grip/scheduling/value-function work are not active. Results below describe the rejected version, not the current build.

The 2026-09-09 follow-up addresses delayed path corrections and the exaggerated Turn 1 zigzag. Harbor rollouts now recalculate feedback steering from each predicted pose instead of holding one steering aim for 0.66 seconds. Their progress uses forward velocity projected onto the track rather than total sliding speed. A longer steering preview and bounded gradual cross-track correction avoid the unstable short-lookahead experiment.

This calibration is enabled on Harbor only. Applying it universally regressed Solenne's existing six/ten-lap tests; Solenne retains its established controller arithmetic. All 87 unit tests pass with that separation.

The unchanged Harbor road has a real S kink at approximately 860–885 metres. The old optimized line amplified it with a sharp offset reversal. A continuous-tangent entry arc now stays inside the authored asphalt, with blended entry/exit offsets. The minimum planned GT speed across that section rises from 54 to about 63 km/h. Full throttle throughout is not supported by this geometry and tyre model. No road control points, grip or engine forces were changed.

Measured against the pinned source `3b40de313dab8a740cd1afa75b96b0451e01ef6c`, using the same one-lap GT launch:

| Measurement | Before | After |
| --- | ---: | ---: |
| Session time, seconds | 95.617 | 93.083 |
| Braking above 40% with path error above 0.5 m, seconds | 5.825 | 5.483 |
| RMS lateral path error, metres | 0.913 | 0.969 |
| Peak lateral path error, metres | 2.691 | 2.920 |
| Braking while body slip exceeds 0.2 radians, seconds | 0 | 0 |
| Off-track time / damage | 0 / 0 | 0 / 0 |

Pace improves by 2.53 seconds, but average and peak tracking error do not improve. This is a partial correction of the behaviour, not proof that tracking is solved. Steering variation also rises from 27.03 to 33.33 in this diagnostic. The three-lap mixed run finishes in 275.750 seconds (previous 280.708), best GT lap 86.242, with zero aggregate off-track time, damage or severe contacts. All three classes pass isolated Harbor quality checks.

Reproduce with `node tests/tracking-quality.mjs --check`, adding `--mixed` for traffic or `--source=../benchmark/subjects/astra` to inspect an explicitly pinned older source. Braking-with-error is a correlation metric; it does not prove every recorded brake application was caused by tracking error.
