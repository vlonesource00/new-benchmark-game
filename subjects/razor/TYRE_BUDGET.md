# Live tyre budget and Nürburgring pedals

RAZOR measures the worst wheel's wear per lap and shares the learned compound rate between teammates using the same car. Fresh tyres reset the current set's budget while retaining that rate.

The forecast covers the smaller of remaining race distance and estimated fuel window. A confirmed tyre change shortens it to pit entry; a fuel-only stop keeps the current tyres responsible for the remaining race. The driver finds the largest permitted extra grip margin with projected fade below 3.8 seconds and projected wear below 92%. These forecasts are estimates, not a guaranteed lap-time bound.

Healthy measured tyres receive more push within 90 metres of a valid opponent, through a committed pass and its overlap, and in the final 1.5 laps. Heat above the compound's optimum reduces extra push. Pit cars, formation running and wet presets cannot trigger pursuit expenditure. The grip margin stays within its configured chassis envelope; physical grip, tyre wear and fuel are not changed.

`debug().stintBudget` reports the factor, reason, measured rate, race/stint distance remaining, projected wear and fade. The PACE subtitle shows active expenditure. Combat continues to own the path, nose-obstruction brake and overlap policy.

## Dry strategy

Unmeasured dry tracks use the current game planner instead of stale inherited APEX stint tables. Clear Nürburgring races of four laps now start on softs for both classes at zero, one and two mandatory stops. Measured Harbor data still require the matching physics signature. Wet strategy is unchanged.

## Continuous Nürburgring pedals

The dry Nürburgring controller uses a signed wheel-force request, combining the speed error and profile gradient. It limits the preview target to an achievable acceleration horizon. Committed combat corridors retain their validated pedal policy.

GT3 asynchronous seats receive stronger position feedback before the existing steering-jerk limiter. The native tracker keeps its existing calibration. Applying additional feedback after the limiter caused a regression at high update rates; that approach was rejected.

The pedal rewrite is enabled only on Nürburgring. Applying it globally changed close Harbor encounters, so other tracks retain their established pedal controller.

## Measured results

Clear, seed 7, four-lap Nürburgring races at native 60 Hz with one mandatory stop and driver swap:

| Class | Previous hard-start version | Current soft-start version | Gain |
| --- | ---: | ---: | ---: |
| GT3 | 2277.13 s | 2181.68 s | 95.44 s |
| GTP | 1963.88 s | 1864.79 s | 99.08 s |

Both current runs completed the stop and swap without contacts, recorded steward incidents or controller errors. The starting compound accounts for much of the gain. GT3 corner brake pulses fell from 7408 to 39; pedal switches fell from 4967 to 432. The audit also recorded brief kerb excursions: approximately 11.3 seconds across four GT3 laps and 8.5 seconds for GTP.

The native Harbor endurance checks cover 12- and 20-lap races in both classes against APEX, including pit stops and swaps. Full-field races and rain remain outside this validation.

The final suites pass 69 driver checks, eight budget checks, ten stint checks and four native Harbor endurance cases. GT3 actual-worker probes cover 75 seconds at 20, 30 and 60 Hz, plus a changing 60/20/30/60 Hz schedule. The focal RAZOR records zero contacts, off-track time, damage and controller errors in all four probes. The distant APEX had damage at 20 Hz, so this does not establish full-field stability.

## Reproduction

Run from the repository root using Node and the existing JSON loader:

```sh
node --import ./scripts/json-loader.mjs subjects/razor/tools/budget-check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/stint-check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/endurance-check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/speed-audit.mjs --race --track=nurburgring --class=gt --compound=soft --laps=4 --cal-laps=4 --stops=1 --hz=60
node --import ./scripts/json-loader.mjs subjects/razor/tools/speed-audit.mjs --race --track=nurburgring --class=lmdh --compound=soft --laps=4 --cal-laps=4 --stops=1 --hz=60
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-encounters.mjs apex gt gt --track=nurburgring --start=600 --gap=800 --solo --hz=60 --seconds=75
```

For the previous native controller and inherited hard-start strategy, append `--legacy-strategy --options='{"smoothPedals":false,"adaptiveTyres":false,"trackingGain":1}'` to the native audit. The worker probe's `--solo` suppresses causal-pass requirements; its distant opponent remains present, so it is not a full-race overtaking benchmark.
