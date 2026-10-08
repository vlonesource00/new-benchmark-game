# RAZOR development checkpoint

Base: `origin/graphics-aaa` at `963e019`. Separate `razor` driver; SOLSTICE,
SPEARHEAD, APEX and the shared physics are preserved.

## 2026-10-08 current-physics checkpoint

The latest tyre recalibration reduces soft grip to 1.025, raises hard grip to
0.985 and changes the wear calibration. Measurements in later sections that
use `cc5aead` are historical, not results for this base.

GTP keeps the healthy-rate controller's preview after measured transport age.
Long-held GTP inputs use the isolated chassis forecast. A closing GTP with two
body spans of room on a straight forms its lane sooner; an open attack gets
its fitted formation time before long-horizon predictions can cancel it.
Front-obstruction braking remains active. GT3 rejects a new attack into a
roadside gap that is too narrow, uses 0.7 nominal yaw feedback and retains 0.8
feedback for long-held inputs. Coarse native GT3 updates use the same held-input
forecast. No action rollout or extra grip is supplied.

Actual matched RAZOR GTP workers, Harbor, warm softs, 35 L, 24-second encounters:

| Cadence | Secured pass at | Light-contact steps | Severe contact / off-road |
| --- | --- | --- | --- |
| 20 Hz | 4.64 s | 2 | 0 / 0 |
| 30 Hz | 3.92 s | 15 | 0 / 0 |
| 60 Hz | 3.58 s | 1 | 0 / 0 |
| 60/20/60/30 Hz | 3.57 s | 8 | 0 / 0 |

Both cars stay on-road; damage stays below 0.7%. Each attacks-disabled paired
control does not pass. These are executed-move results, not lap-time or strategy
wins. GT3's 20 Hz matched worker pass stays clean; matched GT3 30/60 Hz still
does not convert. The earlier 30 Hz GT3 road departure is removed. Native
GT3 self-fights at all three cadences also stay on-road, without a hard contact,
but do not convert. Broader superiority remains unproven.

The strict native suite passes 69 checks across 33 encounter fixtures, with no
severe contact, off-road time or controller errors, and 78 light-contact steps.
The two added checks reject stale pass associations after a suspended encounter
and correctly report car ID zero as a nose obstruction. The original conversion
and bumper-reserve assertions are unchanged. The predictor cannot alter the
actual car or its track rubber.

The final unmodified `tools/worker-check.mjs` at 30 Hz passes only one of
four matchups, so the current worker regression suite is not green:

| Worker matchup | Attack pass | Following-control pass | Light-contact steps | Result |
| --- | --- | --- | --- | --- |
| GTP against RAZOR | 3.92 s | None | 15 | Fails zero-contact assertion |
| GTP against APEX | None | 9.62 s | 0 | Attack fails to convert |
| GTP through APEX GT3 | 3.42 s | 10.37 s | 0 | Passes |
| GT3 against RAZOR | None | None | 1 | Attack fails to convert |

All four attack runs have zero severe contact, off-road time and rival off-road
time. Each worker returns 721 replies, with 25 ms p95 reply age. The GTP/APEX
miss is a tactical regression: the attack policy loses a pass that its paired
following control completes. This checkpoint is not a completed combat release;
the original worker assertions have not been relaxed.

Slow GTP workers complete 125-second staged runs on Harbor, Solenne and Alpine
with no contacts, off-road time, damage or errors. Harbor's full-distance
circuit is 52.217 s; Solenne's second circuit is 50.008 s. These warm-soft runs
use a shifted timing origin and are not normal qualifying sessions. The host
lap counter accumulates a full circuit from the staged origin: the earlier
description of the 250 m-start run as a partial lap was incorrect. Yellow lap
colour means slower than the previous best, not an invalid lap.

