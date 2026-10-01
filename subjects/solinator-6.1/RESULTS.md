# solinator 6.1 — current Benchmark results

30 September 2026. The current field is **Gemini Supreme v4, PHANTOM, VORTEX, DeepSeek NOVA, Astra and solinator 6.1**. The earlier five-position campaign used Supreme 3.2 and omitted PHANTOM; its wins do not rank this field.

**Best valid solo lap: 1:10.042.** The new four-lap calibration is 0.650 s faster on its best lap and 4.100 s faster on its fourth lap than the previous solinator calibration. solinator finished third in both current six-car tests. PHANTOM and Supreme v4 remain faster. Eight-lap fade and front-grid combat reliability are still unresolved.

## What changed

The controller retains its independent Cartesian gate-arrival representation. Gaussian world-space gate displacements were optimized using complete physical stints, with time, validity, rear heat and fade in the objective. No rival racing line, ghost, controller or oracle is imported. See [physical-gate-learning.json](results/physical-gate-learning.json) and [ARCHITECTURE.md](ARCHITECTURE.md).

Execution now uses the host torque curve and gearbox, acceleration feedforward and a live weakest-axle speed envelope. Physical transfer expansion handles passing, defence and return maneuvers; a visible but uncatchable car no longer prompts gratuitous free-air port changes. A failed transfer is ranked by a physical escape prefix rather than nominal progress from one failed tick. Road and spin constraints reject unstable alternatives, and escape braking survives the opponent leaving observation.

All five existing rivals retain their default grid positions; solinator is appended sixth and selected by the camera. Benchmark registration, telemetry, result classification, default mode and both desktop/compact labels include all six. The native solinator controller uses Benchmark's existing worker transport. Every host force step still uses the shared 120 Hz solver, GT setup, track and tyre law. Rival source trees and physical source files were not edited.

## Identical solo protocol

Fresh Harbor Ring, GT, wing 6, fuel 35, TC 3, ABS 4, pressure 1.65, 120 Hz physical integration. Timed lap one starts at the official first crossing; raw finish time also includes the grid launch. Browser timing may include that launch in its displayed opening lap, so compare best laps or raw finishes consistently.

| Controller / version | Lap 1 (s) | Lap 2 | Lap 3 | Lap 4 | Valid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous solinator calibration | 70.917 | 70.692 | 72.842 | 77.508 | 4/4 |
| Current solinator 6.1 | 70.217 | 70.042 | 70.683 | 73.408 | 4/4 |
| Gemini Supreme v4 | 68.367 | 67.950 | 68.583 | 70.425 | 4/4 |
| PHANTOM | 66.800 | 66.692 | 67.892 | 70.025 | 4/4 |

Current solinator's raw four-lap finish is **292.800 s**, with zero offtrack, damage or controller errors. Its sum of timed laps improves by 7.608 s over the earlier calibration. This clears the original <=73.000 s valid-lap objective; it does not beat the current two fastest competitors.

Sources: [current-four-lap-solo.json](results/current-four-lap-solo.json), [current-competitor-solo-baselines.json](results/current-competitor-solo-baselines.json). The old calibration values are retained in the historical results below.

## Current six-car tests

Both starting orders retain every current rival. These are two four-lap runs, not an exhaustive grid campaign.

| Controller | Rear-start test: position | Raw finish (s) | Front-start test: position | Raw finish (s) |
| --- | ---: | ---: | ---: | ---: |
| PHANTOM | 1 | 283.108 | 2 | 294.667 |
| Gemini Supreme v4 | 2 | 291.850 | 1 | 284.150 |
| solinator 6.1 | 3 | 296.017 | 3 | 301.258 |
| DeepSeek NOVA | 4 | 315.042 | 6 | DNF |
| VORTEX | 5 | 319.767 | 4 | 332.550 |
| Astra | 6 | 333.142 | 5 | 333.575 |

