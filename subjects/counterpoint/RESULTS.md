# COUNTERPOINT status — 24 October 2026

**The non-RL challenger works, but ORACLE still wins the matched traffic tests.**
COUNTERPOINT remains experimental and excluded from automatic race grids. Its
tested admission, commitment, coasting, contested-space and smooth-return behavior
is now enabled for explicit COUNTERPOINT use. No neural
network, inherited RL policy or GPU training is used. Current implementation is
Sol-owned; Luna assistance is read-only review.

## What was built

- A separate tactical layer compares corridors against candidate-dependent
  hold-line, delayed-cover and mild-braking responses. Search is bounded to
  twelve candidates, three branches and six seconds, with a common horizon.
- VANGUARD v2 supplies course geometry, public-state observations, physical
  steering/axle control, hazard handling and stint strategy. This is an additive
  challenger, not a replacement physics engine or entirely new driving stack.
- A separate worker bridge sends stamped routes to a physics-rate executor.
  Validation rejects malformed, duplicate and stale-epoch replies.
- A frontal-guard extension checks held-speed and accelerating ego paths before
  preserving closing speed on an admitted corridor. Braking rivals, hazards,
  poor tracking and lost grip retain the ordinary guard.
- Staged overlap, setup moves and a short commitment window are implemented.
  They have not established an overall advantage over ORACLE.
- A coasting correction removes drive during an outward-growing path error at
  high lateral demand, restricted to the clear-air pace route. It preserves
  brake and steering commands and updates applied-control memory.
- CPU contract/integration checks and solo, encounter, traffic and actual
  Node-worker timing tools record tested options and source hashes.

## The useful measured fix

A hard-tyre Harbor Ring trace exposed continued throttle while tracking error
grew beyond two metres at near-full lateral load, preceding a rear slide and an
invalid first lap. Adding corrective braking made it worse and was removed.
Removing drive in that narrowly defined clear-air condition worked:

| Four-lap GT3 solo, same seed and hard tyres | Valid laps | Off-track time | Time from green | Best lap |
|---|---:|---:|---:|---:|
| Before coasting correction | 3/4 | 6.69 s | 259.40 s | 62.53 s |
| Coasting correction | 4/4 | 0 s | 255.57 s | 62.68 s |
| ORACLE reference | 4/4 | 0 s | 251.61 s | 61.83 s |

The correction saved 3.83 seconds over the attempt by avoiding a slide; it did
not improve the best lap. All three runs had zero damage. This is one matched
case, not a universal pace gain.

Sources in `results/`: `hard-solo-history-gt.json`, `coast-hard-solo-gt.json`,
`oracle-hard-solo-gt.json`. The rejected braking experiment is retained as
`envelope-hard-solo-gt.json`.

## Earlier matched traffic comparison

Harbor Ring, four laps, hard tyres, clear weather, no pit stops or cautions.
Two tested cars start at the rear of an eight-car field behind the same six
real rivals. GT3 uses seed 53; GTP uses seed 79. Both subjects completed all
four laps in every run. Entries are means of those two subjects, not
independent-seed confidence estimates. ORACLE retains its production main-thread
driver; COUNTERPOINT uses its worker planner and live executor.

| Class / driver | Time from green | Retained passes per car | Time held behind traffic | Mean damage |
|---|---:|---:|---:|---:|
| GT3 COUNTERPOINT, candidate options enabled | 276.43 s | 5.5 | 106.83 s | 5.13% |
| GT3 ORACLE | **260.17 s** | **6.0** | **29.48 s** | 5.79% |
| GTP COUNTERPOINT, candidate options enabled | 238.23 s | 5.5 | 74.05 s | 6.65% |
| GTP ORACLE | **220.27 s** | **6.0** | **8.20 s** | **3.11%** |

COUNTERPOINT loses about 16.26 seconds in GT3 and 17.96 seconds in GTP. Its two
GT3 cars recorded 2/4 and 4/4 valid laps; both GTP cars recorded 4/4. One GT3 car
took 10.26% damage and one GTP car 12.15%, so the means conceal substantial
variance. ORACLE had no off-track time in these fields; its GTP run included
one severe-contact event. Bridge errors were zero in all four reports.

The GTP candidate is about 13.88 seconds faster on mean finish time than the
initial prototype in the same fixture. That is useful local progress, but it
still falls well short of ORACLE. The combined GT3 candidate regressed against
the initial default configuration. These results reject promotion.

Sources: `results/verified-harbor-gt.json`, `results/verified-harbor-gtp.json`,
`results/oracle-distance-gt.json`, `results/reviewed-oracle-gtp.json`.
All record unchanged sources during their runs. The older GT3 reference used
the distance-aware harness before lap-history diagnostics were added; its
completed distance and finish counters are available, but per-lap validity
history is not. The historical initial GTP report lacks explicit finish-lap
metadata, so its time improvement is supporting evidence, not the acceptance
comparison above.