Clear Harbor now uses RAZOR's own current-physics stint priors: ten laps per
compound from cold and warm tyres, for both classes, at constant 60 L. GT3 data
was refitted after the feedback change. The planner prices excess fade into
future stints instead of imposing the obsolete 2/3/6-lap compound limits.
An incompatible tyre signature disables these priors; other tracks/weather
keep the previous inherited policy. Mixed human/AI teams keep the game planner.

Native Harbor, clear, seed 7, classic format, two all-AI teammates per entry:

| Test | RAZOR finish | Stops | APEX finish | Max valid-lap stint spread |
| --- | --- | --- | --- | --- |
| GTP, 12 laps, warm-hard override | 693.57 s | 1 | 696.97 s | 1.38 s |
| GT3, 12 laps, warm-hard override | 805.09 s | 1 | 808.56 s | 1.63 s |
| GTP, 20 laps, planned start | 1146.06 s | 2 | 1167.88 s | 1.36 s |
| GT3, 20 laps, planned start | 1318.14 s | 1 | 1357.49 s | 2.98 s |

All four tests have zero contacts, RAZOR incidents and controller errors;
mandatory swaps complete. These are endurance results, not causal combat
evidence. `tools/stint-check.mjs` passes eight compatibility/integration checks;
`tools/endurance-check.mjs` enforces the four-second spread in both classes.
Native twelve-lap GT3 probes with a manual safety car or full yellow also
finish with one stop, a swap and no RAZOR incident or controller error. Rain
handling has not been retuned.

Remaining work: matched GT3 30/60 Hz conversion, moving multi-row traffic,
defense against human movement, rain validation and broader field evidence.
The native ten-car Harbor benchmark (five laps, warm hards, seed 7, pits
disabled) finished RAZOR first and second. Its first completed run recorded
52 field-wide contact steps and one severe contact, with both RAZOR cars at
12.7% damage and eight incident points. A repeat with a read-only severe-contact
observer recorded two contact steps, no severe contact, 1% RAZOR damage and
zero RAZOR incident points; the best laps were 53.11/53.21 s. The discrepancy
is unresolved, so the repeat is not proof that the full-field collision problem
is fixed. The bench does not establish causal pass counts. Timed-out batches
supply no result.

The front-braking/expanded-nose-width experiment is not shipped. Expanding the
nose envelope removed three required native passes and raised light-contact
steps from 78 to 182 without improving the hard-contact result. The existing
front-obstruction policy is retained.

## Historical cc5aead control-cadence upgrade

The tyre/strategy/energy update in `8aa6469` and Claude's A/B bench in
`cc5aead` are included. Claude's softened straight-line stability fix is kept.
The measurements below deliberately impose worker cadence; they are not
measurements of browser FPS on a particular computer.

RAZOR now advances an isolated replica under the controls already being held
when a GT3 worker's snapshot interval/reply age exceeds the normal 60 Hz case.
At most eight short physics steps predict the steering actuator and tyres.
The forecast never searches future actions, modifies another driver or deposits
rubber onto the actual track. Normal steering gains remain in use.

Warm-soft Harbor straight, through the actual game's worker transport:

| Cadence | Original mean throttle | Held-control prediction |
| --- | --- | --- |
| 20 Hz | 15.4% | 99.95% |
| 30 Hz | 30.2% | 100.0% |
| 60 Hz | 99.92% | 99.92% |
| Changing cadence | 58.0% | 99.9% |

The straight tests have no contacts, off-tracks or worker faults. The 60 Hz
straight traces agree with the previous controller. A 75-second changing-rate
run on each of Harbor, Solenne and Alpine also has no contacts, off-tracks or
worker faults. Harbor's first 60.175-second circuit uses a shifted timing
origin 250 m into the layout; it is a staged run, not normal qualifying.

The matched GT3 20 Hz worker encounter completes an executed pass at 5.22 s,
with no contact or off-track time for either car. Its attacks-disabled control
does not pass. The matched 30 Hz encounter remains clean but does not convert;
universal passing superiority is not established. The standalone predictor
benchmark is 0.046 ms median and 0.093 ms p95 on the test machine.

