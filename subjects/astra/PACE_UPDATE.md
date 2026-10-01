# Clear-air pace and rotation control

Target: a 1:19 flying lap without adding grip, power, position corrections or
special collision rules. Vehicle and tyre physics are unchanged.

## Measured solo pace

Same circuit, dry conditions, standard car setup, driver skill 0.976, 120 Hz
physics. The first lap begins from the grid and is not a flying lap.

| Measurement | Previous controller | Updated controller |
| --- | ---: | ---: |
| Standing-start lap | 89.183 s | 83.975 s |
| First flying lap | 84.833 s | 79.258 s |
| Second flying lap | 84.858 s | 80.333 s |
| Coasting below half throttle across these laps | 53.8 s | 19.7 s |
| Full-throttle time | 85.5 s | 104.7 s |
| Hard-braking time | 6.2 s | 10.7 s |
| Off-track time / damage | 0 / 0 | 0 / 0 |

Six-lap check: 83.975, 79.258, 80.333, 82.567, 85.200, 87.825 seconds;
zero off-track time and damage. Peak body slip across the stint was 0.184 rad
(10.5 degrees). Hot rear tyres reduce the permitted pace later in the stint;
this is not a claim that every lap or every car will run 1:19.

## Implementation

- Clear-air and traffic speed profiles are independently braking-feasible.
- Higher clear-air corner and braking demands still respect the live grip model.
- Faster throttle and brake response reduces extended partial-throttle coasting.
- Shorter steering lookahead, body-slip compensation and measured yaw feedback
  provide rotation while correcting excess yaw. Curvature is sampled ahead of
  the replanning seam to avoid a false steering impulse during lane changes.
- A continuous traffic blend retains steering/grip reserve for nearby opponents.
  Rear-tyre heat limits speed demand independently of steering stabilization.
- The slower grid drivers now use skill 0.952–0.976, versus 0.940–0.976 previously.
- Prediction uses the selected passing path's curvature, and stronger lateral
  error correction prevents a small tracking error from growing into a run wide.
- The race engineer shows pace mode, pace release and body slip.

`node tests/pace-benchmark.mjs` reproduces the three-lap measurement. Set
`PACE_LAPS=6` for the longer stint. CLI calibration overrides are for controlled
experiments; normal gameplay uses `src/sim/pace.js`.

Regression coverage includes the 1:19 bracket, six-lap completion, hot-tyre
control, smooth traffic transitions, retained overtaking and surprise braking.

## Final eight-car race checks

Both standard 240-second contracts passed without changing their thresholds.

| Measurement | Normal (72% aggression) | Fierce (95%) |
| --- | ---: | ---: |
| Fastest lap in traffic | 81.692 s | 80.208 s |
| Clean passes | 10 | 13 |
| Retained passes | 10 | 12 |
| Off-track vehicle seconds | 0 | 0 |
| Severe contacts | 0 | 0 |
| Total field damage | 0 | 0.037 |
| Field spread | 528.8 m | 531.2 m |

Traffic and tyre state affect lap times. The 1:19 claim refers to the controlled
clear-air measurement, not a guaranteed race lap. The browser race engineer was
also checked with the live pace mode, release percentage and body-slip readings;
no browser warnings or errors were reported during that check.