## Contact and return upgrade

The shared controller could approve holding a budgeted, aligned door gap, then
still steer away from that same gap. A behavior-preserving hook was extracted
from V2; COUNTERPOINT suppresses that extra evasive correction only when the
existing hold checks approve it, both cars remain inside the road, and the car
is not returning. Damage budgets, hard-impact rejection and physical collisions
are unchanged. Other drivers retain the original correction formula.

The inherited gradual return corridor is now retained until the car's actual
velocity is aligned with the pace route. Merely crossing within 35 cm of the
line while still moving sideways no longer completes the handoff. Hazards keep
their immediate response. Regression checks exercise a real door contest,
unsafe/return/budget rejection, and the aligned versus unaligned handoff.

| Four-lap Harbor field | COUNTERPOINT time from green | ORACLE time | CP retained passes / car | CP mean damage |
|---|---:|---:|---:|---:|
| GT3, original seed 53 | 276.50 s | 260.17 s | 5.5 | 2.57% |
| GTP, original seed 79 | 231.30 s | 220.27 s | 6.0 | 2.54% |
| GT3, fresh seed 101 | 280.86 s | 267.19 s | 4.5 | 5.74% |
| GTP, fresh seed 101 | 228.88 s | 220.68 s | 6.0 | 2.21% |

Both subjects completed four laps in each row. COUNTERPOINT recorded 7/8 valid
laps in each class/seed pair; ORACLE's fresh runs recorded 8/8. The original GTP
field improved by 6.93 seconds and mean damage fell from 6.65% to 2.54%, while
GT3 time stayed essentially unchanged and damage fell. Fresh seeds still favor
ORACLE on traffic time. These are observed fixture outcomes, not proof that
either code change alone caused every difference in a chaotic traffic race.

Sources: `results/contested-harbor-{gt,gtp}.json` and
`results/fresh-traffic-{counterpoint,oracle}-{gt,gtp}.json`.
These used the new contact/handoff behavior with the earlier pace allowance;
the GT pace calibration below was finalized afterward. Worker telemetry checks
unique delivered reply timestamps, end-of-run freshness and counter continuity;
all these runs passed with unchanged sources and zero bridge errors.

## Validated pace headroom

Increasing the dry GT grip-spend allowance from 1 to 1.015 produced clean gains
on Harbor Ring, Solenne and Desert. Fresh-seed 211 confirmation:

| GT3 track | Control best | Selected allowance best | Gain |
|---|---:|---:|---:|
| Harbor Ring | 61.87 s | 61.69 s | 0.18 s |
| Solenne | 59.25 s | 59.13 s | 0.12 s |
| Desert | 77.82 s | 77.60 s | 0.22 s |

All nine confirmation laps were valid and damage-free. A matching hard-tyre
Harbor check completed 4/4 valid laps, no damage/off-track, 255.39 s from green
and a 62.53 s best. A more aggressive 1.03 allowance made Harbor slower, and
Alpine/Nürburgring did not improve, so those changes were not selected. The
resource rules still remove extra GT grip spend in rain and at >=35% tyre wear.

Sources: `../vanguard/results/counterpoint-fresh-pace-{control,headroom,balanced}.json`,
`../vanguard/results/counterpoint-pace-headroom-dry.json` and
`results/balanced-pace-hard-solo-gt.json`. This is a measured small gain, not a
claim of absolute-best pace or a full new racing-line optimization.

Four laps do not establish the user's maximum 20% damage over twenty laps.
Damage is reported directly, not extrapolated linearly or converted to an
invented 4% short-race limit. Retired/finished rivals cannot generate passes,
and safety counters freeze at each subject's own finish.

## Solo reliability coverage

Five tracks × GT3/GTP × three laps, seed 101, candidate options enabled:

| Condition | Game-valid laps | Configurations with no damage/errors |
|---|---:|---:|
| Dry, fresh soft tyres | 30/30 | 10/10 |
| Dry, medium tyres starting at 60% wear | 30/30 | 10/10 |
| Rain, wet tyres | 30/30 | 7/10 |

The wet GT3 runs gained damage on Solenne (16.29%), Alpine (7.08%) and Desert
(5.44%). The follow-up identified all of it as **formation damage**, with zero
driving damage during the scored laps. The game's shared FormationPilot owns
applied controls until green, even overwriting the bridge during handover;
the solo car hit barriers under that pilot. Coasting on/off gives identical
results. Thus the full rolling-start check fails, but these rows do not show
a COUNTERPOINT wet-lap controller regression. All five GTP wet configurations
passed the stricter no-damage check. Short runs do not establish endurance.
Control report: `../vanguard/results/counterpoint-wet-coast-control.json`.