Reducing yaw/slip feedback fixed the short straight but regressed matched
corner fights. Restoring the gains before corners and imposing a separate
steering slew limit also regressed tests; those changes are rejected.

Before the completed-pass return fix below, the complete native suite had 66
passing checks and a pre-existing matched GTP 30 Hz hard contact under the
updated physics, reproducible without this GT3 prediction change.
Older endurance/fade numbers below predate the shared tyre update and require
revalidation. Multi-row traffic routing remains a separate local experiment.

## 2026-10-08 completed-pass return

An attack no longer keeps its side lock after the rear has cleared the rival's
nose by 0.8 m. It starts the existing fitted return to the fast line. Ownership
is retained while the bodies still overlap; there is no direct steering jump.
The previous side lock could carry a completed pass through the next braking
zone, lose the advantage and bring the cars back into contact.

The strict native suite now passes all 67 checks and 33 encounters at
20/30/60 Hz: zero hard contacts, zero off-track time, 82 light-contact steps
versus 130 before this return fix. In the matched GTP 30 Hz case the pass is
secured at 5.80 s without contact, rather than 19.62 s after a hard contact.
The matched 20 Hz GTP pass remains at 3.72 s with one light-contact step.

Real-worker GT3 checks retain a clean causal pass against RAZOR at 20 Hz
(5.22 s; following does not pass) and APEX at 30 Hz (4.47 s). The APEX
attacks-disabled control passes only later and becomes incident-affected;
do not use its final gain as a clean pace comparison. Matched GT3 at 30 Hz
still does not pass and ends 29.8 m behind, versus 6.5 m for following.

A two-car fight with cadence cycling through 60/20/60/30 Hz every two seconds
also fails to secure a pass. It has 182 light-contact steps and 4.29% damage
per car, despite no hard contacts, off-tracks or worker faults. Repeated rubbing
is not a successful move. The worker fixture now reports damage and peak
closing speed alongside contacts; consistent forecast transitions remain under
investigation. Broad corridor refitting and native GTP held-control prediction
were tested in isolation and rejected because they lost existing conversions.

Using held-control prediction at every GT3 worker cadence reduces that mixed
fight to 45 light-contact steps and 1.65% damage, but still fails to secure the
pass. It also adds 0.208 s to the identically staged 60 Hz Harbor partial lap
(60.192 vs 60.400 s). This extension is not enabled in production. Keeping the
physical predictor for 0.25 s after a slow-rate observation also failed: 151
light-contact steps, 5.77% damage and no pass. The test-only all-cadence variant
can be reproduced with `tools/cadence.mjs --all-cadences`; healthy 60 Hz
production behaviour keeps the existing predictor.

## 2026-10-08 forecast and departure investigation

Candidate scoring now starts the fast line from the observed position, as the
passing corridors do. The steering controller still uses its held-input control
pose. Starting only one candidate in the future biased a traffic comparison.
The strict suite retains all 67 checks and 33 encounters: no hard contact or
off-track time, 83 light-contact steps. The native matched GTP 30 Hz pass stays
at 5.80 s without contact; the 60 Hz missed-pass deficit improves from 25.7 to
20.6 m but still fails to convert. The real-worker matched GT3 20 Hz pass stays
at 5.22 s with no contacts; the GT3 APEX 30 Hz pass is clean at 4.42 s. Its control
becomes incident-affected and is not a clean final-pace reference.

`tools/forecast-audit.mjs` compares predictions with interpolated later rival
positions. In the 24-second native GT3/APEX 60 Hz fixture, scalar prediction
position error p95 is 0.39 m at 0.2 s, 1.76 m at 0.6 s, 3.70 m at 1 s and
16.56 m at 3.4 s. A Cartesian revision improves some median errors, but not
the tail or pass conversion. It stays in `tools/forecast-model.mjs`; the
production driver does not import it.

