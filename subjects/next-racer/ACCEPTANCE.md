# Combat-first acceptance campaign

Status: proposed tests for an unimplemented driver. The source audit and existing
SOLSTICE checks are the only new verification completed in this investigation.
None of the gates below is claimed as passed by `next-racer`.

## Development gate order

| Gate | Question | May start solo pace optimization? |
|---|---|---|
| A: observation and plant | Does the controller see/predict the actual game and obey the output contract? | No |
| B: overtaking and defense | Does it finish useful maneuvers against adaptive opponents without contact or hesitation? | No |
| C: native integration and resources | Do workers, pit handovers, flags, classes and stint budgets work in a real race? | No |
| D: Harbor pace | Can that accepted racer reach GTP <53 s / GT3 <64 s? | Yes, while A–C remain passing |
| E: sustained/full race | Does its speed remain useful across stints and field races? | Release only after passing |

Use a stable physical reference controller in A–C. Improving acceleration enough
to execute a pass is combat work; doing solo grip/line sweeps for a fast lap is
deferred. Changing a route, force limit or resource budget later must rerun the
combat cases it can affect.

“Maximum combat” is an optimization objective, not a claim that every car can be
passed under every starting condition. Acceptance requires high success on
**independently established viable opportunities**, measured defense quality and
no systematic missed route family. Never relabel failures as “not viable” using
the tested controller's own rejected-candidate list.

## Evidence that every run must retain

Record game/driver/tool source hashes and commit IDs, environment overrides,
track geometry hash, vehicle and race classes, team seats, active driver,
format/laps/mandatory rules, initial fuel/tyres/temperatures/wear/charge,
compound policy, setup, difficulty and actual governor policy. Record race seed,
actual weather seed, clock/sun, weather trace and initial rubber. In Changeable
browser sessions the race seed alone is insufficient.

Record both requested and applied controls, snapshot/actuation timestamps,
decision stage, rival target, selected topology, all serious candidate rejections,
planned exit state and actual outcome. Retain compact summary tables plus a
short trace around failures. Keep large per-frame dumps ignored.

All movement after declared initialization uses native controls and physics.
No progress/velocity/tyre/energy writes may manufacture a benchmark. A fixture's
initial resources/pose are allowed only when clearly declared and identical in
the compared runs. Finishing in a native all-AI race must use its normal team
strategist; controlled compound/stint experiments are reported separately.

## A. Contract and native prediction

Test GTP and GT3 at fixed 120 Hz and representative variable browser substeps.
Include cold/fresh/warm/worn asymmetric tyres, dry/wet surfaces, different
rubbered lanes, fuel masses, steering lag, shift cuts, damage and wake.

- Freeze every live physical/resource/timing object except `controls`; prove a
  bridge changes controls only and returns finite bounded values.
- Prove shadow tyres, wheels, energy and any rubber overlay cannot alias live
  objects. Native deposits may update private forecast environment state only.
- Match a native one-step/prefix replay from the same copied environment,
  control timing and policy. Use strict numerical tolerances for identical
  integration; separately report approximation error for coarse long search.
  Do not omit deposit-induced environment differences and call the plant exact.
- Exercise hybrid BALANCED/ATTACK/BUILD/QUAL, throttle/lift/brake transitions,
  speed/gear thresholds, empty/full battery, final lap, out lap and same-class
  gaps. Model brake regen once and lift regen as native axle drag.
- Recalculate wakes from predicted rival poses; validate drag/downforce together.
- Round-trip optional context locally and through an actual team worker:
  session, phase, ambient, pit plan, flags, targets and epoch. Verify other AI
  output semantics remain unchanged by additive transport fields.
- Prime a stationary grid repeatedly at time zero. Inactive seat/service/pause
  cannot arm recovery. Reset/swap rejects replies from the previous epoch.
- Exercise rolling formation preview while the autopilot overrides outputs:
  no combat before green, no model-learning from overridden controls, and no
  double advancement when a green-step update repeats the same timestamp.

