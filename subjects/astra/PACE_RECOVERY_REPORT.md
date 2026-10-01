# Harbor GT pace checkpoint — 2026-09-12

## Debugger follow-up

The proximity diagram now agrees with the driver camera: positive simulation
lateral offsets appear on screen-left. Diagram positions, clearance labels and
committed-side descriptions were corrected together, without changing physics
coordinates. Turn context identifies inside/outside from track heading changes.
A read-only decision card shows maneuver, target, equal-distance route-time
comparison, predicted clearance and exit advantage. Expandable alternatives
explain exclusion or scoring tradeoffs. Rival-hypothesis support is explicitly
not presented as calibrated pass/collision probability. Tests compare diagram
orientation with the actual Three.js camera and verify no scoring/memory writes.

An exploratory approach-reserve/inside-cover change was rejected despite a
five-rotation mean best lap of 82.118 s and lower mean damage (0.04366): an
eight-Astra field produced a spin and off-track runs. Separating steering reserve
reduced but did not eliminate the regression. Those driving changes are not
included. The stronger attack/defense and local-risk work remains open.

Astra now uses the curvature of its selected trajectory and its live tyre/braking
envelope instead of applying the slower reference-line speed ceiling a second
time. Additional lateral and braking demand fades out near traffic and with
thermal degradation. This changes driver decisions, not vehicle forces.

## Reproduced results

Shared Harbor GT plant, fixed 1/120 s steps, driver skill 0.956, fresh track:

| Two-lap solo | Lap 1 | Lap 2 | Spins / off-track seconds / damage |
|---|---:|---:|---|
| Previous Astra pin `709ed88d4aa0bb5f58b8ec8e655a40d016d23cbb` | 84.725 s | 85.617 s | 0 / 0 / 0 |
| This candidate | 80.183 s | 80.425 s | 0 / 0 / 0 |

First-lap gain: 4.542 s (5.36%). Native Astra Harbor GT check: 80.592 s.
The user's 73.200 s is a human lap in Astra, not an AI benchmark measurement.
This checkpoint does not match that time or establish parity with Supreme.

Eight-lap solo: 80.183, 80.525, 83.650, 88.608, 92.008, 94.250, 97.300,
99.967 s; zero spins, off-track time and damage. Tyre degradation remains a
significant pace limitation. At wetness 0.5: 87.500 and 87.675 s, also clean.
Eight-car Astra pack: all finish, zero off-track time, no severe contacts;
small contact damage remains (maximum 0.01315 per car).

## Validation

The canonical five-rotation, two-lap comparison completed against the same
opponent pins and host. Both Astra versions finish second in all five runs,
with zero off-track time and controller errors. Mean best lap improves from
84.678 to 82.962 s. Mean reported damage increases from 0.00812 to 0.06151
(candidate maximum 0.16995). Four of five finish times improve; rotation four
regresses from 182.775 to 183.975 s. Canonical damage/pass counters include
post-finish running until the whole race stops; these are unmodified harness
metrics, not incident attribution. These results establish a pace gain, not
improved defensive or attacking skill. More assertive, efficient close racing
remains unfinished.

- 98 unit tests pass, including candidate curvature, braking/obstacle limits,
  wet grip and retained traffic-envelope coverage.
- Vite production build passes.
- `node tests/harbor-quality.mjs --check`: GT, touring and prototype pass.
- `node tests/harbor-quality.mjs --mixed --check`: passes, no severe contacts.
- `node tests/flow-benchmark.mjs --check`: early-brake and lost-control pass.
- `node tests/showcase-quality.mjs --check`: three-lap pack passes.

## Reproduction and scope

The prepared sibling `../benchmark` is required for shared tests. Its host
physics and opponents are not modified. Before changing the Astra pin:

```sh
node tests/shared-pace.mjs --driver=pinned
node tests/shared-pace.mjs
node tests/shared-pace.mjs --laps=8
node tests/shared-pace.mjs --wetness=.5
node tests/shared-pace.mjs --field=8
node scripts/benchmark-candidate.mjs --baseline --rotations --json=artifacts/pace-baseline-matrix.json
node scripts/benchmark-candidate.mjs --rotations --json=artifacts/pace-candidate-matrix.json
```

The canonical comparison redirects only Astra's controller import; the benchmark
host, bridge and opponent imports stay pinned. Reports record manifest pins,
source hashes, command and time step. Run against benchmark commit
`9aebaab57e523eecec6f92021145312f309a705d`; Supreme reference pin is
`e8b9bdc672e332621788850ee021e9817c7238c9`.

## Still unfinished

