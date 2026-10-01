# Pace and simultaneous battle engineer

Completed 8 September 2026. The private phone address remains:
http://100.103.254.53:4174/?showcase=1

## What changed

The controller now subtracts distance travelled since the last tactical solve when calculating braking targets. Previously, held waypoints retained their original braking distance between solves. The correction handles the start/finish seam and discards restrictions already passed. A regression test compares a held plan with an equivalent fresh plan.

Predictive steering gives a stronger penalty to trajectories approaching the track edge. Recovery now uses separate entry/exit thresholds for the runoff state, preventing centimetres of boundary movement from repeatedly cancelling a reverse manoeuvre. The independent safety supervisor, vehicle forces, grip, track, skill ratings, aggression settings and traffic pace cap remain unchanged.

Broad increases to traffic pace and an earlier edge-braking experiment were rejected after long-race regressions. They are not in the final build. The new observed-space summary feeds the engineer view; it is not a claim of a new trained policy or privileged access to rival controls.

## Engineer and world display

- Front/attack and rear/defence cards appear together, with observed gap and closing speed.
- A track-relative proximity diagram shows the observed car, surrounding footprints, selected path and distinct front/rear alternatives.
- A rival table shows both gaps, closing times and predicted exit positions. Another table compares the selected path's front cost, rear cost and exit speed with the two objective-specific alternatives.
- World forecasts use cyan for front rivals and orange for rear rivals. Alongside footprints are coral. Green is the path actually being driven. Cyan dashed and orange dotted paths show the lowest-cost feasible front-progress and rear-protection candidates when they differ from the selected path; these are alternatives, not simultaneous steering commands. Unsafe candidates are excluded from these objective highlights.
- A compact legend and both contexts remain visible with the panel closed in showcase mode. Battle paths are the default to reduce clutter. **Show all debug paths** restores the candidate cloud, rejected paths, response branches, lane checks and control rollouts.
- All previous metrics remain under **Vehicle, pace & solver telemetry**. Freeze paths leaves telemetry live. Recovery, manual control and inactive drivers clear obsolete tactical readouts.

Closing time assumes current relative speed and uses bumper clearance. Side-space readings cover neighbours within 12 m. Clear space is not a guarantee that changing lanes is safe. Exit positions and objective costs remain model estimates.

## Exact phone showcase comparison

Same default six cars, three laps, 72% aggression, dry track and race objective; fixed 120 Hz simulation. Baseline saved before this task in `artifacts/pace-awareness-baseline/src/sim`.

| Red ASTRA result | Before | Final |
|---|---:|---:|
| Race time | 257.567 s | 253.125 s |
| Finish position | 4th | 3rd |
| Best lap | 82.317 s | 82.408 s |
| Damage | 0.02065 | 0 |
| Off-track time | 0 | 0 |
| Whole-field severe contacts | 2 | 0 |

The race improves by **4.442 seconds**, but the best lap is **0.092 seconds slower**. This does not beat the user's approximately 1:22.3 best lap. Whole-field off-track time is 0.20 seconds in the final showcase, with zero field damage.

## Additional checks

Both original eight-car, 240-second contracts pass without relaxed thresholds:

| Measure | Normal final | Fierce final |
|---|---:|---:|
| Clean passes | 14 | 27 |
| Clean retained passes | 13 | 25 |
| Severe contacts | 0 | 0 |
| Off-track vehicle seconds | 0 | 0.42 |
| Total damage | 0.028 | 0.020 |
| Field spread | 409.0 m | 595.1 m |
| Red best lap | 82.742 s | 82.608 s |

The previous red best laps in these tests were 83.025 s and 84.167 s. Normal-race red progress decreases from 8447.8 m to 8398.0 m despite the faster best lap; fierce progress improves from 8338.2 m to 8541.8 m. Results are mixed rather than a universal gain in every battle.

Six-lap solo time improves from 492.601 s to 491.533 s (1.068 s), with zero damage and off-track time. Best flying lap changes from 76.967 s to 76.983 s; peak tyre core temperature changes from 125.1°C to 126.0°C. The three short pack scenarios pass their existing progress, gap, track-limit and damage checks, but do not all gain distance versus the prior build.

All **66 unit/integration tests**, the pack contract, exact showcase check, both field contracts and the production build pass. Browser QA covers both simultaneous contexts with the panel closed, detailed telemetry, the all-paths control and portrait/desktop layouts. No browser warnings or errors were observed. The build retains the existing bundle-size advisory; phone performance depends on the device.

## Reproduce and evidence

```powershell
npm test
npm run test:pack
npm run test:showcase
npm run test:racecraft
npm run test:racecraft:fierce
npm run build
```

Evidence is in `artifacts/awareness-tests.txt`, `awareness-pack.json`, `awareness-normal.json`, `awareness-fierce.json`, `showcase-awareness-before.json`, `showcase-awareness-after.json`, `awareness-six-before.json`, and `awareness-six-after.json`. `tests/showcase-quality.mjs` imports the actual default showcase options; `SIM_ROOT` selects the archived simulation for comparison. Fixed scenarios do not establish performance across every weather condition, grid or session duration.
