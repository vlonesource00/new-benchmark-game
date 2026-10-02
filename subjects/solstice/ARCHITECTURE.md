# SOLSTICE: whole-lap geometry, live tyre forces, bounded feedback planning

Base: `aae03fc9cd5d587ebb02521647ffc4ddc9a257d4` of `new-benchmark-game`.
The engine, timing, compounds, strategist, governor, pit autopilot, and other
drivers are read-only. SOLSTICE writes only its own `car.controls`.

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

## Frozen first implementation

1. Sample each circuit uniformly in track distance. Optimize a periodic,
   bounded lateral line with a whole-lap travel-time objective. Compute actual
   Cartesian segment lengths and signed three-point curvature; do not treat a
   centreline corner as the curvature of an offset path. Limit the car centre
   to the asphalt envelope with a footprint/tracking margin.
2. Build a speed envelope from tyre force capacity plus downforce, with forward
   power-limited acceleration and backward combined-slip braking. Rebuild for
   live compound, wear, pressure, core temperature, wetness and aero wake.
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
   uncertainty through the horizon. Choose and hold one pass/defence lane;
   return to the time-optimal line after the engagement. Following brakes only
   apply to a predicted occupied corridor. Alongside cars receive clearance.
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

### Momentum and warm-tyre revisions (2 October)

Deep whole-lap optimization and a longer geometric curvature chord produced
clean sub-64-second Harbor laps in normal GT/soft/20-lap races. The best recorded
development lap is 62.625 seconds; subsequent laps still slow as the outer rear
tyre heats up. This demonstrates raw pace, not stint acceptance. The Harbor
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

Additional rear rotation requires both maximum rear core temperature above
86 degrees C and maximum rear wear above 12%. Authority ramps with both
quantities and with corner-entry demand. A fresh set after a pit stop does not
inherit the previous set's slide request. The normal inverse tyre-force steering
remains active throughout; the extra rotation is a candidate, not a mandatory
drift. Its effects on warm pace and tyre energy must be measured together.

Pit preparation uses a private copy of the host autopilot's public reference
line. Earlier preparation used SOLSTICE's different race line and delivered a
large lateral/heading mismatch at takeover. No host pit geometry or autopilot
implementation is changed.

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
