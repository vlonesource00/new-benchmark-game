# SOLSTICE: whole-lap geometry, live tyre forces, bounded feedback planning

Integration base: upgraded `2935523` of `new-benchmark-game`; the combat
revision builds on the released SOLSTICE configuration at `c01544c`.
The current development base is `origin/graphics-aaa` at `0a4be3c`, including
native Changeable weather fronts, stewards and GTP hybrids. Rebase onto that branch before new work and
before pushing until its merge into `main` is confirmed.
The private vehicle copy and drive-force estimate include observed hybrid thrust;
deployment and energy state remain owned by the host. The reported pace target
and endurance measurements use GT, not a tuned GTP race campaign.
SOLSTICE writes only its own `car.controls`. Engine physics, timing, compounds,
strategy, pit autopilot and other driver implementations remain upstream.
The authorized integration exceptions forward the worker's aim point and skip
the governor for SOLSTICE at ALIEN. Below ALIEN the normal difficulty governor
still runs; other drivers keep their upstream management policy.

## Findings and performance hypotheses

Phantom v1/v2 use the same sampler: 40 candidates, a two-second horizon and
15 Hz planning, approximately 81,000 private vehicle integration steps per
simulated second per car. Their ghost apex envelope fixes much of their
long-range speed; v2 principally improves opponent prediction and the combat
gate. Their plant imports `host/astra/src/sim/vehicle.js`, while the endurance
game adds compound grip, wear scaling, weather temperature, pit geometry and
fuel calibration. A locally exact rollout therefore has avoidable model error.

Gemini v4's default disables traffic planning. Solinator uses calibrated
Harbor-specific road deformations, an analytic envelope, and disables its
physical search in free air. Astra's racing line has a restricted lateral
range and a conservative speed envelope. These are concrete opportunities,
not proof that SOLSTICE beats them. Baselines and race results are recorded in
`RESULTS.md`; the supplied prompt's numbers are not substituted for measurements.

## Control pipeline

1. Sample each circuit uniformly in track distance. Optimize a periodic,
   bounded lateral line with a whole-lap travel-time objective. Compute actual
   Cartesian segment lengths and signed three-point curvature; do not treat a
   centreline corner as the curvature of an offset path. Limit the car centre
   to the asphalt envelope with a footprint/tracking margin.
2. Build a speed envelope from tyre force capacity plus downforce, with forward
   power-limited acceleration and backward combined-slip braking. Rebuild for
   live compound, wear, pressure, core temperature, wetness and aero wake. Each
   tyre carries its own optimum and heat coefficient; no universal 85-degree
   temperature window is assumed. Prediction copies aero and every tyre field.
3. Steer with velocity-course pursuit, inverse front/rear combined-slip force
   feedforward, sideslip and yaw feedback. At low speed use geometric pursuit.
   Longitudinal feedforward and traction feedback avoid heating tyres beyond
   the force peak. Brake before an apex and release as lateral demand grows.
4. At a bounded cadence evaluate a small deterministic set of closed-loop
   policies on private copies of the actual game `Vehicle`. Include faster,
   more conservative and alternative-line policies. Score progress, future
   braking feasibility, track limits, stability, tyre energy and opponent
   occupancy. Execute feedback every update, rather than replaying old steering
   open-loop between plans.
5. Predict opponents from public positions, world velocities, yaw, lateral
   velocity and observed acceleration. Reserve their oriented footprint and
   uncertainty through the horizon. Compare bounded racing-line, parallel road
   lane and shifted racing-line trajectories on both feasible passing sides;
   use road curvature to identify the inside. Keep a useful side committed,
   reconsider a closing door before body overlap, and remember a failed side
   briefly instead of repeating the same unsuccessful approach. Make at most
   one defensive move per approach and reject optional
   defensive trajectories that lose excessive progress or exit speed. Following
   brakes apply to a predicted occupied corridor. Alongside bodies receive
   clearance through corridors or a physically validated leading trajectory.