The audit already demonstrates why an observed-force-only hybrid parity test
and surface-grip-only thermal copy are insufficient. It does not implement
the fuller parity tests described here.

## B. Overtaking and defense corpus

Build the scenarios before tuning the tactical cost. Geometry-derived entry,
apex and exit gates must work in both curvature directions and across the lap
wrap. Each case uses the native vehicle, hybrid, wakes, collisions and public
observations. A scripted rival is an early diagnostic, never the final opponent.

| Case family | Failure to expose | Required behavior |
|---|---|---|
| Faster follower on straight, opponent centered on preferred line | Rear-ending or following indefinitely | Separate early enough to finish left and right passes |
| Offset blocker / shallow left and right curves | Belief only the fast line is drivable | Complete a parallel alternate route at useful speed |
| Braking entry, inside initially open | Dive that stalls at apex | Reach overlap with feasible braking, then drive the exit |
| Inside cover begins before overlap | Chasing a closing hole or repeated abort | Outside carry or cutback, with a complete exit route |
| Alternating bends | Optimizing only the first apex | First-corner outside to second-corner inside when beneficial |
| Initial left/right overlap | Side flip or premature return | Keep body room, accelerate, clear and merge legally |
| Defender returns toward exit | Cutting across the neighbor | Retain occupied corridor until all body clearance is real |
| Defender under close rear pressure | Parking to block | One early cover, useful exit, no needless rear-threat brake |
| Three-car queue / car on each side | A passing route intersects another car | Evaluate the entire local field and prepare/follow if no room |
| Two independent identical drivers | Same-line procedural deadlock | Role-dependent choices and measured useful opportunities |
| GTP lapping GT3 near turn-in/exit | Treating class traffic as a duel or ignoring it | Predictable GT3 path and committed, timed GTP pass |
| Cold tyres / worn rear-right / low charge | Overlap gained but exit impossible | Resource-aware route viability without universal timidity |
| Stalled/spinning/rejoining car | Ignoring a physically relevant obstacle | Timely steering/braking with a verified clear continuation |
| Wet lateral rubber contrast | Dry-line prediction or inflated fear | Use real current wheel grip and body corridors |

Do not require an equal-speed straight pass when the native tow/exit/resources
provide no actual advantage. Do require that the controller exploits a verified
open route when one exists. Establish viability separately using declared native
trajectory replays/search and available public motions. Retain the viability
evidence before looking at the candidate result. Mark opportunistic reactive
duels separately when no deterministic completion oracle applies.

### Metrics

A completed pass requires full longitudinal body clearance plus 2 m, a stable
lead for at least one second **and** completion of the relevant corner exit.
Use unwrapped physical progress and class/lap context. A nose ahead, a rival
stopping/pitting/retiring, or gaining a place by forcing it off track is not a
completed racing pass. Keep time-to-overlap, time-to-clear and time-to-exit
separate.

Measure viable-opportunity conversion, attempts, successful route families,
abort reasons, time lost to repeated attempts, completion latency, exit relative
speed/gap and each driver's segment time/progress relative to its paired
free-air reference. Record hybrid charge spent and the following lap's effect:
the host may use ATTACK in a fight but BALANCED in the free-air run.

Track safety and pace loss independently: native contact steps, distinct impact
episodes, closing speeds, damage, native valid/off-track status, independently
integrated off-track duration, wheel/body boundary excursions, spins, rescues,
stopped time, errors and non-finite output. Zero steward points does not prove
zero contact. Repeated collision steps are not distinct crashes; report both.

Count hesitation only when a currently executable collision-free route exists:
unexplained drive suppression, repeated side flips, no relative progress after
commitment and aborted exits without a physical/resource cause. Inspect the
requested/applied control difference before attributing a lift to the driver.

### Initial quantitative gate

- At least **95% conversion of certified viable deterministic opportunities**,
  with no required route family systematically missed. Publish every denominator
  and failure, including seeds/poses outside the development set.