Delayed pullout, projected/timed side guards and clearance retention are
test-only variants in `tools/departure-experiment.mjs`. A maximum 0.3-second
delay retains the clean 20 Hz self pass and the 30 Hz APEX pass. At fixed
30 Hz it reduces the matched GT3 deficit from 29.8 to 10.2 m, still without
passing. At changing 60/20/60/30 Hz it secures a pass at 17.45 s, but has 110
light-contact steps and 3.97% damage per car. That is insufficient separation,
not a clean new combat result. Increasing guard projection or retaining the
wider lane causes off-track regressions in some combinations. None of these
options is enabled in production. The worker fixture records body-frame
contact locations when `--trace` is supplied.

Reproduce the diagnostic and a rejected native variant:

```sh
node --import ./scripts/json-loader.mjs subjects/razor/tools/forecast-audit.mjs gt3-same-class 60
node --import ./scripts/json-loader.mjs subjects/razor/tools/combat-experiments.mjs '{"departureDelay":0.3}' self-fight-matched gt 30
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-encounters.mjs razor gt --hz=30 --cadence=60,20,60,30 --both-options --driver-options='{"departureDelay":0.3}' --trace --quiet-trace --allow-incidents
```

## Implemented

- APEX's identified model and baked geometry, with independent line metadata,
  combat, traffic observations, slip expenditure and strategy installation.
- Constant-size corridor search, pooled geometry buffers and local retiming.
  Measured position/tangent joins, bounded steering jerk and persistent sides.
  Road narrowing uses smooth anticipatory tapers instead of sharp offset clipping.
- Quintic Hermite joins settle incoming slope and curvature without the old
  quadratic bulge. An established attack cannot switch sides, or merge back
  through a nearby rival. Defensive cover also returns through a fitted corridor.
  Defense must earn its exit-speed budget; the attack side lock no longer
  overrides a rejected cover and forces a costly defensive lane.
- Opponent motion is integrated through braking zones, using public class,
  tyre and fuel state. A cached 34-step forecast is shared by the candidates.
  Close, open space receives a small preference without requiring a guaranteed
  forecast pass or awarding a pass merely for choosing it.
- Moving wake pursuit, inside/outside separation, full-throttle use of owned
  space, one defensive cover and smooth returns. A failed move must return
  before starting a new move in the opposite direction.
- Static/spun/retired road obstacles remain physical. A completely blocked
  road gets a stopping constraint; viable escapes keep their acceleration.
  The shared side guard is translated into smooth-line coordinates; overlap
  itself supplies no longitudinal speed or acceleration cap.
- Pit calls and approaches are excluded from pursuit but remain physical
  obstacles. Lane/service cars are excluded; releases re-enter occupancy when
  their body reaches the road. The debugger also suppresses phantom pit targets.
- Native/worker seat selection, countdown priming, actual reply-age reporting,
  weather envelope, per-team pit planner, swaps and the architecture lens.
  Once worker reply age is measured, pose prediction adds only half the next
  held interval. Adding another 1.5 intervals over-predicted the control pose
  and prevented the native self-fight result from carrying into the game.
- Public flags, pit penalties and hybrid deployment remain enforced by the
  authoritative race. Below Alien the normal difficulty governor still applies.

## Evidence, not a final supremacy claim

`tools/check.mjs` runs native physics encounters at 20/30/60 Hz, pit/ghost/retired
occupancy checks, a fresh-driver takeover, a fully blocked road and paired pass
counterfactuals. Pit filtering is also checked in the architecture lens.
All 62 assertions pass; the production build also passes. A separate
`tools/endurance-check.mjs` checks the repeated-soft-stop regression and the
GT3 defensive-return off-track in real 12- and 20-lap races.

At 60 Hz, these deliberately staged Harbor soft-tyre encounters produced:

