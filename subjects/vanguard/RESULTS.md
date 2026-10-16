# VANGUARD continuation evidence — 16 October 2026

## Solo reliability and pace

The corrected `post-start-setup-v2` benchmark applies tyres and wear **after** the game's race reset, then records the actual starting state. Each case collects three laps scored by the game itself. All use seed 7, real game physics and the asynchronous planner/local executor path.

| Conditions | Start | Passing cases | Valid laps | Damage / bridge errors |
| --- | --- | --- | --- | --- |
| Clear, warm softs | Rolling | 10/10 | 30/30 | 0 / 0 |
| Rain, warm wets | Standing | 10/10 | 30/30 | 0 / 0 |
| Clear, warm mediums at 60% starting wear | Standing | 10/10 | 30/30 | 0 / 0 |

Each row covers all five tracks in GT3 and LMDh. This is deterministic coverage on one seed, not a measured probability of success across weather seeds or full endurance stints. Live pit strategy is disabled in these controlled solo fixtures.

Best clean laps in seconds on fresh dry softs:

| Track | GT3 | LMDh |
| --- | ---: | ---: |
| Harbor Ring | 61.308 | 52.083 |
| Solenne | 59.242 | 50.108 |
| Alpine | 71.967 | 60.333 |
| Desert | 77.842 | 65.125 |
| Nürburgring, full layout | 512.642 | 442.917 |

Reports: `results/continuation-release-dry.json`, `-wet.json`, `-worn.json`. They share implementation hash `c880551673314168a220acaaa75812c0042ecb935528643f34e2eaeda1304e83`. Subsequent combat-only changes are evaluated separately; these are not silently relabelled as a new combat experiment.

### The two failures found and fixed

- The original GT braking envelope was too optimistic under combined braking and turning with low grip. The wet Nürburgring trace first loses the rear around s=17,100 m; it is not a formation-start failure. Disabling wet-line morphing reproduced the failure.
- Heavily worn Harbor GT also failed from a standing start, ruling out the initial handover-only explanation.
- Reserving more lateral force in the GT braking forecast changes wet Nürburgring from 0/3 valid laps with 32.3% accumulated damage to 3/3 valid with zero damage. Worn Harbor changes from 2/3 valid with 19.2% accumulated damage to 3/3 valid with zero damage. Both the base profile and tactical corridors use this forecast. Fresh dry GT settings remain unchanged.

Earlier wet rolling-start checks also exposed faults while the shared formation controller owned applied controls. Standing-start passes do not establish that those rolling-start cases are fixed; formation/handover work remains separate.

## Contracts, passing and hazards

- The original mixed-grid regression had 207 contact samples and 7.65% damage. It now requires **zero** contact and damage, and passes.
- All six encounter checks pass: retained clean pass, delayed retained pass, following-only control, slower-class pass, stopped hazard and spun hazard.
- The full traffic suite passes: three-car train, following control, injected latency spikes, staggered traffic, early-braking target, stopped car and spun car. Passes are retained, and hazard evasion is not counted as overtaking.
- Unit/contract checks cover finite control arrays, stale epochs/sequences, exact short Vehicle prediction without live-state mutation, surface limits and staged wet geometry, clean-air learning contamination, and switchback geometry.

These focused scenarios prove specific behaviours. They do **not** establish dominance against equal-pace opponents in full races. The initial five-car spot checks showed attempted attacks with poor clean-pass conversion; contact-assisted passes remain separate from clean manoeuvres.

### Investigation of conservative combat

Short, sequential CPU-only checks compared the existing racer with earlier commitment to a partial corner advantage, and with smaller side-clearance settings. Five-car, three-lap standing-start races used the real INTERCEPT/RAZOR/APEX/TEMPEST drivers. Solenne LMDh used seeds 7 and 19; Harbor GT used seed 7.

- The traced Solenne race rejects some otherwise useful lanes because they do not reach the existing 5 m final-gap threshold within the 3.4 s rollout. Other returns begin when the chosen side no longer fits through the next corner. Only about 0.75 s of the sampled race used the new alongside-return yielding brake, so that safeguard does not explain the whole behaviour.
- Earlier commitment raised declarations from two to eight or nine in Solenne, but produced no retained passes and finished second rather than first. The existing first-place control pass was contact-assisted, not a clean combat win.
- Smaller side-clearance settings produced one clean pass in each Solenne seed, but the place was lost again. On seed 19 accumulated damage rose from about 1.66% in the control to 3.15% with the combined change. Harbor did not demonstrate a passing benefit.
- The initial unrestricted earlier-commitment experiment also regressed the clean passing fixture. The experimental commitment code and tighter default clearances were **not retained**. Failed reports remain available in `results/combat-*.json`.
- A distinct ranking bug **is fixed**: candidate selection used to choose the highest-score lane before checking its collision budget, allowing an unsafe winner to hide another usable route. Candidates now compete only inside the unchanged fit and collision limits; a permanent regression covers both candidate orders.

The next meaningful combat work is a manoeuvre that can create and keep an advantage through corner entry and exit, with a valid fallback before overlap. Measure retained clean positions after the following corner and at the finish, not attack declarations or one-second overlap alone. More contact tolerance or a blanket aggression increase is not supported by these results. No RL/GPU training or unattended queues were launched for this investigation.

## Browser and build

The independent browser fixture ran the real race loop with three actual WebWorkers for 20 simulated seconds at each requested cadence. It has no 3D renderer.

| Requested / actual frame rate | Host update p95 / p99 | Reply p50 / p95 | Errors / contacts / damage |
| --- | --- | --- | --- |
| 60 / 48.0 fps | 0.100 / 0.200 ms | 0.800 / 2.300 ms | 0 / 0 / 0 |
| 30 / 28.7 fps | 0.100 / 0.200 ms | 0.800 / 2.300 ms | 0 / 0 / 0 |

These timings include controller work and transport under the tested machine load, not whole-game FPS or a guaranteed latency budget. The full rendered game also opened successfully with VANGUARD versus INTERCEPT.

The production build passes. Its existing large-chunk warning remains; no unrelated bundle refactor was introduced.

## Boundaries of this continuation

For the subsequent five-driver combat screen, CPU regression fixes and rejected
experiments, see [COMBAT-REVIEW-2026-10-17.md](COMBAT-REVIEW-2026-10-17.md).
Its results are separate from the earlier solo matrix and do not establish an
overall championship ranking or a new same-class passing gain.

Argon's architecture is retained. The short arrival predictor calls the original vehicle physics, while the longer tactical rollout remains approximate. Explicit switchback selection, online adaptation and wet-line selection need broader race-level evidence. No zero-allocation or universal performance claim is made.

The original audit, all failed diagnostics and large traces remain available locally. Version-1 compound/wear comparisons are superseded because their requested tyres were reset before driving. Generated reports are ignored by Git to avoid committing large traces.
