# Measured results

**Acceptance remains incomplete.** No measured SOLSTICE lap meets Harbor's
64-second target. Current mixed races do not establish wins on all tracks over
three seeds. No claim is made that physics prevents the target.

## Conditions and metric definitions

Baselines use 150 racing seconds, four identical AI cars, six-lap sprint format,
GT class, medium starting compound, seed 7, clear weather, sun .6, ALIEN k=1,
and the game's fixed 1/120-second step. Every full race retains normal fuel,
wear, weather, governor, pit autopilot and mandatory driver swap.

Lap one begins timing at the first line crossing and is a full rolling timed
lap. Clean timed laps count; red and pit laps do not. A separate steady metric
excludes lap one. Baseline median below is the mean of available per-car clean
medians; it is not a pooled median. Fuel and maximum-wheel wear per completed
lap include the opening grid approach, pit travel, and race resource scaling.
Wear accumulates across tyre changes. These are operational race averages.

Contacts are global repeated contact-step events, not distinct incidents or
attributable per-car contacts. Impact episodes combine car-contact and barrier
signal crossings. They must not be reported as contacts per individual car-hour.
An optional field-normalized rate is totalContacts / (cars × seconds / 3600).
Finishing order follows the game's flag rules: a flagged lapped car can finish
with fewer completed laps, so a time gap alone does not establish equal distance.

Update cost is instrumented elapsed time around bridge calls, in ms per
simulated second per car. Concurrent measurements include scheduling noise;
they are not OS CPU counters. New reports also expose startup cost and source
provenance. Early development reports predate that instrumentation.

## Remeasured baselines

| Driver | Track | Best clean s | Mean car median s | Sum off-track s | Global contacts | Mean core °C | Max-wheel wear/lap | Fuel L/lap | Update ms/s/car |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| phantom | harbor-ring | 68.467 | 69.429 | 0.00 | 0 | 79.7 | 0.192 | 16.97 | 276.5 |
| phantom | solenne | 68.483 | 69.890 | 5.50 | 2 | 81.0 | 0.202 | 15.88 | 278.5 |
| phantom | alpine | 84.942 | 86.679 | 0.00 | 0 | 81.1 | 0.408 | 26.98 | 283.5 |
| phantom | desert | 89.025 | 90.523 | 0.00 | 1 | 80.2 | 0.248 | 26.51 | 278.6 |
| phantom-v2 | harbor-ring | 67.317 | 69.335 | 0.00 | 0 | 79.9 | 0.196 | 17.17 | 268.3 |
| phantom-v2 | solenne | 69.108 | 70.592 | 0.60 | 1 | 80.9 | 0.190 | 16.04 | 269.5 |
| phantom-v2 | alpine | 84.525 | 85.935 | 0.00 | 1 | 80.9 | 0.398 | 26.79 | 281.2 |
| phantom-v2 | desert | 88.350 | 89.315 | 0.00 | 0 | 79.9 | 0.229 | 26.10 | 279.9 |
| gemini-supreme-v4 | harbor-ring | 69.108 | 70.566 | 0.00 | 644 | 80.1 | 0.296 | 28.65 | 3.5 |
| gemini-supreme-v4 | solenne | — | 0.000 | 105.81 | 2128 | 81.7 | 0.468 | 29.90 | 4.1 |
| gemini-supreme-v4 | alpine | 83.450 | 85.204 | 0.00 | 947 | 81.1 | 0.415 | 28.45 | 4.5 |
| gemini-supreme-v4 | desert | 89.017 | 92.150 | 28.13 | 5025 | 80.0 | 0.232 | 27.98 | 6.4 |
| solinator-6.1 | harbor-ring | 72.042 | 74.502 | 0.00 | 52 | 80.0 | 0.386 | 36.23 | 142.5 |
| solinator-6.1 | solenne | — | 0.000 | 57.37 | 58 | 81.4 | 0.467 | 33.47 | 118.1 |
| solinator-6.1 | alpine | — | 0.000 | 32.95 | 349 | 80.5 | 0.441 | 29.53 | 87.9 |
| solinator-6.1 | desert | 88.008 | 88.008 | 42.25 | 23 | 80.9 | 0.325 | 28.07 | 111.7 |
| astra | harbor-ring | 81.633 | 82.788 | 0.00 | 1 | 78.5 | 0.245 | 34.56 | 44.9 |
| astra | solenne | 93.292 | 94.215 | 0.00 | 0 | 77.2 | 0.173 | 30.29 | 26.5 |
| astra | alpine | 105.283 | 107.498 | 0.00 | 0 | 77.2 | 0.179 | 26.96 | 23.2 |
| astra | desert | 106.025 | 107.554 | 0.00 | 0 | 77.9 | 0.132 | 26.18 | 24.5 |