| Encounter | RAZOR clear-ahead time | Same traffic-aware driver, attacks disabled |
| --- | ---: | ---: |
| GTP against slightly slower APEX | 6.35 s | 10.10 s |
| GTP through APEX GT3 | 3.70 s | 10.02 s |
| GT3 against slightly slower APEX | 7.63 s | 13.35 s |
| GTP against near-pace APEX | 5.70 s | 19.26 s |
| Close corner entry against slightly slower APEX | 3.04 s | 17.86 s |
| Corner exit against slightly slower APEX | 3.06 s | 10.75 s |

The original self-fight now clears in 3.83 / 4.59 / 4.57 s at 20/30/60 Hz,
where its attacks-disabled controls never clear in 24 s. That original fixture
updates the leading car at 120 Hz. A new matched-cadence fixture clears in
4.05 / 5.77 s at 20/30 Hz, while its controls remain behind. Matched 60 Hz
still fails to convert; the check reports it as unresolved. APEX's wall-time
planning cutoff can cause small variations in opponent/baseline timings.

A conversion needs sustained clearance, executed lateral departure and overlap,
and earlier completion than its paired baseline. Live "passes after moves" are
associations, not causal proof. Ordinary race order changes and pit advantages
are not awarded as demonstrated tactical passes.

The 33 encounter runs had zero hard contacts, zero RAZOR off-track time and zero
controller errors. There were 81 light contact steps across the matrix; the tests do not
claim zero touches. Measured update p95 was below 1 ms on this machine,
excluding preparation. This is not a hardware-independent latency guarantee.

After the grip-refresh fix, solo Harbor rolling-start soft stints recorded
GTP laps 51.71 / 53.63 / 57.42 s and GT3 laps 60.70 / 62.61 / 65.73 s.
These use a 30-lap calibration with stops disabled and include the first
rolling-start lap, not a qualifying comparison or a shorter-race wear model.
The third soft lap exceeded the four-second fade target, so the initial soft
maximum window is two laps. Medium stints recorded GTP 53.06 / 53.75 / 56.31 / 58.67 s
and GT3 61.87 / 62.59 / 64.64 / 66.38 s; the initial medium window is three laps.
An earlier cold GT3 hard check over seven laps faded 2.48 s.
Separate six-lap soft-start races completed with no contacts or incidents;
the resource planner called earlier stops under that race's faster wear rate.
The maximum windows do not force a car to stay out when fuel or wear requires a stop.

Native 12-lap Harbor clear, seed 7, hard start, two AI teammates per car:

| Class | RAZOR finish | APEX finish | RAZOR stops / swaps |
| --- | ---: | ---: | --- |
| GTP | 724.46 s | 727.47 s | 1 / 1 |
| GT3 | 827.07 s | 831.73 s | 1 / 1 |

Both RAZOR entries finished without incidents or controller errors. The GTP
run had no contacts; the GT3 run had two light contact steps and no hard contact.
These races validate the race integration; they do not prove combat
superiority. The stint limits now enter the full remaining-race cost model,
including fresh sets. The old post-decision window override chose a long soft
finish, then paid for repeated short stops: that GT3 reproduction took 875.92 s
with three stops. The revised search chooses hards and one stop. Long races
beyond the inherited planner's three-stop capacity use the normal game planner.

The 20-lap clear GT3 regression finished RAZOR in 1376.39 s and APEX in
1389.04 s, with two stops each. RAZOR recorded a contact incident but no
off-track, wall, loss-of-control or recovery incident; fleet-wide hard contacts
were zero. APEX recorded a contact and an off-track. The earlier 20-lap GTP
check took 1219.43 s versus APEX's 1209.66 s, with three stops versus two,
zero contacts and no incidents or controller errors. That setup measured
stint fade below 2.9 s. The warm 12-lap hard-start GTP race still faded
4.36 / 4.93 s in its two stints. Universal endurance wins and fade limits are
not established.

