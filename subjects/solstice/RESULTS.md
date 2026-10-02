# Measured results

The final Harbor configuration achieves a **62.033-second clean lap** in a
normal GT/soft/20-lap race. Its eight clean hard-tyre laps fade by **2.708
seconds**. The complete isolated race records zero off-track time, contacts,
rescues, controller errors, or violations of the warm-and-worn rotation gate.
This meets the requested opening-lap and hard-stint checkpoints; it does not
establish universal race wins or 62.5-second laps on every compound.

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

## Final Harbor 20-lap run

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

## Final verification

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
