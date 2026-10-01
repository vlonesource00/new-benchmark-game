# AI intelligence and pace improvements

Implemented from [the assessment](AI_IMPROVEMENT_ASSESSMENT.md). Final verification results are recorded below; this file replaces interim tuning results as the implementation reference.

## What changed

- **Control fidelity:** Prediction and execution share the pedal mapping, including positive and negative acceleration requests and avoiding throttle/brake overlap. The controller evaluates two steering/pedal segments, includes steering-command smoothing, and uses stronger path-error feedback. Independent emergency braking still overrides ordinary control. The reduced dynamics remain an approximation, not a complete copy of the wheel-force solver.
- **Sustained pace:** A short thermal forecast integrates observed rear slip-energy input through surface/core temperature dynamics. The performance model distinguishes front and rear grip and uses the weaker axle when setting pace. Prediction uses a conservative effective-load budget. No tyre state or vehicle force is altered by these estimates.
- **Racing line:** A bounded search compares line width and apex phase using whole-lap travel time after backward braking and forward acceleration passes. The original elastic-band line is included as a fallback. This searches complete corner sequences rather than choosing a line solely for smoothness.
- **Opponent prediction:** Each driver maintains expiring motion history for visible rivals. Observed prediction errors update HOLD, RACING LINE, EARLY BRAKE, and DEFEND hypothesis weights; observed braking strength and preferred corridor refine those predictions. No rival's chosen controls or future plan are read.
- **Race decisions and recovery:** Strategy receives standings, remaining distance, and progress gaps. It distinguishes lapping traffic, final-lap attacks, protecting a lead, and low-value attacks on hot tyres. Rejoining checks approaching traffic over a time window, including oncoming cars. The existing independent edge and collision supervisor remains authoritative.
- **Computation and evidence:** Per-tick track projections are shared among drivers; candidate geometry is cached within a solve; opponent lateral targets avoid unnecessary pose allocation; control rollout buffers are reused and visual points are captured only for the observed driver. Benchmarks report sector times, slip energy, temperature, late-stint time, and timing percentiles. The engineer displays heat forecast and control prediction error.

Settings now includes **AI PACE GOAL**: race mode anticipates future heat; qualifying mode prioritizes the present lap while retaining current grip limits and collision protection. Settings can scroll on shorter windows.

## Scope and interpretation

Vehicle, tyre-force, track, and collision physics remain unchanged. The line optimizer is a bounded parameter search, not a claim of a globally optimal racing line. Opponent learning is lightweight online estimation, not a trained neural policy. The thermal forecast assumes recent energy input continues; it is not a complete multi-lap optimal strategy solver. Planning/control frequencies remain unchanged; this update reduces redundant work rather than lowering safety frequency.

## Reproduce

Run from this project in PowerShell:

```powershell
npm test
npm run build
node tests/field-quality.mjs --check
node tests/field-quality.mjs --fierce --check
$env:PACE_LAPS='6'
node tests/pace-benchmark.mjs
$env:PACE_LAPS='10'
node tests/pace-benchmark.mjs
$env:PACE_LAPS='6'
$env:WETNESS='0.5'
node tests/pace-benchmark.mjs
Remove-Item Env:PACE_LAPS, Env:WETNESS
```

`PACE_OBJECTIVE=qualifying` selects the alternate objective for the pace benchmark. `SIM_ROOT` lets the current benchmark load an archived simulation for comparison. Runtime timings include host-load variation; headless simulation timings do not establish rendered browser FPS.

## Verification

The final candidate passes **50 tests**, the production build, and both original eight-car, 240-second race contracts. None of the existing contract thresholds or grid skill ratings was relaxed. The build reports a bundle-size advisory for a chunk above 500 kB.

Fresh dry solo comparison, same setup and driver skill 0.976:

| Measurement | Before | Final |
| --- | ---: | ---: |
| Best flying lap over six laps | 79.258 s | **76.967 s** |
| Six-lap total | 499.158 s | **492.601 s** |
| Mean of laps 4–6 | 85.197 s | 84.814 s |
| Peak tyre core temperature | 127.9°C | 125.1°C |
| Rear slip energy over six laps | 11.928 MJ | 11.483 MJ |
| Off-track time / damage | 0 / 0 | 0 / 0 |

The six-lap gain is **6.557 seconds**. The final ten-lap run completes in **853.143 seconds**, with zero off-track time or damage; lap ten is 91.467 seconds. The archived baseline took 1,074.225 seconds and accumulated 17.608 seconds off track, so that larger endurance improvement includes preventing the baseline's late-stint loss of control. Tyre heat still slows later laps: this is not a claim of constant 1:17 pace. Peak body slip over six laps increases from 0.184 to 0.254 rad with the stronger rotation control.

Final race contracts:

| Measurement | Normal, 72% aggression | Fierce, 95% |
| --- | ---: | ---: |
| Clean passes | 21 | 18 |
| Clean retained passes | 17 | 15 |
| Off-track vehicle seconds | 0 | 0 |
| Severe contacts | 0 | 0 |
| Total field damage | 0 | 0.011 |
| Field spread | 461.0 m | 438.8 m |

The fresh normal baseline had 10 clean retained passes. Fierce still permits minor contact; its final damage is small, not zero.

The final six-lap run at 50% wetness completes in 549.358 seconds with zero off-track time or damage. A three-lap qualifying-mode check also completes cleanly, with a best lap of 76.950 seconds. These checks cover this circuit and these setups; they do not establish performance on arbitrary tracks or all wetness/setup combinations.

For computation, `node tests/ai-cost-benchmark.mjs` compares the same eight-car snapshot and 33-candidate workload. Median driver-update cost falls from **3.719 ms to 2.568 ms**, about **31%**; p95 falls from 5.506 ms to 4.143 ms. This is a synthetic solver-cost comparison, not rendered FPS. In the actual final field runs, p99 individual AI updates were about 3.34–3.43 ms. Solo simulation wall time remains roughly unchanged.

Browser verification passed on the local build: the AI demonstration drives, racing paths render, and the race engineer displays live rear-heat forecasts and control-prediction error. The race/qualifying setting was checked and restored to race. No browser warnings or errors were captured during the check. Pause and return-to-paddock controls work; the simulator is left at the main menu.

Machine-readable results are in [tests/results/intelligence-upgrade.json](tests/results/intelligence-upgrade.json). The original simulation was copied before editing to `%TEMP%/astra-ai-baseline-2026-09-07`; point `SIM_ROOT` at its `src/sim` directory to reproduce an archived comparison while that temporary copy exists.