- **Zero contacts, invalid laps, self-induced spins and rescues** in the
  deterministic corpus. Zero NaNs/bridge errors in every test.
- No defense-induced stopped period and no intentional brake-to-block action.
  In viable defending fixtures, one covering move per approach, defended-sector
  time loss ≤3% and exit speed ≥95% of the matched free-air feasible exit.
  Maintain position where the independent defending fixture establishes a
  legal, budget-compliant defense; otherwise measure its safe counterattack.
- An inside pass must restore feasible drive within 0.4 s of verified available
  exit room. Normal steering/grip/shift constraints are logged, not treated as
  timidity. No persistent acceleration deficit without such a cause.
- No repeat-route deadlock across two successive viable opportunities.
  Identical-driver duels cannot pass by collectively slowing or colluding.
- Compare the same corpus against SOLSTICE and relevant competitors. Claim an
  improvement only when opportunity conversion/completion time improves without
  increased contact or defended-sector loss. The new driver must not lose its
  advantage merely because the opponent also replans.

These are initial engineering thresholds to test the architecture, not a proof
of global optimality. Harder adversarial discoveries expand the corpus; they
must not be deleted to keep the success rate high.

### Opponents, timing and variation

Start with fixed-lane, braking and single-cover rivals to localize bugs. Graduate
to two fully adaptive, separately stateful copies of the new driver, SOLSTICE,
Gemini v4 and the native supported class field. Unsupported competitors remain
GT3 comparators, not silently remapped GTP competitors.

Run 20/30/60 Hz delivered-observation/held-control cases with at least one-frame
delay, then actual worker cases with measured latency and occasional 50–100 ms
bursts. Keep state samples and action timing explicit. Runs should last long
enough for the full maneuver, typically 20–60 seconds, rather than ending at the
first promising overlap. A mode label is not a successful maneuver.

Use at least three development seeds and three held-out seeds with varied gaps,
offsets, approach speeds and mirrored sides. Before declaring the gate complete,
accumulate at least 300 declared maneuver trials across both classes and these
resource/cadence conditions. Report failures by family, not only a pooled mean.

## C. Full integration and resource gate

Use the actual game `EnduranceRace` and `AsyncSeats`, not a direct Vehicle-only
duel, for the following:

| Campaign | Required checks |
|---|---|
| Qualifying → race | Correct out/timed mode, ghost handling, class grid, new session/reset epoch |
| Grid front/middle/rear and wide lanes | Primed launch, no false recovery, no grid contact |
| Rolling formation → green | Live-state reset/preview, two-wide traffic, native BUILD mode, duplicate timestamps and clean ownership transfer |
| Manual human → AI and AI → human | Native automatic handover, current grip/resources, clean release of controls |
| Fuel/tyres/driver pit stops | Approach/blend, autopilot ownership, actual fuel/service/swap accounting |
| Penalty and damage boxes | Yield to host pit call, no competing attack plan, native service result |
| Cold/warm pit exit with passing traffic | Stable lane and clearance, no stale pre-pit target |
| Local yellow, blue, finish and retirement | Public status interpreted without ignoring physical obstacles |
| GTP + GT3 field | Class-correct contest, lapping behavior, pit merges and class classification |
| Rain and Changeable | Real ambient/grip/seed trace, native compound catalog, pit-entry/release robustness |
| Day/night and different graphics load | Same clock-dependent weather, measurable worker/control-age robustness |
| Pause/restart/debugger toggles | No stale replies or control discontinuity; aim point and small debug payload |
| Rookie through Alien; human co-driver | Native difficulty behavior and applied-control accounting |

Mandatory stop/swap counts and penalties must be satisfied through native
systems. A finished/DQ/lapped car cannot be falsely counted as having completed
the requested race. Report class position, laps done, penalties and finish
reason, with contact/off-track/resource summaries up to its own finish.