`tools/worker-encounters.mjs` stages warm soft-tyre fights through the actual
AsyncSeats/seat-worker path: both drivers run at 30 Hz, with four physics steps
between replies and a measured 25 ms snapshot age. Each paired run lasts 24 s.
The counterfactual disables only the focal RAZOR's attack option. These are
staged combat checks, not full races or qualifying comparisons.

| 30 Hz worker encounter | Clear-ahead time | Attacks-disabled control |
| --- | ---: | --- |
| RAZOR against RAZOR | 5.22 s | No pass |
| RAZOR against APEX | 5.40 s | No pass |
| RAZOR through APEX GT3 | 2.85 s | 10.05 s |
| GT3 RAZOR against RAZOR | 8.14 s | No pass |

All four enabled runs had zero contacts, zero off-track time for either car, zero
controller errors and 721 replies per worker. The APEX control had 368 light
contact steps and no hard contacts; the RAZOR control had none. The mixed-class
control had 215 light contact steps and no hard contacts. All four moves
pass `--require-move`, including measured lateral departure and overlap.
The mixed-class fixture starts 23 m behind; the equal-class fixtures start
13 m behind. Each car is placed on its class's baked line.
The earlier equal-car GT3 worker run failed to pass and recorded 17 light
contact steps. The current Harbor GT3 predictor limits extrapolated yaw
acceleration using the actual observation interval, while retaining measured
yaw rate. Its passing lane reserves 0.24 m beyond the projected body widths
when there is room to form a lane, rather than 0.14 m. During overlap it keeps
the fitted corridor. The current GT3 counterfactual had no pass and 20 light
contact steps; the enabled attack had none.

The 2026-10-08 update also observes reachable side openings between full plans.
A public-snapshot fixture opens one side at 50 ms and triggers an attack on
that observation, ahead of the scheduled 120 ms plan. Opening the other side
does not switch the committed move. This fixture proves a reaction boundary,
not a completed pass. `check.mjs` passes 65 assertions and 33 native safety
encounters: zero hard contacts or off-track time, 60 light contact steps, and
approximately 0.70 ms p95 controller cost. The GT3 bumper fixtures reduce
contact steps to one at both 30 and 60 Hz, adding less than 0.5 s to conversion.

The latest native GT3 endurance regressions use the current game base:
12 laps starting on hards: RAZOR 828.63 s, APEX 829.95 s, one stop each and
zero contacts. Twenty laps with the normal starting compound: RAZOR 1376.26 s,
APEX 1392.56 s, two stops each, 25 light fleet contact steps and zero hard
contacts or off-track incidents. These are native races, not full worker races.

The current native GTP hard-start 12-lap race remains clean: RAZOR 724.54 s,
APEX 727.06 s, one stop each and zero contacts. Its last hard stint still fades
4.93 s, above the target. The current 20-lap GTP run is also clean but loses:
RAZOR 1221.80 s with three stops versus APEX 1211.19 s with two. RAZOR's last
valid lap minus its fastest valid lap in each stint ranges from 2.11 to 2.95 s.
The extra stop remains an endurance cost; this update does not solve it.

Rejected experiments include widening every lane, shortening the side guard
with body projections, and applying GT3's bounded yaw predictor to GTP. They
caused corner or self-fight regressions. GTP retains its existing predictor;
the new prediction setting is limited to Harbor GT3. No rain tuning changed.

A fresh GTP RAZOR/APEX rolling-start prefix ran through 20 seconds after
green with 630 replies each, zero contacts, incidents, damage or errors, and
25 ms simulated RAZOR reply-age p95. Both started on hards. This checks launch
and worker operation, not a completed race or a lap-time comparison.

The two-lap RAZOR/APEX seat-worker smoke completed without errors, contacts or
incidents. Its combined delay percentiles are invalid because the legacy harness
includes APEX replies without timestamps. A dedicated RAZOR/RAZOR one-lap worker
check completed without controller errors or recorded incidents, with 3 contact
steps and finite simulated reply ages of 25 ms. It does not establish a zero-contact
worker result or a hardware-independent transport guarantee.

