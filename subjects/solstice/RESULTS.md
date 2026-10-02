# Measured results

The graphics-base verification retains a **62.033-second clean lap** in a normal
GT/soft/20-lap Harbor race. Its eight clean hard-tyre laps fade by **2.833
seconds**, within the requested 2-4-second allowance. The complete isolated
race records zero off-track time, contacts, rescues, or controller errors.
The new combat evidence is separated below from the released `c01544c`
baseline. The earlier combat run measured 2.950 seconds of fade. Changeable
weather coverage exposes contacts and pit-lane recoveries below. Neither set
establishes universal wins or 62.5-second laps on every compound.

All public measurements, inputs, and source hashes are in
[compact-summary.json](results/compact-summary.json). Large local frame traces
are excluded from Git. No lap time below is a predicted envelope time.

## Conditions and definitions

The upgraded game is based on `2935523`, with its normal compound-specific
tyres, fuel consumption, wear, pit service, mandatory stops, and driver swaps.
These runs use GT cars, ALIEN difficulty, and the native 1/120-second physics
step. Clear-weather runs use sun 0.6. Starting tyres are soft; the unchanged
game strategist chooses subsequent sets. SOLSTICE bypasses its governor only
at native ALIEN base difficulty. Other drivers keep their upstream behavior.

A clean flying lap excludes pit and invalid laps; the first timed lap begins
at the first line crossing, after the grid approach. Race finish times include
the approach and pit losses. Stint fade is the maximum minus minimum clean lap
within one uninterrupted tyre stint. Contacts are field-wide contact-step
events, not attributable per-car incident counts. Bridge timing uses elapsed
time around updates, not an operating-system CPU counter.

## Baseline Harbor 20-lap run (`c01544c`)

`release-final-harbor-soft20-stations.json`: seed 7, marathon resource scaling,
one SOLSTICE car, no experimental overrides, 20 completed laps, three stops.
Finish time is **1434.467 seconds**. Source hashes are unchanged during the run.

| Tyre stint | Clean laps | First / last clean lap s | Maximum fade s |
|---|---:|---:|---:|
| Opening soft | 1-2 | 62.033 / 63.625 | 1.592 |
| Medium | 5-7 | 64.858 / 66.150 | 1.292 |
| Second soft | 10 | 64.183 / 64.183 | 0.000 |
| Hard | 13-20 | 65.883 / 68.592 | 2.708 |

The opening soft set still needs an early stop. Hard tyres provide a much
longer measured stint within the requested 2-4-second fade allowance. This
configuration retains tyre-aware pace rather than forcing every set to survive
the same stint length.

The first clean lap's 500-600 m straight section averages **234.410 km/h** at
full throttle with no brake. The braking approach at 700-800 m averages
210.870 km/h; 800-900 m through the first corner averages **142.978 km/h**.
These are 100-metre section averages, not instantaneous minimum speeds.
Throttle returns to 1.0 in the 900-1000 m section. The braking phase and exit
momentum are present in the actual controls and physics.

Short opening probes for seeds 17 and 31 each record a 62.033-second first
clean lap and a second below 64 seconds. They are partial runs, not three
complete endurance races. Extra rear rotation requires one rear tyre to be
both above its own optimum plus 4 degrees C and worn beyond 12%; no rotation
gate violation or active governor cut occurs in the final 20-lap trace.

## Pairing with a 65-second human

`release-pair-estimate-harbor20.json` is an analytical estimate using the user's
65-second human average and measured post-pit SOLSTICE stint prefixes. Every
stop alternates drivers and charges the measured in/out-lap loss once. The
median loss is **38.500 seconds**, already including the native driver swap.
AI stint fade is constrained to at most four seconds.

| Stops and swaps | Estimated 20-lap time s | Assumed maximum human stint |
|---:|---:|---:|
| 2 | 1382.558 | 8 laps |
| 3 | 1416.450 | 8 laps |
| 4 | 1452.367 | 8 laps |
| 5 | 1490.050 | 8 laps |