The original task permits small registration edits, but a complete optional
observation envelope changes additional core adapter lines. Freeze that exact
integration scope before implementation. Do not silently change other drivers,
the strategist, global governor, difficulty profile or game physics. No wet
retuning is authorized by this design investigation.

## D. Harbor lap targets, after combat acceptance

Test GTP and GT3 separately on Harbor Ring at difficulty 1 with declared stock
setup and the intended per-driver governor policy. The quantitative objectives
are strictly **<53.0 s for GTP** and **<64.0 s for GT3**. Record whether each result
is a qualifying lap, a charged short run or a sustained race-stint lap.

Require at least three clean complete laps below the threshold across at least
three seeds, then confirm the best sustainable median and stint behavior.
Measure sector loss, acceleration/braking, axle utilization, wheel slip work,
hybrid charge and applied caps to diagnose the remaining margin. Optimization
may improve class geometry/controls; it cannot change the car, clock or resources.

An initially full QUAL battery, a light qualifying fuel load or favorable tow
must not be reported as repeatable race pace. Target compliance must state
resources/compound/session and separately show sustainable energy performance.
There is no claim from the current audit that sub-53 is already physically proven.

Retain the complete combat corpus while optimizing. A new solo personal best
does not excuse a regression in viable passing, corner exits or defended momentum.

## E. Four-second fade and complete race results

Declare the pit window/stint length before a resource campaign using the native
team plan and format. Include the finish stint if it ends at the chequered flag.
Run controlled dry hard/medium/soft stints and actual all-AI strategy races as
separate campaigns. Race length changes native wear/fuel scales; 3-, 12- and
20-lap campaigns are not directly comparable.

For each uninterrupted tyre stint, include **all eligible clean non-pit laps**
from the first completed eligible lap through the last before the planned stop:

```text
operational stint spread = maximum eligible lap time - minimum eligible lap time
end fade = last eligible lap time - best eligible lap time
```

Require both measures ≤4.0 s in the controlled degradation campaign. No cherry
picking the first/last lap, dropping a slow clean lap or pitting early merely to
erase a failing fade. Report pit/out laps separately, with native flags. A stint
with fewer than three eligible laps does not establish the fade requirement.

Track per-wheel core/surface/pressure/wear/slip energy, fuel, native deployment
mode/charge and confidence in reaching the plan. The operational result includes
energy fade; additionally attribute tyre/thermal loss using matched observations
and controls. Changing weather/traffic produces real race loss but is reported
separately from the controlled degradation gate.

Use native 12- and 20-lap Harbor GTP/GT3 and multiclass races over at least three
seeds, with an all-new-driver field and mixed fields. Record results for both
classes independently, stop/swap/service/lane costs, lapping and contact rates
per car-hour. Compare total time and race position, not only best lap.

For human partnerships, compare actual logged human-first stints and native
handover to the new driver. The user's earlier 65-second human average is a GT3
scenario assumption; it does not establish a GTP human pace. Analytical stint
schedules can inform a separate comparison but cannot replace a physically
driven human/AI race or rewrite the team's strategy.

Finally exercise Solenne, Alpine and Desert for geometry/traffic generalization,
pit/recovery robustness and full mixed-field results. Harbor's numeric targets
remain Harbor-specific. Claims of being the best everywhere require new same-
version, same-class, same-format measurements across those circuits.

## Runtime and release evidence

Target ≤0.15 CPU seconds per simulated car-second, p95 delivered update ≤8 ms,
and no routine >20 ms tasks on the recorded reference machine. Measure p99,
field-load round trips, serialization, control age, timeouts and stale rejects.
Separate solver time from total worker time. These numbers are provisional
engineering budgets, not measured capabilities of an unimplemented design.

The release report must enumerate remaining failures, unmet targets and scope
limits. It must show native game build/checks, meaningful plant/contract checks,
the combat campaign, browser workers, stint fade and full race results. Keep
SOLSTICE selectable and verify its runtime/config/data hashes did not change.
