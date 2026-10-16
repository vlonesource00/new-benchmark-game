# VANGUARD combat review — 17 October 2026

## Assessment

My engineering assessment is **7/10 as an architecture to build on, about 4/10 for attacking competitive rivals today**. These are judgments, not benchmark scores. Keep Argon's split between a fast local force controller and a slower spatial corridor planner. The weak link is the tactical prediction and decision layer; a new learning system or wholesale controller replacement is not justified by these tests.

VANGUARD is competitive with INTERCEPT for cleanliness in the prepared encounters. It safely handles clear backmarker opportunities, but does not demonstrate a same-class passing advantage. Calling it the strongest combat racer would be unsupported.

## Benchmark contract

`tools/combat-bench.mjs` runs real game races and the actual async-seat protocol at a deterministic 60 fps. Each case has its own process; children run sequentially at below-normal priority. No GPU, training, background queue or simultaneous simulation jobs are required.

The 14 scenes cover Harbor Ring and Solenne:

- Four equal-class opportunities, two initial momentum advantages and two worn-tyre opponents, all GT3.
- Two LMDh-versus-GT3 backmarker opportunities, scored separately from competitive passing.
- Two defensive starts and two following/braking disturbances.

The initial position, heading, gearbox, fuel and tyre state are matched across candidates. A common GT reference sets the fixtures. Before the paired encounters, each opposing car must survive its exact starting state alone. The report records actual initial conditions, source hashes, harness hash, revision and source changes during the run.

Scoring is independent of each driver's claimed attacks/passes. A clean pass requires four continuous seconds fully ahead at the finish, a body-clear longitudinal gap, no game contact, no geometric touching, no damage, no off-track time, no reset/teleport and no failed opponent. Defence and following also require useful forward progress. Hazard avoidance is not credited as an overtake. Trace records copy debug state at capture time so later mutations cannot rewrite the evidence.

These are short, prepared encounters, **not an overall championship ranking**. In particular, APEX performs poorly from these shared mid-lap starts; that must not be generalised to its normal-start solo pace. Seed changes produce only small variation in these deterministic dry fixtures. A shifted-start confirmation is more useful than treating repeated seeds as independent evidence.

## Results

The final common-code comparison is `results/combat-release-2026-10-17.json`. Large reports and traces remain local and are ignored by Git.

| Driver | Clean encounters / 14 | Clean same-class passes / 8 | Clean backmarker passes / 2 | Clean defence / 2 | Clean braking / 2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| VANGUARD | 13 | 0 | 2 | 1 | 2 |
| INTERCEPT | 13 | 0 | 2 | 1 | 2 |
| TEMPEST | 12 | 0 | 1 | 1 | 2 |
| RAZOR | 7 | 0 | 2 | 1 | 1 |
| APEX | 0 | 0 | 0 | 0 | 0 |

The first eight same-class scenes have a floor effect: nobody achieves a retained clean pass. RAZOR achieves one physically retained but dirty pass. VANGUARD's single contact failure is the Harbor defensive encounter; the rear car closes and the routes squeeze together. Its clean traffic and braking performance does not resolve this failure.

The initial baseline and additional backmarker reports are `combat-baseline-2026-10-17.json` and `combat-backmarkers-2026-10-17.json`. The broader `combat-final-2026-10-17.json` report contains an intermediate defensive experiment and is **superseded for release assessment**.

The shifted-start confirmation (`combat-confirm-2026-10-17.json`, seed 19, every start moved 8 m) gives VANGUARD the same 13/14 clean encounters, 2/2 backmarker passes, 0/8 same-class passes, 1/2 defences and 2/2 braking cases. Both this report and the final comparison have healthy solo rival controls, zero bridge errors and no recorded source changes during execution. The harness hashes source dependencies and setup as well as driver code; later records also cover rival/config/data and worker-shim dependencies when only one candidate is selected.

### Normal-start race check

Both three-lap races start VANGUARD fifth, behind INTERCEPT, RAZOR, APEX and TEMPEST. They use seed 7, warm soft tyres, standing starts and no pit decisions. These are two spot checks with a fixed grid, not a balanced championship.

| Driver | Harbor GT3 finish | Solenne LMDh finish |
| --- | ---: | ---: |
| INTERCEPT | 1 | 1 |
| RAZOR | 3 | 2 |
| APEX | 4 | 4 |
| TEMPEST | 2 | 5 |
| VANGUARD | 5 | 3 |

VANGUARD records three legal laps in each race, zero damage and zero errors. Its best laps are 62.533 s at Harbor and 50.208 s at Solenne, versus INTERCEPT's 61.567 s and 49.850 s. It records no retained passes at Harbor and two at Solenne; the entire Solenne race is contact-free. Harbor has one contact between other cars. Reports: `combat-harbor-race-2026-10-17.json` and `combat-solenne-race-2026-10-17.json`.

APEX also completes all six laps cleanly without damage. This confirms that its prepared-start failures should be reported as a recovery/fixture limitation rather than a claim that it cannot race. VANGUARD can overtake in a normal race; producing that behaviour consistently is the unresolved problem.

