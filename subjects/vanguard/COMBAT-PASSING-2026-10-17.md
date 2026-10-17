# VANGUARD: completing attacks from behind

This follows the [close-racing upgrade](UPGRADE-2026-10-17.md). The core remains Argon's local force controller plus asynchronous C2 corridor planning. The new default GT `adaptiveAttacks` setting changes how an existing attack is replanned and retained. Prototypes retain their tested calibration with this option disabled. It does not increase engine power, change game physics or weaken the independent passing score.

## What is retained

1. **Replan a losing corridor.** Previously a low-risk passing route could stay locked for 7.5 s even when its short forecast lost more than 2 m of progress and more than 1 m/s of exit speed against the base route. If the rival is still fully ahead, that combination now triggers reconsideration. A new route still has to meet the existing geometry and collision checks. This is not an unconditional switch to the racing line.
2. **Distinguish entering a lane from owning one.** Once the cars overlap, the driver checks their actual body positions, signed side, relative headings and lateral closing speed. An aligned, established lane can remain admissible even when there is insufficient room for a *new* pull-out at a future station. The exception needs an eligible rival, an available rubbing budget, forecast risk below 0.12 and no predicted hard impact. A crossing car, fast squeeze, deep lateral overlap, opposite-side claim or car still fully ahead cannot use it. Normal collision, local braking and damage-budget checks remain active.
3. **Keep the occupied route when it remains useful and safe.** The 7.5 s timer alone no longer expires an established overlap. The route still has to have enough remaining length, acceptable forecast risk and an unchanged target corridor. Fully clearing the rival retains the original clearance and retention rules.
4. **Validate a new alongside route.** The original automatic alongside branch only checked a short longitudinal gap and maximum lateral distance, then committed a corridor without evaluating it. In adaptive mode, it needs actual body-space ownership and an admissible rollout before changing state. A failed candidate releases its pool slot and falls through to the regular planner.
5. **Protect a fast approach to a lateral merge.** The route-based following guard previously covered slower backmarkers but missed slower same-class cars that were no longer braking. In GT adaptive mode it checks both, keeps looking inside 5 m and adds a 0.15 s sample for a close merge. A physical lateral-closing check looks 0.45 s ahead when following a significantly slower car whose body is converging on our lane; active passing lanes keep the original shorter horizon. Clear adjacent lanes do not cause braking. Regression checks cover both the forecast and a physical merge missed by that forecast.

The debug trace now includes the route's total time cost. The benchmark accepts `--attack-gap` between 6 and 30 m for ordinary same-class approaches. Its default remains 14 m; doors, defence, braking and backmarker fixtures keep their existing starts. Reports record the requested gap and actual initial states. The score still needs four continuous seconds fully ahead at the finish, legal driving by both cars, a healthy rival, and at most 1% damage per short encounter. Rubbing passes remain separate from clean passes.

## Reading the comparison

Accepted reports use the `pass-release-` prefix in `results/`. Each control runs the same final source with `adaptiveAttacks: false`; candidates use the deployed defaults, including the prototype override. This makes the option the only driver-behaviour difference. Solo rival controls, actual starts, source hashes and source changes during each run are recorded. Earlier `pass-final-` reports describe a rejected intermediate version and are superseded.

The original durations (25 s for approaches and 35 s for door-to-door cases) and the extended 40 s encounters are reported separately. The longer duration gives a pass time to finish through the next corner; it does not reduce the required retention or permit a place lost again to count. Do not compare a 40 s candidate directly with a 25 s control.

### Matched 40 s encounters

| Metric | Adaptive attacks off | Deployed defaults |
| --- | ---: | ---: |
| GT passes from following starts / 8 | 0 | 1 |
| GT door-to-door attack passes / 2 | 2 | 2 |
| Prototype passes against GT backmarkers / 2 | 2 | 2 |
| All retained racing passes / 12 attacks | 4 | 5 |
| Clean passes / 12 attacks | 2 | 2 |
| Successful defences / 4 | 3 | 3 |
| Following/braking successes / 2 | 2 | 2 |

Both sets have 18 healthy matched rival controls, no source changes during execution, no bridge errors, no off-track cases and no severe impacts. Every previously successful passing case remains successful. These are small prepared fixtures, not a championship or a statistical claim about all racing.

The newly converted Solenne momentum case finishes 20.22 m ahead and remains body-clear for 11.73 s. The control finishes 28.75 m behind. Both cars take 0.659% damage in the new result, from 12 classified gentle side-contact impulses with peak normal closing speed 1.78 m/s. This is an acceptable rubbing pass, not a clean pass. The two 40 s braking cases both finish without contact or damage on the final source. Reports: `pass-release-extended-control.json` and `pass-release-extended-candidate.json`.

### Shorter tests and start variation

