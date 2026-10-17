# VANGUARD: more retained passes and a fresh comparison

One new same-class passing opportunity now converts, while all previous passing, defence and braking successes remain. This is an incremental combat improvement, not evidence of an overall championship winner. There is one updated VANGUARD configuration, with no new trained models or GPU workload.

## What changed

The previous planner rejected a useful attack setup if its short forecast did not put the car close enough to the rival. When an attempt did begin, its 7.5-second lane-holding window could expire while it was still gaining ground. In the Harbor worn-tyre encounter it reached the corner, abandoned its lane, and followed again.

The new setup applies to a same-class rival with a measurable tyre-grip disadvantage. Measured closing speed and the paired route forecast must both show a gain. Entry must finish before the estimated bumper gap closes, with a fitted road corridor, very low predicted contact risk, a better exit, and no hard-braking rival or predicted heavy impact.

Only an attack newly admitted by that setup gets extra patience. It must keep reducing the gap by at least half a metre within 2.5 seconds. Existing risk, moving-rival, remaining-road and tracking checks still apply; a stalled move still aborts. Existing attacks and prototype calibration keep their validated rules. The setup marker is carried through the worker/executor route contract, and rejection diagnostics are available in the planner's debug candidates.

The original architecture remains: a fast local force controller follows spatial C2 corridors selected by an asynchronous planner. This does not enable the previously rejected long physical rollouts, extra headway or return preview. Rubbing remains budgeted against 20% cumulative damage over a 20-lap race, including damage repaired in the pits.

## Matched passing result

The benchmark uses the actual game race loop and async-seat protocol at deterministic 60 fps. Every rival has a matched healthy solo control. A racing pass requires four continuous seconds fully body-clear at the finish, useful healthy progress, no illegal running, no reset or errors, at most 1% damage per car, and only gentle side rubbing. These scoring rules are unchanged.

| Result | Previous VANGUARD | Updated VANGUARD |
| --- | ---: | ---: |
| All attacking encounters | 5/12 | 6/12 |
| GT passes, including alongside starts | 3/10 | 4/10 |
| GT passes starting behind | 1/8 | 2/8 |
| Zero-contact passes | 2/12 | 2/12 |
| Defence | 3/4 | 3/4 |
| Braking disturbances | 2/2 | 2/2 |
| Off-track cases / severe impacts / bridge errors | 0 / 0 / 0 | 0 / 0 / 0 |

The new pass is Harbor Ring against INTERCEPT on worn tyres, from a 14 m centre gap. It finishes 63.98 m ahead and is continuously body-clear for the final 26.69 s. There is one gentle side-contact impulse, at 1.23 m/s normal closing speed, causing 0.370% damage to each car. Both cars remain healthy and legal. It is a rubbing pass, not a zero-contact pass.

The previous controller finishes 6.37 m behind without contact. Reports: `results/attack-round2-parent.json`, `results/attack-round2-final.json`. The permanent real-race check in `tools/passing-check.mjs` requires this conversion in addition to the earlier retained pass, braking and close-start regressions.

## Comparison with the other current racers

These are 18 prepared encounters on Harbor Ring and Solenne: 12 attacks (including two prototype/backmarker cases), four defences, and two braking disturbances. The four opponents' results come from the fresh common-code `combat-round2-baseline.json`; VANGUARD's updated result comes from `attack-round2-final.json` on the same fixture and scoring code. Game, rival and benchmark dependencies are checked by source hashes, and all reports record source changes during execution.

| Racer | Racing passes / 12 | Zero-contact passes / 12 | Defence / 4 | Braking / 2 |
| --- | ---: | ---: | ---: | ---: |
| **VANGUARD, updated** | **6** | 2 | **3** | **2** |
| RAZOR | 5 | **5** | 1 | 1 |
| INTERCEPT | 2 | 2 | 2 | **2** |
| TEMPEST | 2 | 2 | 1 | **2** |
| APEX | 0 | 0 | 0 | 0 |

VANGUARD leads the accepted racing-pass count in this screen and handles more defence/braking cases than RAZOR. RAZOR's successful passes are cleaner: all five have no contact, versus two for VANGUARD. INTERCEPT is a reliable follower here but converts fewer passing opportunities. These measurements do not cover every historical driver in the roster.