An earlier actual-worker GT3 endurance prefix ran through 75 seconds after
green, starting RAZOR on hards and APEX on softs. RAZOR returned 2281 control
replies with zero contacts, incidents, damage or errors. Its simulated reply-age
p95 was 25 ms; APEX's timestamp-less reply ages remain unavailable. This prefix
does not establish a completed endurance race or compare equal-tyre hot laps.

Earlier Changeable checks traversed wetness 0.00–0.93. The dry stint
maximum is restricted to Clear; applying it between showers had forced a poor
fresh-soft stop and caused a GTP regression. With normal weather planning restored,
GTP completed without incidents or controller errors but lost by 27.43 s with
two stops. GT3 completed without controller errors but lost control, went off
track, hit the wall and required recovery; it lost by 50.47 s with two stops.
Weather strategy and GT3 wet stability remain explicit limitations.

## Still to solve

1. Mid-corner equal-class attacks and identical-driver GT3 worker fights at 60 Hz
   remain unresolved, as does the native matched-60-Hz GTP self-fight.
   The current GTP 60 Hz worker self-fight does convert cleanly at 4.43 s,
   while its attacks-disabled control never passes in the 24-second window.
   The 30 Hz equal-car GT3 worker fight now converts cleanly. In the corner case,
   attacks disabled completes a pass at 16.15 s while
   the current attack policy fails to convert within 24 s and loses time.
2. Warm GTP hard stint fade: one final stint still rose about five seconds.
   The four-second target is not universally met.
3. Defense against a varied field, dense moving traffic, more circuits, more
   seeds and worker cadences beyond the passing 30 Hz matrix. Current evidence
   is chiefly Harbor; the passing matrix is not proof of universal combat wins.
4. GT3 wet stability and weather decisions. Current rain evidence is not clean
   across both classes. Fit RAZOR's own stint priors instead of
   treating APEX's priors as final RAZOR calibration.

## Recycled-corridor correction

Reusing a geometry buffer at a distant track position retained the previous
window's passing lane. A direct reproduction left 75 stale stations displaced
by up to 2 m. RAZOR now restores the previous window's geometry, speed profiles
and offsets before reuse, including the join across the start line. The active
buffer is excluded from recycling and a regression check verifies it is unchanged.

All 66 checks and 33 native encounters pass: zero hard contact or off-track time,
60 light-contact steps. The four 30 Hz worker matchups retain their prior pass
times with zero attack contacts and zero off-track time for either car. A separate
GTP 60 Hz worker self-fight passes at 4.43 s, with zero contacts and a non-passing
control. GT3 at 60 Hz still fails to pass: attack finishes 17.1 m behind, compared
with 9.7 m behind for the control, with zero contacts/off-tracks in either run.
This GTP verification is not evidence that the recycling correction created the pass.

The seeded Clear endurance results are unchanged: GT3 wins the 12-lap hard start
by 1.32 s and the normal 20-lap race by 16.30 s. GTP still loses the normal 20-lap
race by 10.61 s, with three stops against APEX's two. The 20-lap GT3 race retains
25 light-contact steps; none of these three races has a hard contact, off-track
incident or controller error. See `UPGRADE_FRONTIER.md` for unshipped experiments
and remaining limits; this checkpoint is not a maximum-upgradability claim.

## Reproduce

```sh
node --import ./scripts/json-loader.mjs subjects/razor/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/encounters.mjs all 60
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-encounters.mjs razor lmdh --require-move
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-encounters.mjs apex lmdh --require-move
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-encounters.mjs apex lmdh gt --require-move
node --import ./scripts/json-loader.mjs subjects/razor/tools/worker-encounters.mjs razor gt --require-move
node --import ./scripts/json-loader.mjs subjects/razor/tools/endurance-check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs apex,razor lmdh 12 clear 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs apex,razor gt 12 clear 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs razor gt 12 changeable 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs razor lmdh 6 clear 7 soft
npm run game:build
```