| solinator metric | Start sixth (default) | Start first |
| --- | ---: | ---: |
| Timed laps (s) | 71.633 / 70.100 / 70.800 / 73.942 | 72.342 / 70.625 / 72.367 / 76.142 |
| Valid laps | 4/4 | 3/4 |
| Retained passes made / lost | 3 / 0 | 2 / 3 |
| Offtrack (s) | 0 | 1.417 |
| Damage at finish | 0.02518 | 0.04287 |
| Ego-involved contact samples | 40 | 81 |
| Ego-involved >6 m/s closing samples | 0 | 0 |
| Controller errors | 0 | 0 |

The front-start opening lap is invalid after an offtrack excursion at T1. NOVA also fails to finish that field. These outcomes are retained rather than removed from the comparison. Raw contact samples are not separate collision episodes and do not assign fault. A retained pass requires a changed >5 m lead held for two seconds; noisy side-by-side order changes do not count. Collision observation matches the unchanged host solver with zero parity errors in both runs.

Sources: [current-six-car-rear-grid.json](results/current-six-car-rear-grid.json), [current-six-car-front-grid.json](results/current-six-car-front-grid.json). The default grid preserves the original five rivals' positions and appends solinator; both test orders remain reproducible with the harness's `--order` argument.

## Eight-lap limitation

The current eight-lap run is **70.217 / 70.042 / 70.683 / 73.408 / 86.483 / 90.308 / 89.375 / 88.633 s**, all valid, with zero offtrack, damage or controller errors. Rear-right core reaches about 133.8 C and finishes near 132.0 C. Wear remains small; thermal and pressure grip loss are the main remaining limitation.

The first-two mean is 70.129 s and the last-two mean is 89.004 s: **18.875 s fade**. The previous eight-lap result faded 16.321 s. Four-lap pace improved, but eight-lap sustained pace became worse. The conservative warm initializer keeps the car on track at a substantial pace cost; this is survival, not successful endurance management.

Source: [current-eight-lap-solo.json](results/current-eight-lap-solo.json). A useful next controller change must improve a complete warm stint rather than only its fastest cold lap.

## Verification and browser deployment

`npm test` passes **11 tests**, including exact wheel/chassis parity, read-only speculative rollouts, rotated body occupancy, T1 gate geometry, gate-handoff consistency, explicit speed-cap enforcement, encounter recovery and native/worker decision parity. The worker parity check includes an opponent and preserves the replica's wheel references.

Production `npm run sandbox:build` passes. The existing large graphics/application bundle still produces Vite's size advisory. The game is served locally at [the six-car Benchmark](http://127.0.0.1:4186/?mode=5-arch); all six names and the solinator camera were checked in the visible browser.

In the two Node field runs, physical expansions averaged about 46–50 ms, with p95 about 70–73 ms and maximum about 91–100 ms. The browser offloads this work and waits for controls before advancing each host tick. A 120 Hz physical solver is not a claim of 120 rendered frames per second.

[current-source-provenance.json](results/current-source-provenance.json) fingerprints the current controller, all five rival source trees, physical laws, harness and integration. Each measured run also retains its own execution-time hashes. Registration/presentation hashes can differ after the default-order update; the controller and force laws used for the field measurements are unchanged.

## Historical evidence

The original five-position campaign used Astra, Supreme 3.2, NOVA and a locally modified VORTEX from the sibling Benchmark. solinator won 5/5 grids, with 19/20 valid laps and best 70.658 s. PHANTOM and Supreme v4 were absent, so these are historical results only.

- [five-grid-campaign.json](results/five-grid-campaign.json): original four-rival campaign.
- [competitor-solo-baselines.json](results/competitor-solo-baselines.json): original solo baselines, including Supreme 3.2.
- [eight-lap-solo.json](results/eight-lap-solo.json): previous eight-lap run, 16.321 s fade.
- [source-provenance.json](results/source-provenance.json): original source fingerprints.
- [scripted-tactics.json](results/scripted-tactics.json): original predictable-rival checks; these do not establish adversarial robustness.

Faster current solo measurements replace the older pace headline, not the remaining limitations. No claim is made of beating PHANTOM/Supreme v4, flawless defending, central-gap squeezing, all-grid robustness or solved long-stint tyre economics.