- **Original 18-scene durations:** both modes retain 4/12 passes, 3/4 defences and 2/2 braking successes. The new following-start pass completes after the old 25 s approach cutoff. Reports: `pass-release-legacy-*`.
- **Closer 8 m following starts, all eight GT approaches, 40 s:** neither mode retains a pass. Reports: `pass-release-gap8-*`.
- **Four momentum/worn-rival approaches shifted by -8 m and +8 m, seed 19, 40 s:** neither mode retains a pass in either shifted set. Reports: `pass-release-shift-minus8-*` and `pass-release-shift-plus8-*`.

All these comparisons have healthy controls, zero bridge errors, no off-track or severe-impact cases, no non-rubbing contacts, and no source changes. The shifted starts do **not** confirm a broad passing improvement. This release demonstrates one additional converted opportunity while preserving prior wins; initiation and robustness across road sections remain weak.

An additional eight-case 6 m following-start stress test is a known limitation, not a passing gain: neither mode wins a pass, and Harbor equal-straight fails identically in both modes with 10.605% damage and 24.758 s off track. The matched solo rival remains healthy. This close-start failure predates the adaptive behaviour and is not fixed here. Reports: `pass-release-gap6-*`; do not include these in the zero-off-track statement for the comparisons above.

### Normal-start race check

Solenne GT, three laps, standing start, seed 7, fifth on the grid behind INTERCEPT / RAZOR / APEX / TEMPEST, with pit calls disabled:

| Metric | Adaptive attacks off | Deployed defaults |
| --- | ---: | ---: |
| Finish | 5th | 5th |
| Own race time | 190.408 s | 187.958 s |
| Accumulated damage | 3.396% | 0% |
| Illegal laps | 0 | 0 |
| Retained passes in the driver book | 0 | 0 |

The new mode avoids the failed close encounter and finishes 2.45 s sooner, but does not gain a finishing place or overtake in this race. Reports: `pass-release-solenne-gt-race-control.json` and `pass-release-solenne-gt-race-candidate.json`. This is one fixed grid and seed, not a reliability estimate.

### Twenty-lap check

Harbor Ring GT, 20 laps, standing start, seed 7, fourth on the grid behind INTERCEPT / RAZOR / APEX, with live pit strategy:

| Metric | Adaptive attacks off | Deployed defaults |
| --- | ---: | ---: |
| Completed laps / finish | 20 / 4th | 20 / 4th |
| Own race time | 1366.292 s | 1366.283 s |
| Accumulated damage | 0.486% | 0% |
| Illegal laps | 0 | 0 |
| Pit stops | 3 | 3 |
| Retained passes / places lost in the driver book | 1 / 1 | 0 / 0 |
| Nose hits / severe impacts / bridge errors | 0 / 0 / 0 | 0 / 0 / 0 |

The damage ledger matches the independent positive-increment recorder exactly in both modes, including repairs. The 20% race allowance is preserved. Both record 14 ordinary legal laps and six pit laps. Reports: `pass-release-20lap-control.json` and `pass-release-20lap-candidate.json`.

There is **no full-race overtaking gain** in this check. The new mode has fewer position exchanges, the same finishing place and effectively identical time. The demonstrated benefit is the additional controlled GT pass and fewer damaging failed encounters, not a new overall race winner. In this Node lockstep check, the local controller's p95 is 0.040 ms versus 0.041 ms for the control; this is not rendered-browser latency.

## Verification

All 14 regression groups and the production game build pass on the final runtime. The new `passing-check.mjs` runs a matched healthy INTERCEPT control, reproduces the old failed opportunity, then requires the candidate to complete and retain the pass within the existing damage/legality contract. It also reruns both braking-leader cases for 40 s; the Solenne case catches a late crossing collision missed by the shorter test. Body-ownership checks cover the wrong side, insufficient space, a rival still ahead, crossing/hazard cars, fast lateral closure and heading wrap. Existing zero-contact prototype passing, traffic, hazards, latency, damage-ledger, surface and predictor checks remain intact. The build's existing large-chunk warning remains.

## Experiments rejected

- Earlier partial pull-outs did not add retained passes and created sustained rubbing in the braking-leader test. That rule is removed.
- Raising the overall pace margin to 1.0 did not convert the four tested momentum/worn-rival encounters. It is not enabled.
- Long static road-width lookahead and switching the chosen side suppressed the useful passing gain. That planner extension is removed.
- Broadening the return guard to cover every partly passed rear rival regressed the original clean prototype pass. The original return logic is retained.
- Lowering the damage-cooldown threshold did not address the actual sustained-contact cause. Its original threshold remains.
- Increasing the replan hysteresis erased the measured retained-pass conversion. That later calibration was reverted; the retained files were checked byte-for-byte against the passing release reports.

There is one updated racer configuration, rather than several deployable experimental arms. All simulations run sequentially at below-normal CPU priority, with no GPU training or unattended queue.

## Reproduction

Run from the repository root:

```powershell
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/passing-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --drivers vanguard --seconds 40 --tag passing-current
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --drivers vanguard --seconds 40 --attack-gap 8 --tag passing-closer
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/probe.mjs --track harbor-ring --cls gt --start standing --ids intercept,razor,apex,vanguard --race-laps 20 --time 2100 --strategy --out passing-endurance.json
```