Reports: `../vanguard/results/counterpoint-review-20261024-solo-{dry,wet,worn}.json`.
These matrices preceded the maneuver-reset correction and later contact/pace
updates. They are not presented as a full current-source rerun. The subsequent
traffic tests use the corrected lifecycle and contact/handoff behavior.

The later release dry and worn matrices, seed 307, both repeat **30/30 valid,
damage-free laps across all ten track/class configurations**, with no source
changes during each run. They include the contact/handoff and calibrated pace
defaults. Reports: `../vanguard/results/counterpoint-release-{dry,worn}.json`.

## Actual twenty-lap check and final-route correction

Two rear-start subjects behind six real rivals on Harbor Ring, seed 101, hard
tyres, no pits or cautions. These are full races, not scaled short-run damage:

| Before final-route check | Time from green | Damage | Valid laps | Retained passes |
|---|---:|---:|---:|---:|
| GT3 car 1 | 1370.24 s | **20.11%** | 19/20 | 6 |
| GT3 car 2 | 1347.29 s | 3.54% | 18/20 | 6 |
| GTP car 1 | 1115.91 s | 4.31% | 17/20 | 6 |
| GTP car 2 | 1110.36 s | 0% | 19/20 | 6 |

All four completed twenty laps. One GT3 car narrowly exceeded the user's 20%
damage budget, and none delivered twenty valid laps. This does not pass the
endurance reliability gate. Telemetry was valid, with no bridge errors or
source changes. Reports: `results/endurance-default-{gt,gtp}.json`.

An executor-path witness localized a cut near Harbor s=856 m: the joined
tactical route was around 9.79 m from the centre and left too little tracking
room; the car reached 10.39 m. The inherited compiler bounds raw offsets before
smoothing and the C2 join, which does not bound the final world-space route.
Counterpoint now checks future final-route endpoints and near-edge world-space
midpoints, preserving kerb space and a tracking reserve. It ignores unchanged
pace segments and past geometry. Rejection preserves the reserved prior path
and initiates a gradual return rather than switching lines abruptly.

The first stricter implementation was rejected: it disallowed too much usable
road, raised contact and lost passes. The revised diagnostic prefix removed
the reproduced cut with essentially unchanged mean progress and retained passes
(5.5 per car). It is a 105-second diagnostic, **not a completed endurance
race**. Reports: `results/endurance-path-witness-gtp.json`,
`results/road-checked-prefix-gtp.json` (rejected), and
`results/kerb-checked-prefix-gtp.json` (revised).

The full twenty-lap confirmation has now finished on unchanged source:

| Final-route check enabled | Time from green | Damage | Valid laps | Retained passes |
|---|---:|---:|---:|---:|
| GT3 car 1 | 1347.61 s | 11.13% | 19/20 | 6 |
| GT3 car 2 | 1342.44 s | 4.03% | 20/20 | 6 |
| GTP car 1 | 1136.89 s | 6.34% | 20/20 | 6 |
| GTP car 2 | 1131.47 s | 9.56% | 20/20 | 6 |

All four completed within the user's twenty-lap damage budget, with zero
classified severe contacts, zero bridge errors and valid/fresh telemetry.
Lap legality improved from 73/80 to 79/80. GT3 mean time improved by 13.74 s;
GTP mean time regressed by 21.05 s, and mean stuck time rose from 112.60 s to
221.53 s. Its damage also increased. This is a measured reliability/pace
tradeoff, not a general performance win. The remaining GT3 failure was a
single 11.24-second off-track spell near s=2113 m on lap one; more valid laps
must not obscure that worse total off-track time. Reports:
`results/road-checked-endurance-{gt,gtp}.json`. Both reports share fingerprint
`87339a9e0dd78372fff0cdb1b5dbf7bc8cb1af280cd48d148caf8336e8b1f1a6`,
with empty `changesDuringRun`. No twenty-lap ORACLE reference or multi-seed
confirmation has been run, so these results do not change the overall ranking.

## Combat checks and their limits

The initial prepared GT comparison covered 27 encounters on two seeds with
54 healthy paired solo controls. Each driver ran 36 attacks, 14 defences and
four sudden-braking cases. All recorded zero bridge errors and unchanged sources.

| Driver | Retained attacks | Zero-contact passes | Successful defences |
|---|---:|---:|---:|
| Initial COUNTERPOINT | 12/36 | 6/36 | 8/14 |
| VANGUARD v2 | 12/36 | 6/36 | 8/14 |
| ORACLE | 10/36 | 4/36 | 12/14 |
| INTERCEPT | 4/36 | 4/36 | 8/14 |
| RAZOR | 18/36 | 10/36 | 6/14 |