Under those assumptions the quickest schedule is human 8 laps, SOLSTICE 4
hard-tyre laps, human 8 laps. More stops remain eligible if they improve total
time; they are not rejected merely because the AI alone would stop less often.
If the human can sustain only four laps, the best estimate instead uses three
swaps and takes **1435.400 seconds**. Six-lap human reach gives 1393.125 seconds.

These are not achieved human/AI race times. Human fuel and tyre reach, repeated
reuse of an AI stint profile, and future pit losses are assumptions. The model
does not alter the game strategist or invent human controls. An isolated
20-lap Gemini v4 reference finishes in 1443.633 seconds with two stops and two
rescues; comparison with that one reference is not a guaranteed paired win.

## Twelve-lap comparison against Gemini v4

GT/soft starts, seed 7, clear daylight, two teams, classic 12-lap resource
scaling, no experimental overrides. Both cars complete all 12 laps.

| Circuit | SOLSTICE best / median s | Gemini best / median s | SOLSTICE / Gemini finish s | Position | Stops SOL / Gemini |
|---|---:|---:|---:|---:|---:|
| Harbor | 63.375 / 64.542 | 66.533 / 67.308 | 896.467 / 859.125 | 2 | 3 / 1 |
| Solenne | 60.892 / 62.112 | 65.167 / 65.875 | 886.650 / 839.000 | 2 | 3 / 1 |
| Alpine | 76.325 / 78.621 | 78.833 / 79.292 | 1037.333 / 1038.633 | 1 | 2 / 2 |
| Desert | 80.458 / 82.896 | 82.350 / 82.754 | 1047.908 / 1048.883 | 1 | 1 / 1 |

SOLSTICE records zero off-track time, rescues, and controller errors in each.
There is one field-wide contact step at Harbor and zero on the other tracks.
Extra stops outweigh SOLSTICE's quicker clean laps in Harbor and Solenne's
all-AI races. All four circuits have separate optimized GT lines and control
reserves; their success is not inferred from the Harbor hotlap.

These `release-verified` comparisons precede the final conditional wet-weather
and slow-update guards. Their recorded source hashes identify that revision;
they are not presented as reruns of the exact final source. The final source
is covered by the complete Harbor and held-update runs below.

## Baseline verification (`c01544c`)

| Check | Result |
|---|---|
| Controller checks | 19 passed, zero failed |
| Production game build | Passed, 152 modules; existing bundle-size warning |
| Final Harbor, 30 Hz held controls | 20 laps, best 63.933 s, finish 1445.983 s |
| Final Harbor, 20 Hz held controls | 20 laps, best 63.650 s, finish 1446.158 s |
| Final Harbor, rain/night, seed 17 | 6 laps, best 70.583 s, finish 515.083 s |
| Alpine overcast/night, seed 31, earlier recorded revision | 6 laps, best 79.183 s, finish 566.725 s |

Every listed held-update or weather run has zero off-track time, contacts,
rescues, controller errors, and nonfinite state. Held-control runs delay outputs
one physics frame; they approximate transport cadence and do not measure actual
browser worker throughput. Direct browser observation separately verified
the gold aim-point, driving intent, and roughly 2.8-3.3 ms worker responses.
Its first lap in traffic was 66.517 seconds and is not a clean hotlap benchmark.

The checks cover controls-only/deep-frozen host state, native prediction parity,
compound/wheel independence, legal line footprints, braking authority, the
temperature-and-wear rotation gate, traffic corridors, countdown priming,
pit release, recovery, cadence metrics, per-car finish accounting, and the
paired schedule's swap costs and fade constraint. Physics, tyre rules, timing,
the strategist, difficulty reference pace, and other AI code are unchanged.

Universal mixed-field wins across all four circuits and three full-race seeds
remain unproven. No claim is made that the physics prevents a faster result.

## Combat revision acceptance (2026-10-02)

The changes are confined to SOLSTICE's traffic planning and driver selection.
The line asset, geometry, configuration, force policy, tyre physics, pit
strategist, governor and other AIs are unchanged. Upstream rendering commits
through `524bd1b` do not change the native simulation inputs used here.
Each measurement retains source hashes; the older `release-*` entries remain
baseline evidence rather than being relabeled as tests of this revision.

### Controlled encounters