6. Read team fuel targets through a bridge callback in local mode; infer burn
   from public fuel state when worker context has no strategist. Save only when
   the stint needs it. The automatic gearbox is owned by the game, so fuel
   saving uses lift-and-coast; manual short-shifting is not part of the interface.
7. Detect takeover, pit release, discontinuous position and wrong-way/stuck
   states. Clear plan history; recover with controls (including reverse), never
   modify motion or race fields. Cold tyres use their actual force capacity.

## Why this may be faster and cheaper

Whole-lap optimization can discover a different entry/apex/exit outside a short
MPPI horizon. Force-based feedback can operate closer to grip without using
off-track cuts. Live tyre/compound prediction can make the fast plan sustainable
instead of relying on the governor to repair it. Deterministic feedback policies
spend integrations on coherent trajectories rather than noisy control knots.
These claims require the same game-fork benchmark as every comparison driver.

## Validation and limits

### Momentum and warm-tyre revisions

Deep whole-lap optimization and a longer geometric curvature chord produced
clean sub-64-second Harbor laps in normal GT/soft/20-lap races. Upgraded-game
measurements are separated from the older physics in `RESULTS.md`. Fast opening
laps demonstrate raw pace; total race time and tyre life determine acceptance.
The Harbor
geometry setting cannot be copied to the other circuits: their tighter line
variants require a shorter chord and separate full-race validation.

Force allocation must distinguish a requested future cornering force from the
force the tyres actually produce. Reserving the entire requested force could
eliminate all braking precisely when a worn, overspeed car needed it. The new
braking experiments use actual tyre forces and evaluate a bounded exchange of
lateral force for brake force on the private game plant.

Optional overtaking/defending corridors are now trajectory candidates. The
planner may retain the faster feasible line; an actual alongside body still
requires clearance. Execution uses the selected corridor, rather than applying
the first traffic proposal regardless of the private comparison. Occupied-lane
following limits remain available when the passing trajectory is rejected.

### Combat momentum revision

Passing preparation begins with up to four seconds to catch a slower rival.
The terminal cost prices a blocked continuation beyond the short physics
rollout, and lane feasibility includes the rival's observed turn-in until the
bodies meet. The selected attack commits its side; actual alongside positions
override an abandoned side. Speed caps depend on whether lateral clearance
can be established before catching the car ahead.

Optional defense uses a small lateral bias and a native rollout pace gate:
predicted progress may lose at most the larger of 0.75 metres or 4%, and
terminal speed must retain at least 94% of the baseline. Defense rearms after
two seconds of separation, allowing a new approach without repeated moves in
the same approach. A leading car in an established defensive approach can
offer its normal racing trajectory when each alongside rear body is physically
clear. This candidate still pays the full cost of actual predicted overlaps;
only a steady rear car's expanding uncertainty margin is capped at 0.35 metres.
Lateral crossings and irregular/rejoining cars retain their full reserve.
This exception is scoped to defended approaches, not passing rivals.

Emergency braking candidates require a forward or immediately overlapping
threat and cap the current target relative to current speed. They do not
multiply every future corner speed by a half-pace factor. These native-tested
candidates can trade more lateral force for braking, and prioritize a reduction
in the first 0.6 seconds of risk over a less certain later encounter. Track,
damage and stability rejections still exclude them.

An infeasible outside corridor holds a wider road radius instead of following
the hotlap line's lateral transition across its neighbour. An inside fallback
retains a moving racing-line offset rather than tightening its corner radius.
The physically clear leading candidate remains available to an established
defensive approach even when the nominal corridor cannot fit. Actual body
overlaps are never discounted. A separate escape candidate requires every
alongside body to be completely behind and physically clear, with full risk.
Two stationary grid cars with more than three metres of empty lateral space
between their body widths do not impose an alongside lane fence while still
widely separated during launch. This exception ends after four seconds or at
15 m/s; both bodies remain in prediction and collision scoring throughout.
With traffic within 60 metres, the complete small candidate set is compared;
the soft wall-clock cutoff only shortens optional work in free air. Machine
load must not decide which feasible combat trajectory is considered.