Report: `../vanguard/results/cp4-combat-gt.json`. These fixtures are not an overall
ranking. The initial challenger matched V2 exactly; added search did not show
an advantage there. The historical strict encounter score adds a 1% damage
allowance and contact-type rules. It is separate from actual retained passes
and from the user's twenty-lap budget; mild rubbing is reported rather than
universally disqualifying a move.

Fresh shifted encounters (seed 79, stations shifted 17 m, initial gap 20 m)
produced six attacks per class. GT3 retained passes tied ORACLE at 1/6, with
7.53 s off track for COUNTERPOINT versus zero for ORACLE. GTP retained passes
were 2/6 versus ORACLE's 3/6; COUNTERPOINT had lower damage. Both classes had
eight healthy paired solo controls. The small holdout does not establish a win.
Reports: `../vanguard/results/counterpoint-review-20261024-shifted-{gt,lmdh}.json`.

## Planner lifecycle and why combat is still weak

The inherited battle state machine calls `reset()` when an ordinary return to
the racing line finishes. COUNTERPOINT previously treated that as an episode
restart and discarded opponent observations, search cadence and cumulative
counters. Maneuver resets now preserve those race-level values; an actual
driver restart calls `resetEpisode()` to clear them. Focused regressions and
async integration checks pass.

A final 40-second trace verifies monotonically increasing search decisions
(83 total), one setup admission and no counter drops across merges. It still
finishes 8.08 m behind the worn-tyre rival without contact or a retained pass.
Source: `../vanguard/results/counterpoint-lifecycle-final-counterpoint-harbor-worn-traffic-53-trace.json`.
Worker diagnostics are under `debug.planner.interactive`; the executor's own
`debug.interactive` does not run the tactical search.

The earlier final-harbor reports had invalid planner telemetry: the harness
did not request worker debug and substituted executor counters when worker
data was missing. That is fixed, covered by an async integration regression,
and the fields were rerun. Missing worker telemetry now remains missing.
The corrected GT3 subjects recorded 2/2 staged and 3/0 setup admissions; GTP
recorded 0/1 staged and 3/3 setup admissions, with no observed counter drops.
Race outcomes remain essentially identical (one GT3 finish differs by one
physics tick). These options are active, but have not produced a traffic win.
Most new planning is supplementary: it preserves
existing V2 attacks, searches for missed opportunities while following, and
retains V2's return/abort/controller constraints. The final fields still
repeatedly fall back behind cars, spend substantial time nose-limited and return
from attacks. More branch scoring alone has not solved that execution bottleneck.

## Actual worker latency

Release Node worker test: 18 configurations (three tracks × two classes ×
one/eight/sixteen visible cars), each with 20 warm-up and 120 measured requests.
Numbers are the worst per-configuration p99 within each group.

| Cars visible | Worker computation p99 | Request-to-reply p99 |
|---|---:|---:|
| 1 | 1.47 ms | 1.60 ms |
| 8 | 11.47 ms | 11.76 ms |
| 16 | 14.59 ms | 15.06 ms |

Zero worker errors; no source changes during the run. Worst observed reply was
16.43 ms. Cold worker creation, imports and initialization reached 1423 ms and
must be paid before racing. The original steady planner p99 target of 8 ms is
missed in traffic. A separate live solo executor sample measured p99 0.023 ms.

Report: `results/release-latency.json`. One low-priority solo matrix ran alongside
this measurement. It includes the route check before its final endpoint/window
regressions and trusted-pace-segment optimization. The earlier measurement
(`results/final-latency.json`) had 13.20 ms worst group p99 and 486 ms cold start;
these differences are not isolated algorithm comparisons.
This measures the real seat module in an
actual Node worker with structured-cloned messages, one worker at a time. It
does not measure browser rendering, frame scheduling or simultaneous full-grid
worker contention. It is evidence of usable local computation cost, not proof
that a browser race will deliver every reply within one frame.

## Next development priorities

1. Make a selected passing corridor produce sustained, useful lateral position
   and closing progress through entry, overlap and exit. Log the first actual
   route/guard/abort disagreement and fix that behavior before adding more
   hypothetical response branches. In particular recover GTP's increased stuck
   time after the final-route check without restoring its cuts. ORACLE remains
   the benchmark. Trace the remaining GT3 lap-one excursion near s=2113 m.
2. Trace and resolve the shared wet rolling-formation barrier contacts separately
   from COUNTERPOINT's green-lap controller. Preserve the measured dry pace.
3. Reduce dense-traffic search cost, then test real browser full-grid latency.
4. Confirm the twenty-lap result on fresh seeds and other tracks; then validate
   tyre/fuel/pit behavior and mixed-class races before enabling regular grids.

Contract and async integration checks pass; `npm run game:build` succeeds.
Existing large-bundle warnings remain. No racer was promoted, no long queue
was launched, and no commit or push was made.