`combat-baseline-30.json` and `combat-accepted-30.json` compare matched 10-second
encounters at 30 Hz, with native 120 Hz physics. Placement, starting speed and
warm hard tyres are fixtures; the rival uses the native force policy at a fixed
lane and speed cap. The baseline's global rear-wear label predates per-fixture
metadata: passing fixtures use 5% wear, and only `setup.worn` fixtures use 75%
rear-right wear. These are targeted tests, not endurance race results.

| Encounter | Baseline pass time s | Combat pass time s |
|---|---:|---:|
| Straight, 40 m initial gap | 7.975 | 3.175 |
| Straight, 22 m initial gap | 8.008 | 3.925 |
| Straight, offset rival | 2.942 | 2.775 |
| Gentle right | 4.992 | 5.075 |
| Gentle left | 3.467 | 3.208 |

Free-run progress is identical for all seven matched baseline fixtures. The
gentle-right pass is slightly slower; the gains are not uniform in every turn.
All nine accepted encounters at each of 20, 30 and 60 Hz finish without
contacts, off-track time, stops below 5 m/s, damage or bridge errors. Straight
passes establish more than 2.59 metres of lateral centre separation while the
bodies overlap longitudinally. Worn-tyre defensive encounters retain the lead.

The tougher 14-metre rear-pressure fixture reproduced excessive braking in an
intermediate combat candidate. `combat-pressure-close-30.json` and
`combat-pressure-accepted6.json` are matched six-second tests of that candidate
and this accepted revision, respectively; the former is not the `c01544c`
baseline. Minimum speed improves from **56.372 to 94.414 km/h**, and progress
relative to free running improves from **85.80% to 94.64%**, with no contact or
lost lead. In the longer ten-second test the accepted revision retains
94.84-95.79% of free progress across the three update rates. Actual overlaps
and lateral/rejoining threats remain penalized in the native rollout.

### Complete native races

The five `combat-*-accepted*.json` race measurements use normal GT resources,
soft starts, native ALIEN difficulty and the unchanged automatic pit planner.
All races complete; none is a partial first-lap probe.

| Race | SOLSTICE best clean lap s | Result |
|---|---:|---|
| Harbor solo, 20 laps, seed 7 | 62.033 | Finish 1433.683 s; three stops/swaps |
| Harbor vs Gemini v4, 12 laps, seed 7 | 63.075 | SOLSTICE 895.325 s; Gemini 858.150 s |
| Solenne vs Gemini v4, 12 laps, seed 7 | 61.017 | SOLSTICE 887.225 s; Gemini 839.000 s |
| Harbor, two SOLSTICE/two Gemini, 6 laps, seed 17 | 62.383 / 63.692 | SOLSTICE P2/P3; all four finish |
| Harbor, four SOLSTICE, 6 laps, seed 31, 30 Hz held | 63.492 fastest | All four finish; one physics-frame delivery delay |

All five races have **zero field-wide contacts, off-track time, damage,
controller errors or nonfinite state**. SOLSTICE has zero rescues throughout;
Gemini has one rescue in the Harbor 12-lap comparison. The held-control race
approximates transport cadence and does not establish browser worker throughput.

The solo hard stint runs from lap 13 to lap 20 in 65.583, 66.083, 66.742,
66.517, 67.133, 67.225, 67.575 and 68.533 seconds: **2.950 seconds of fade**.
Rear-right tyre wear at the last line is 70.70%, leaving 29.30%. The existing
opening pace and sustainable hard-stint behavior are retained. AI-only
12-lap races still lose to Gemini through three stops versus one; the user's
human soft opening followed by SOLSTICE on hards is a different schedule.
This combat update does not change compound choices or paired strategy.

The final controller suite passes **29 checks**, including held-control
straight passes, close rear pressure, side commitment, defense rearming,
turn-in lane closure, and the reproduced native corner encounter. The normal
production game build passes with the existing bundle-size warning.

## Graphics-base verification (`bf90515`)

`solstice-combat` was rebased onto `origin/graphics-aaa`. The incoming native
changes add Changeable weather fronts and an optional weather seed defaulting
to the race seed. The driving configuration, line asset, force policy and
combat implementation were not retuned. The controller suite again passes
all 29 checks, and the production build passes with 159 modules and the
existing bundle-size warning.