Traffic trajectories use each circuit's calibrated curvature span consistently
for steering, the whole-lap envelope and terminal feasibility. The periodic
envelope still includes forward acceleration and backward braking. Live passing
caps replace a stale cap only while the same rival, side and route remain viable;
an explicit emergency action retains its lower cap. The solo line, base pace
settings and temperature-and-wear rotation gate are unchanged.

Additional rear rotation requires a rear tyre whose core is above its own
optimum plus 4 degrees C and whose wear exceeds 12%. Both conditions must hold
on the same tyre. Authority ramps with both quantities and corner-entry demand.
A fresh set after a pit stop does not
inherit the previous set's slide request. The normal inverse tyre-force steering
remains active throughout; the extra rotation is a candidate, not a mandatory
drift. Its effects on warm pace and tyre energy must be measured together.

Pit preparation uses a private copy of the host autopilot's public reference
line. Earlier preparation used SOLSTICE's different race line and delivered a
large lateral/heading mismatch at takeover. No host pit geometry or autopilot
implementation is changed. Countdown updates at race time zero cannot arm
stall recovery, and discontinuities clear stale control plans.

Tyre-saving corner targets and physical braking reserve are independent. A
request to take a corner more gently must not weaken the brakes needed to reach
that lower target. Both commands still pass through the actual combined-slip
force limits and private vehicle prediction.

Held updates strengthen the force reserve as the observed interval grows from
25 to 40 milliseconds. That reserve is applied to the actual command between
planning ticks as well as to predicted candidates. Wetness above 0.08 gradually
adds the same protection, reaching full strength at 0.22. A fully wet envelope
uses at most 0.86 grip utilization, 0.84 corner utilization and 0.16 rear slip
authority. Existing lower per-circuit limits remain lower. These are calibrated
control reserves; the native wet-grip and tyre physics still determine forces.
Deliberate rotation always retains the temperature-and-wear gate.

The car's built-in traction control handles launch below 8 metres per second.
SOLSTICE's additional wheelspin feedback then takes over as speed builds.
Applying both controllers at launch previously starved drive force and left
cars converging side by side. Body corridors also reserve extra space for
orientation and predicted lateral motion, rather than reducing pace simply
because another car is nearby.

The four GT lines are baked as finite offsets in a small runtime asset keyed
by public circuit geometry, class and optimizer settings. Loading is checked
against a fresh optimization, including every point's body footprint. Other
classes and unmatched geometry are computed locally rather than using an
incompatible baked line.

Use the normal `EnduranceRace` at 120 Hz and ALIEN difficulty, preserving scaled
fuel, tyre wear, mandatory stops and driver swaps. Measure isolated/homogeneous
pace before mixed-field results. Test all four circuits, three seeds, clear/rain,
day/night, equal-driver traffic, cold starts and disrupted takeovers. Report
clean flying laps separately from grid, invalid and pit laps. Record CPU time
inside bridge updates separately from total simulation wall time. Race contacts
are a field-wide counter; do not falsely attribute them to individual cars.

The 64-second Harbor target is an acceptance target, not an assumed physical
bound. Failure to reach it does not establish that physics prevents it. Browser
worker latency and real human race performance require direct evidence beyond
synchronous headless laps.

`tools/pair-model.mjs` minimizes an analytical human/AI schedule using measured
post-pit AI stint prefixes and an assumed 65-second human average. Every stop
changes drivers and adds the native measured in/out-lap loss, which already
includes the swap. A dynamic program compares stop counts and stint lengths
while bounding the maximum measured fade within an AI stint. Human resource
reach, repeated profile reuse, and future pit loss remain assumptions. The
model does not drive a synthetic human, request boxes, choose a game compound,
or alter the strategist, lap clock or race state.