Raw JSON for all 20 cases is under results/baseline-*.json. The corrected
baseline-summary.json also retains steady lap metrics and measurement notes.

## Full development races

These are explicitly development candidates, loaded before the latest tuning.
Each newer result includes hashes and configuration to distinguish revisions.
The original mixed candidate failed; lane-specific braking and lane slew
removed departures in the subsequent Alpine/Desert homogeneous races and
Harbor/Solenne mixed races. Those improvements do not establish acceptance.

| Run | Position / laps | Gap s | Best / median clean s | Off-track s | Impact episodes / damage | Rescues | Stops / swaps | Mean core °C | Fuel L/lap | Wear/lap | Governor active % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| [homogeneous, harbor-ring, seed 7, car 1](results/homogeneous-harbor-ring-seed7.json) | 1 / 6 | 0.00 | 70.600 / 73.033 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 92.3 | 18.46 | 0.214 | 50.4 |
| [homogeneous, harbor-ring, seed 7, car 2](results/homogeneous-harbor-ring-seed7.json) | 2 / 6 | 5.17 | 72.283 / 74.029 | 0.00 | 1 / 0.005 | 0 | 1 / 1 | 92.1 | 18.47 | 0.216 | 50.7 |
| [homogeneous, harbor-ring, seed 7, car 3](results/homogeneous-harbor-ring-seed7.json) | 3 / 6 | 9.02 | 74.117 / 74.217 | 0.00 | 1 / 0.005 | 0 | 1 / 1 | 92.3 | 18.41 | 0.217 | 50.9 |
| [homogeneous, harbor-ring, seed 7, car 0](results/homogeneous-harbor-ring-seed7.json) | 4 / 6 | 66.57 | 73.858 / 73.858 | 29.97 | 1 / 0.048 | 0 | 2 / 2 | 90.8 | 17.11 | 0.264 | 73.3 |
| [homogeneous, solenne, seed 7, car 1](results/homogeneous-solenne-seed7.json) | 1 / 6 | 0.00 | 69.825 / 70.550 | 24.01 | 3 / 0.064 | 0 | 1 / 1 | 96.2 | 16.20 | 0.284 | 55.5 |
| [homogeneous, solenne, seed 7, car 0](results/homogeneous-solenne-seed7.json) | 2 / 6 | 5.52 | 70.083 / 70.175 | 4.52 | 2 / 0.110 | 0 | 1 / 1 | 96.1 | 16.20 | 0.270 | 55.7 |
| [homogeneous, solenne, seed 7, car 2](results/homogeneous-solenne-seed7.json) | 3 / 6 | 92.57 | 70.942 / 72.075 | 34.14 | 4 / 0.211 | 0 | 2 / 2 | 94.8 | 15.20 | 0.305 | 76.0 |
| [homogeneous, solenne, seed 7, car 3](results/homogeneous-solenne-seed7.json) | 4 / 5 | 16.80 | 72.017 / 72.017 | 39.69 | 4 / 0.255 | 0 | 2 / 2 | 93.8 | 17.54 | 0.341 | 68.1 |
| [homogeneous, alpine, seed 7, car 1](results/homogeneous-alpine-seed7.json) | 1 / 6 | 0.00 | 82.858 / 85.671 | 0.00 | 1 / 0.057 | 0 | 1 / 1 | 96.1 | 16.15 | 0.276 | 62.5 |
| [homogeneous, alpine, seed 7, car 3](results/homogeneous-alpine-seed7.json) | 2 / 6 | 1.77 | 82.750 / 85.496 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 95.9 | 16.03 | 0.271 | 62.2 |
| [homogeneous, alpine, seed 7, car 0](results/homogeneous-alpine-seed7.json) | 3 / 6 | 37.39 | 82.450 / 83.083 | 18.55 | 4 / 0.047 | 1 | 1 / 1 | 96.6 | 15.56 | 0.293 | 66.4 |
| [homogeneous, alpine, seed 7, car 2](results/homogeneous-alpine-seed7.json) | 4 / 5 | 32.58 | 84.483 / 84.483 | 61.67 | 3 / 0.162 | 2 | 2 / 2 | 94.7 | 16.88 | 0.407 | 83.5 |
| [homogeneous, desert, seed 7, car 0](results/homogeneous-desert-seed7.json) | 1 / 6 | 0.00 | 86.308 / 90.475 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 95.8 | 16.32 | 0.203 | 58.6 |
| [homogeneous, desert, seed 7, car 3](results/homogeneous-desert-seed7.json) | 2 / 6 | 3.67 | 88.875 / 90.596 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 95.8 | 16.32 | 0.205 | 60.0 |
| [homogeneous, desert, seed 7, car 1](results/homogeneous-desert-seed7.json) | 3 / 6 | 86.71 | 91.450 / 91.450 | 35.89 | 2 / 0.093 | 0 | 2 / 2 | 93.7 | 15.21 | 0.248 | 78.8 |
| [homogeneous, desert, seed 7, car 2](results/homogeneous-desert-seed7.json) | 4 / 5 | 83.82 | 91.500 / 91.500 | 103.53 | 4 / 0.122 | 1 | 2 / 2 | 94.8 | 16.55 | 0.334 | 82.8 |
| [fix-combat, alpine, seed 7, car 1](results/fix-combat-alpine-seed7.json) | 1 / 6 | 0.00 | 81.792 / 85.617 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 94.4 | 15.99 | 0.255 | 60.0 |
| [fix-combat, alpine, seed 7, car 3](results/fix-combat-alpine-seed7.json) | 2 / 6 | 4.35 | 82.275 / 85.717 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 94.0 | 15.94 | 0.248 | 57.3 |
| [fix-combat, alpine, seed 7, car 0](results/fix-combat-alpine-seed7.json) | 3 / 6 | 20.42 | 84.575 / 89.850 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.2 | 16.26 | 0.256 | 58.3 |
| [fix-combat, alpine, seed 7, car 2](results/fix-combat-alpine-seed7.json) | 4 / 6 | 22.58 | 83.683 / 90.812 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.1 | 16.16 | 0.243 | 56.8 |
| [fix-combat, desert, seed 7, car 0](results/fix-combat-desert-seed7.json) | 1 / 6 | 0.00 | 86.383 / 90.312 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.9 | 15.30 | 0.199 | 65.5 |
| [fix-combat, desert, seed 7, car 2](results/fix-combat-desert-seed7.json) | 2 / 6 | 8.12 | 90.792 / 91.554 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.4 | 15.38 | 0.197 | 62.3 |
| [fix-combat, desert, seed 7, car 1](results/fix-combat-desert-seed7.json) | 3 / 6 | 10.88 | 90.733 / 91.908 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.1 | 15.60 | 0.196 | 61.6 |
| [fix-combat, desert, seed 7, car 3](results/fix-combat-desert-seed7.json) | 4 / 6 | 14.62 | 90.075 / 92.050 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.4 | 15.53 | 0.203 | 63.0 |
| [mixed, harbor-ring, seed 7, car 5](results/mixed-harbor-ring-seed7.json) | 5 / 6 | 39.97 | 73.908 / 74.838 | 0.00 | 2 / 0.021 | 0 | 1 / 1 | 91.3 | 17.81 | 0.221 | 54.2 |
| [mixed, solenne, seed 7, car 5](results/mixed-solenne-seed7.json) | 6 / 5 | 58.27 | — / — | 78.06 | 7 / 0.315 | 1 | 3 / 3 | 93.9 | 17.90 | 0.509 | 76.0 |
| [mixed, alpine, seed 7, car 5](results/mixed-alpine-seed7.json) | 6 / 5 | 1.57 | 85.792 / 85.792 | 46.67 | 10 / 0.154 | 2 | 2 / 2 | 94.8 | 18.66 | 0.429 | 70.9 |
| [mixed, desert, seed 7, car 5](results/mixed-desert-seed7.json) | 5 / 6 | 91.25 | 93.208 / 93.208 | 39.67 | 3 / 0.100 | 0 | 2 / 2 | 93.9 | 15.38 | 0.257 | 78.2 |
| [fix-mixed, harbor-ring, seed 3, car 5](results/fix-mixed-harbor-ring-seed3.json) | 5 / 6 | 28.44 | 73.250 / 74.208 | 0.00 | 1 / 0.017 | 0 | 1 / 1 | 91.4 | 18.06 | 0.197 | 49.7 |
| [fix-mixed, solenne, seed 3, car 5](results/fix-mixed-solenne-seed3.json) | 3 / 6 | 7.99 | 68.267 / 70.958 | 0.00 | 0 / 0.000 | 0 | 1 / 1 | 93.0 | 15.72 | 0.228 | 58.1 |