Full-width outside–apex–exit positioning and a broader T1 chicane arc are not
part of this checkpoint. Experimental minimum-curvature and physical-distance
guide implementations caused path-tracking failures and off-track runs; their
new files and switches were removed. Existing steering and entry geometry were
restored. Further work needs a path representation that stays continuous through
the compact chicane and a controller that follows that path under measured tyre
slip. Simply widening the arc or raising speed further was not reliable.

## Human trace audit — 2026-09-13

Both supplied `astra-harbor-ring-human-76.108` files are byte-identical valid
76.108333-second human laps (2,285 samples). They do not contain the faster
invalid lap. The debugger now offers separate best-valid and last-lap exports;
last-lap export includes invalid laps, with `-invalid` in the filename. Mixed
human/AI laps cannot replace the valid best reference. Recording is a bounded,
read-only 30 Hz observer of the 120 Hz simulation.

`node scripts/corner-audit.mjs trace.json report.json reference.json` measures
geometry-derived corner windows, braking onset/strength, minimum speed, apex
offset, throttle pickup, exit speed, track-width use and traffic/thermal reserve.
It separates repeated passes across the finish seam and rejects invalid or
mixed-driver comparison references. Window times have trace-sample resolution;
review labels are investigation prompts, not established causes of time loss.

Against the unchanged 80.183-second checkpoint, the supplied valid lap is about
0.600 seconds slower in the T1 window but 1.066 and 0.825 seconds faster in the
last two windows. Later straight speed is also substantially higher. This makes
late-corner geometry and exit acceleration higher priorities for this reference.
The older 73.200-second human reference remains a separate target without a trace.

Rejected envelope experiment: a speed-dependent aero braking estimate plus
combined-slip approach braking achieved 79.942/80.208, zero solo/pack off-track
time, and no severe pack contacts. However, the eight-lap run faded to 103.650
versus the checkpoint's 99.967. The first version without combined-slip approach
braking also spun. All experimental driving changes were reverted; these results
are not a promoted behavior claim. Physics and opponent implementations remained
unchanged throughout.

## Final-kink arc checkpoint — 2026-09-13

`racing-arc.js` refines Harbor GT's 2410–2570 m window using bounded
curvature minimization, with both neighbouring corners fixed. The arc uses up
to 5.52 m of lateral offset. It is cached per reference line and owned by Astra's
driver; the shared road, host racing line and other controllers are untouched.
The same driver constructor installs it in native and benchmark runs. Traffic
still selects alternatives around this arc through the existing planner.

| Test | Previous checkpoint | Refined arc |
| --- | ---: | ---: |
| Shared solo lap 1 | 80.183 s | 79.067 s |
| Shared solo lap 2 | 80.425 s | 78.775 s |
| Eight-lap final lap | 99.967 s | 98.550 s |
| Wet 0.5 solo best | 87.500 s | 86.300 s |
| Native Harbor GT solo | 80.592 s | 79.783 s |
| Native mixed-class GT lap | 86.250 s | 84.858 s |

Shared solo, wet and eight-lap runs have zero spins, off-track time and damage.
All eight cars in the two-lap Astra field finished with zero off-track time and
zero damage. Touring/prototype native regressions remain 104.800/79.708 s.
106 unit tests, Harbor solo/mixed checks, showcase regression and build passed.

The C9 audit window improves from 4.133 to 3.200 s, reducing its loss to the valid
human trace from 1.066 to 0.133 s. Minimum speed in that window rises from the
high 70s to 118 km/h. The following corner and later straight remain priorities.

Fresh canonical comparison at benchmark `2fe9ea053f716a083a4cccaacc28e76bbb7075f8`,
with Supreme `0a97e974d5c71fbb6125dabea3f4efa992282fb2` held fixed:

| Rotation | Previous best | Arc best | Previous finish | Arc finish |
| --- | ---: | ---: | ---: | ---: |
| 1 | 81.392 | 80.942 | 173.975 | 172.458 |
| 2 | 81.900 | 80.825 | 176.325 | 174.650 |
| 3 | 81.783 | 79.600 | 174.742 | 171.633 |
| 4 | 85.000 | 82.333 | 197.292 | 178.067 |
| 5 | 80.900 | 80.508 | 177.533 | 175.992 |

Astra finishes P2 in every rotation. Mean best lap improves 82.195→80.842 s;
reported mean damage falls 0.042915→0.033135 and mean off-track time falls
1.957→0 s. Canonical incident/pass counters include post-finish cooldown until
the entire harness stops; do not interpret them as retained race passes or
attribute every incident to pre-finish driving. Candidate controller sources
and all pins are captured in `artifacts/arc-{baseline,candidate}-matrix.json`.
This is a pace/line checkpoint, not completion of stronger attack/defense or
the 73.200-second target.