`graphics-dry-harbor20.json` repeats the seed-7 GT/soft/20-lap isolated race:
best clean lap **62.033 s**, finish **1433.750 s**, three stops/swaps, zero
contacts, off-track time, damage, rescues or controller errors. The lap 13-20
hard stint ranges from 65.583 to 68.417 s, giving **2.833 s of fade**, within
the requested 2-4-second allowance. This differs slightly from the earlier
2.950-second run; the measured opening pace is identical.

`graphics-combat-30.json` repeats all nine 30 Hz controlled encounters.
Every passing time, progress ratio and free-run progress matches the earlier
accepted 30 Hz report exactly, including straight passes in 3.175/3.925 s and
94.414 km/h minimum under close rear pressure. All nine have zero contacts,
off-track time, damage, stops below 5 m/s and bridge errors.

### Changeable weather findings

Two normal 12-lap SOLSTICE/Gemini v4 races use native fronts, default seeded
weather, ALIEN difficulty, soft starts, sun 0.6 and unchanged pit strategy.
Both encounter dry, building, shower and clearing phases, substantial wetting
and drying, and a fully dry track between showers. All four cars finish with
finite state and zero controller errors. They do **not** meet a clean-race
weather acceptance criterion.

| Race | SOLSTICE finish s | Field car-pair contact steps | SOLSTICE off-track s | SOLSTICE damage | SOLSTICE rescues |
|---|---:|---:|---:|---:|---:|
| Harbor, seed 7 | 965.667 | 0 | 5.492 | 3.36% | 1 |
| Solenne, seed 31 | 977.358 | 19 | 0 | 37.52% | 1 |

Track wetness ranges from 0 to 0.931 at Harbor and 0 to 0.907 at Solenne.
All 19 Solenne contact steps occur with rain above 0.02 and wetness at least
0.08. These are repeated field-wide overlap steps, not 19 independent crashes;
the engine records zero severe car-pair contacts and a peak closing speed of
2.715 m/s. Damage also includes barriers and is not attributed solely to combat.
The field counter includes the host's continued motion after a car finishes.

Solenne's native event log identifies Gemini's recovery at **494.900 s** and
SOLSTICE's at **629.592 s**, both in **PIT LANE** during the shower. SOLSTICE
recovers at wetness 0.838 before service completes at 656.642 s. Gemini also
records 33.700 s off track, 82.87% damage and one rescue. Wet pit-lane handling
and traffic merit further investigation; no control or strategy tuning was
applied in response to these findings.

SOLSTICE's Harbor calls are TYRES on laps 3/6 and PLAN on lap 10, choosing
soft/medium/soft. Solenne calls TYRES on laps 4/11 and PLAN on lap 8, choosing
medium/soft/soft. Calls follow the existing fuel, degradation and race planner;
the game exposes only soft/medium/hard compounds, and the strategist does not
consult weather. For example, Harbor's lap-10 call requests softs at wetness
0.886 during the shower. This is recorded behavior, not proof that a different
available compound would be faster.

`weather-probe.mjs` adds a read-only observer through the benchmark's `onStep`
hook. Public summaries preserve fronts, pit calls/services, lap weather and
available native event logs; periodic frame samples remain local. The first
lap's weather accumulation includes the grid approach, while its lap time uses
the native full-lap clock. Source hashes identify the observer revision used
for each run; the Solenne run includes the subsequently added native event log.

## Reproduce

Run the commands in [README.md](README.md). A full native Harbor trace uses:

```powershell
$env:SOLSTICE_PROBE = '{"track":"harbor-ring","compound":"soft","laps":20,"seconds":1800,"output":"subjects/solstice/results/example-final-stations.json"}'
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/station-probe.mjs
node subjects/solstice/tools/pair-model.mjs subjects/solstice/results/example-final-stations.json --output subjects/solstice/results/example-pair.json
```

Clear `SOLSTICE_OPTIONS` before reproducing the shipped configuration. The
public summary retains each run's actual input and provenance. To curate it,
pass explicit raw result basenames to `tools/publish-results.mjs`; `report.mjs`
reads the compact summary without replacing this acceptance record.
