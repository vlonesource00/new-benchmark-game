# VANGUARD: close-start recovery and planner verification

This continues the [GT passing update](COMBAT-PASSING-2026-10-17.md). The enabled change is a recovery response to a large tracking error or slide. The original two-level architecture, route selection, gentle-rubbing allowance and cumulative 20% damage budget for a 20-lap race remain in place. There is no neural-network training or GPU workload.

## Enabled change

The old controller could continue accelerating towards a corridor's nominal speed after it had stopped tracking that corridor. In the reproduced Harbor close-start failure, it slid off the road and hit the barrier without touching the other car.

GT recovery now reduces longitudinal demand when path error or outward heading/slip becomes large. Braking still goes through the existing axle allocator, preserving lateral grip. The recovery speed has an 8 m/s floor so a displaced low-speed car can drive back to its line. Ordinary close racing does not itself trigger recovery; prototype calibration is unchanged.

## Matched encounter checks

All runs use the real game race loop and async-seat protocol, sequentially at below-normal CPU priority. A retained racing pass requires four continuous seconds fully ahead at the finish, legal running, healthy cars, at most 1% damage to each car, and no contact other than gentle side rubbing. The benchmark rules were not relaxed.

| Check | Previous controller | Recovery enabled |
| --- | ---: | ---: |
| Harbor equal-pace start, 6 m centre gap: damage | 10.605% | 0% |
| Same case: time off track | 24.758 s | 0 s |
| Same case: car contacts | 0 | 0 |
| Original 12 attacking encounters: retained passes | 5/12 | 5/12 |
| Of those: zero-contact passes | 2/12 | 2/12 |
| Four defence encounters | 3/4 | 3/4 |
| Two braking-leader encounters | 2/2 | 2/2 |

The recovered close-start car completes 97.81% of the matched solo rival's progress. It keeps driving; this is not a pass, and is not scored as one. The 18-scene screen has no off-track cases, severe impacts or bridge errors in either arm. No success/failure outcome changes in that screen. Reports: `recovery-gap6.json`, `recovery-screen.json`, `verified-parent-screen.json` in `results/`.

These are controlled fixtures, not evidence of a broad overtaking improvement. In particular, seven of the eight original GT approaches from behind still do not convert into retained passes.

Repeating all eight GT approaches at a 6 m start gap on seed 19 gives zero retained passes for either arm. Recovery has no damage or off-track cases; the previous controller repeats the Harbor equal-straight barrier failure. This confirms the recovery at that fixed site, not independent statistical evidence across many different road sections. Reports: `recovery-gap6-seed19.json`, `parent-gap6-seed19.json`.

## Planner experiments: available, disabled

The investigation added an opt-in closed-loop preview using the game's unmodified vehicle integrator and VANGUARD's actual controller. It starts from the live steering/acceleration memory, uses private car/rubber/water buffers, checks road legality, and records tracking error and sustained body clearance. The bounded 4.5–6.5 s horizon can include the next corner's exit. Rivals remain independent public-state forecasts; they do not run their real reacting drivers inside this preview.

The preview is reproducible and matches independently stepped dry/wet vehicle trajectories in its regression tests. That does not establish better tactical decisions: full previews lost existing passes and introduced failures, and the narrower paired return preview also lost the canonical GT passing regression. Extra braking headway suppressed that same passing opportunity. These changes are not enabled:

```json
{"physicalRollouts": false, "returnPreview": false, "brakingHeadway": 0}
```

They remain explicit experimental options for diagnosis. Physical previews run only in the planner worker, never in the local physics-substep executor. Non-finite or untrackable candidates cannot win selection. Preview state cannot change the live car, surface, damage budget or controller. The nominal evaluator records terminal retained clearance separately from its legacy transient-clear flag; the default route ranking remains the passing baseline.

The current tactical limitation is therefore still present: an independent short rival forecast and ideal route tracker do not reliably value a real corner-exit pass. A validated recovery fix does not justify claiming this planner problem is solved.

## Verification

All 15 regression groups pass, including the existing retained-pass and braking regressions and the new real-race close-start regression. `trajectory-check.mjs` also covers private-state isolation, controller memory reset, dry/wet integration agreement, non-finite rejection, terminal clearance and low-speed recovery.

The matched normal-start Solenne race (three laps, fifth on the grid behind INTERCEPT/RAZOR/APEX/TEMPEST, seed 7, pit calls disabled) is identical with recovery on and off: 187.958 s, fifth, three legal laps, no damage, no retained passes and no bridge errors. Reports: `recovery-solenne-3lap-candidate.json`, `recovery-solenne-3lap-parent.json`.

The matched Harbor Ring endurance check uses a standing start, fourth behind INTERCEPT/RAZOR/APEX, seed 7 and live pit strategy:

| 20-lap result | Previous controller | Recovery enabled |
| --- | ---: | ---: |
| Finish | 4th | 4th |
| Race time | 1366.283 s | 1367.500 s |
| Accumulated damage / illegal laps / bridge errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Ordinary legal laps / pit laps | 14 / 6 | 14 / 6 |
| Pit stops | 3 | 3 |
| Retained passes | 0 | 0 |

Recovery costs 1.217 s (0.089%) in this race. The cumulative damage ledger agrees with the independent positive-increment recorder, and the 20% race allowance remains intact. Local-controller p95 was 0.039 ms with recovery and 0.044 ms without; planner p95 was 1.151 and 1.284 ms respectively. These lockstep Node timings reflect the tested machine load, not rendered-browser latency or evidence of a speedup. Reports: `recovery-harbor-ring-20lap-candidate.json`, `recovery-harbor-ring-20lap-parent.json`.

All accepted comparison reports have unchanged source hashes throughout their runs, and those hashes match the final runtime files. The experiments are deliberately kept separate from the enabled recovery results.

The production game build passes (302 modules, 7.07 s). Its existing large-chunk warning remains. Build output is saved locally in `results/recovery-build.log`; regression output is in `results/recovery-checks.json`.

## Reproduce

Run from the repository root:

```powershell
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/passing-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/trajectory-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --drivers vanguard --seconds 40 --tag recovery-current
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --drivers vanguard --only harbor-equal-straight --attack-gap 6 --seconds 40 --tag recovery-close-start
```

For the prior controller on the same source, set `trackingRecovery: false` and keep all three experimental options above disabled. The reports record options, source hashes and any source changes during each run.