### Forecast calibration

An accepted-code trace of the failed Harbor worn-traffic case shows why prediction deserves attention. Comparing the rival's forecasts with its actual subsequent trajectory, interpolated to the exact forecast time:

| Forecast ahead | Samples | Mean absolute road error | 90th-percentile road error | Mean absolute speed error |
| --- | ---: | ---: | ---: | ---: |
| 0.5 s | 230 | 0.368 m | 0.940 m | 1.291 m/s |
| 1.5 s | 221 | 2.490 m | 5.190 m | 2.546 m/s |

These overlapping samples are from one closed-loop encounter, not independent trials or a universal forecast accuracy estimate. The error can include model approximation and the opponent's reaction. It does not by itself establish which component causes every failed pass. It does show that lengthening a rollout does not automatically make it a trustworthy look ahead.

Reproduce with `tools/forecast-audit.mjs` and `results/combat-forecast-accepted-2026-10-17-vanguard-harbor-worn-traffic-7-trace.json`. The tool records the trace hash and handles both time interpolation and track-coordinate wrapping.

## Changes retained

1. **Gearbox history in tactical rollouts.** A simulated shift now persists into the next simulated step. Previously every step restarted from the real car's original gear, unlike the rival forecast. The CPU regression fails on the old implementation and passes on the corrected one; planning does not alter the live gearbox. The matched combat screen does not establish a passing gain from this fix.
2. **Defensive clearance timer.** A nearby closing car behind a defending car no longer advances the normal completed-overtake timer in `Battle.progress`. Path feasibility and the existing return checks still apply; this is not a complete new defensive planner.
3. **Return-reason visibility.** Debug traces show why a route returned or aborted, instead of exposing only the final intent name.
4. **Controlled horizon diagnostic.** `combatHorizon` can extend tactical evaluation without freezing the rival at the old 3.5-second forecast boundary. The default remains 3.4 seconds. A 5.5-second comparison and extended 40-second encounters did not produce a clean same-class pass, so the longer horizon is not enabled by default.
5. **Permanent benchmark checks.** Tests reject brief overlap, a place lost again, zero-impulse rubbing, opponent failures, invalid telemetry and parking as ways to win the score.

## Changes rejected

- Earlier partial passing setup and a two-stage offset route failed to improve clean-pass conversion in the momentum/worn-traffic cases.
- Looking much farther ahead for a defensive corner increased contact in Harbor rather than fixing the squeeze.
- Holding the defensive corridor more aggressively regressed the existing delayed-reply passing check. That extension was removed, and the passing and traffic suites pass again.
- Tighter default clearance and a blanket aggression increase remain rejected by the earlier paired race investigation in `RESULTS.md`.

There is **no demonstrated same-class combat breakthrough in this continuation**. Correctness fixes and rejected regressions are useful, but are not substitutes for a higher clean-pass score.

## Next architectural work, in priority order

1. **Make tactical forecasts respond to an occupied lane.** The present rival model largely forecasts each car independently along its reference route. Compare bounded alternatives based on public state: continue, brake/follow, or hold an established side. Do not assume that an opponent will yield, and do not use its private intent. Validate closest-approach predictions against real-game traces before changing acceptance thresholds. A bounded second-stage replay of the best one or two candidates with private `Vehicle.step` clones is worth testing; keep the existing cheap ranking stage and measure its CPU cost.
2. **Plan an advantage through a corner, not only a completed pass inside one short rollout.** Give setup, overlap, exit advantage, retention and a safe fallback explicit acceptance conditions. Retain the C2 corridor mechanism and candidate budget. Increasing the horizon alone has already failed this test.
3. **Separate defensive ownership from passing completion throughout replanning.** The timer correction is only one part. A new defensive rule must improve Harbor's squeeze without breaking the delayed pass, legal returns or the other retained-pass cases.
4. **Expand evaluation before claiming a winner.** Add shifted starts, more corners and tracks, normal-start races and rotated grids. Preserve equal-class, backmarker, following and defence scores separately. Test clean retained positions after the next corner and at the finish.
5. **Keep a fixed compute budget.** Continue short sequential CPU tests. Profile candidate evaluation and only spend more simulation time on hypotheses that improve a matched encounter without losing clean passing or reliability.

The near-term acceptance target is a new clean same-class pass on a currently failed encounter, retained through the next corner, with no loss on the existing traffic, latency and solo reliability gates. Strategy and endurance features should not be used as evidence that this attacking problem is solved.

## Reproduction

```powershell
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-metrics-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/rollout-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/defence-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --tag combat-local
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --drivers vanguard --seeds 19 --station-offset 8 --tag combat-shifted
```

All existing contract, mixed-grid, encounter and traffic checks must still pass. The earlier 90-lap solo matrix remains evidence for the previous pace implementation, not a newly rerun matrix on this combat revision.

Validation completed: all nine existing check groups and the three new combat,
rollout and defensive-state groups pass; the forecast audit reproduces the table
above. The production build passes, with its existing large-bundle warning.
The broader defensive extension was removed before the final passing, traffic,
common-code comparison, shifted-start confirmation and normal-start race checks.