APEX's poor prepared-start result is a known recovery/fixture limitation. It must not be read as a normal-race pace ranking. Normal standing-start races and reversed grids are evaluated separately below.

## Normal races, grid effects and endurance

Four GT races use warm soft tyres, a standing start, three laps and seed 7. All five racers race together. The first grid is INTERCEPT / RAZOR / APEX / TEMPEST / VANGUARD; the second reverses it. Pit calls are disabled for these short comparisons.

| Racer | Harbor, first grid | Harbor, reversed | Solenne, first grid | Solenne, reversed |
| --- | ---: | ---: | ---: | ---: |
| VANGUARD | 5th | 1st | 5th | 1st |
| INTERCEPT | 1st | 5th | 1st | 5th |
| RAZOR | 3rd | 3rd | 3rd | 3rd |
| APEX | 4th | 4th | 2nd | 4th |
| TEMPEST | 2nd | 2nd | 4th | 2nd |

Every car completes all its laps legally without bridge errors. VANGUARD has 0.978% accumulated damage across its 12 laps, all in the Harbor race from pole, and records no retained passes in any of these four races. It can defend the lead but does not make its way through the field. The pole starter wins all four races, so these results are heavily influenced by grid order. They do not justify declaring VANGUARD the best overall racer. APEX's normal-start finishes also demonstrate why its prepared-start score needs that qualification.

VANGUARD's best laps are 62.533 / 61.592 s at Harbor and 59.800 / 59.942 s at Solenne in first-grid/reversed order. INTERCEPT's are 61.567 / 61.833 s and 59.717 / 59.467 s respectively. Passing consistency and clean-air pace both still have room to improve. Reports: `results/attack-round2-race-{harbor-ring,solenne}-{back,front}.json`.

The Harbor 20-lap live-strategy check finishes fourth in 1367.500 s, with no damage, no illegal laps, three pit stops, no retained passes and no bridge errors. Its cumulative allowance remains 20%. This matches the preceding recovery version's result and does not demonstrate a full-race passing gain. Report: `results/attack-round2-20lap.json`.

## Verification and limits

All 15 regression groups pass, including the new conversion and its healthy unsuccessful control. Unit checks reject too little road width, hard impacts, excessive risk, a faster rival, insufficient bumper time, a hard-braking rival, equal grip and a poor exit. The close-start recovery regression remains intact.

The earlier-entry change on its own did not add a pass. Longer forecasts and a broad join-geometry change lost existing wins. Applying extra patience to every attack also regressed a win and a braking case. Those versions are not deployed; the enabled setup is specifically bounded by the measurable grip and progress conditions above.

This still leaves six of the eight original GT approaches from behind without a retained pass. A prepared-fixture win does not establish better full-race finishing positions or broad generalisation.

Moving each of the four momentum/worn-tyre approaches by -8 m and +8 m on seed 19 gives zero retained passes out of eight for both updated and previous VANGUARD. There are no off-track or over-budget cases in either arm. The new conversion is sensitive to the encounter's position on the track; this release does not claim that the gain repeats across road sections. Reports: `results/attack-round2-shift{-8,8}-{candidate,parent}.json`.

All accepted runs have no source changes during execution. The four other racers, game code and scoring code are byte-identical between the fresh common comparison and the updated VANGUARD checks, and all initial fixture states match. All simulations run sequentially at below-normal CPU priority, with no GPU training or unattended queue.

The production game build passes (302 modules, 6.84 s); its existing large-chunk warning remains. Verification output is saved in `results/attack-round2-checks.json` and `results/attack-round2-build.log`.

## Reproduce

Run from the repository root:

```powershell
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/passing-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/combat-bench.mjs --drivers vanguard,intercept,razor,apex,tempest --seconds 40 --tag current-comparison
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/probe.mjs --track harbor-ring --cls gt --path worker --ids intercept,razor,apex,tempest,vanguard --start standing --race-laps 3 --time 360 --seed 7 --out current-race.json
```

For the matched previous behaviour on the same source, set `progressiveAttacks: false`. Large JSON reports and traces remain local in the ignored `results/` directory.