## Reproduce

### Sub-64 momentum experiments (2 October)

These development measurements use GT cars, soft tyres, a normal 20-lap
marathon race, ALIEN difficulty, clear weather, sun 0.6, seed 7, cold grid tyres
and normal endurance fuel. They are recorded laps, not warm-envelope estimates.
Experimental options and exact source hashes are retained in each linked JSON.
The shipped configuration is selected separately after full-race checks.

| Experiment | Best clean lap s | Later clean laps s | Off-track s | Limitation |
|---|---:|---:|---:|---|
| [Deep Harbor line](results/span4-deep12-soft20-harbor.json) | 62.900 | 68.283, 78.408 | 0 | Rear tyre heat increases and the governor caps later pace |
| [Strong feedback](results/strong-feedback-soft20-harbor.json) | 62.708 | 67.775, 71.042 | 0 | Short 320-second run; stint acceptance remains unproven |
| [Release preparation revision](results/releasefix-soft20-harbor.json) | 62.625 | 67.758, 71.208, 70.767 | 0 | 500 seconds; one pit rescue; warm repeatability fails |

The source/options fields in each raw result are the authoritative record.
The 62.625-second lap has outer rear core temperature 86.15 degrees C at the
line. That wheel reaches about 103 degrees C after lap two and 113.5 after lap
three. Thus the faster line and normal throttle on straight exits are verified,
but repeatable sub-64 warm laps are not. Fixed additional rear rotation worsened
some earlier trials. The current revision enables additional rotation only on
warm, degraded rear tyres and measures its work and activation per track section.

The later actual-force braking experiment reduced a four-car Harbor race to one
global contact and the corresponding Solenne/Desert races to zero contacts,
but departures and pit rescues remained. All acceptance criteria are still
required; these intermediate results do not establish mixed-field wins or an
equal-pace resource advantage. No physical impossibility has been demonstrated.

Run the commands in README.md. For baselines replace --driver solstice with
the listed id, set --teams 4 --seconds 150 --seed 7. For mixed races specify
--field astra,phantom,phantom-v2,gemini-supreme-v4,solinator-6.1,solstice
--teams 6 --laps 6 --seconds 1800. Repeat --track for all four ids and seeds
7, 3, 19. Specify --weather rain --sun .1 for rain/night checks.

Regenerate these tables with node subjects/solstice/tools/report.mjs.
Full cadence and station diagnostic data are separately retained in results/.
Quasisteady envelope estimates are planning heuristics, not achieved lap times
or a proof of a physical limit.
