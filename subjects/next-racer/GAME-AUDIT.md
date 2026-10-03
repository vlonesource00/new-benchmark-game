# Current game and driver integration audit

Audit date: 2026-10-03. Source baseline:
`ea7b402ad02b0558e5c1d2e06627a1992e2d1971`, fetched from
`origin/graphics-aaa`. The work was rebased before inspection. PR #1's SOLSTICE
changes are present through merge `c48cb9b`. The later changes include sustainable
hybrid energy, class telemetry, lone qualifying and rolling starts. A separate
CLAUDE REVOLUTION proposal/pace probe was also added; it has no driver runtime.

This maps the systems that determine a driver's decisions, actual motion,
resources, race result and runtime. It does not claim a visual QA of every
rendering feature or validate the future LAN roadmap.

## 1. Authoritative control order

The active local game constructs `EnduranceRace` with `AsyncSeats`. Physics runs
on the render thread, with one asynchronous controller worker per team. Both AI
seats are constructed in that team worker; only the active seat drives. The older
`sim-worker.js` is retained for a future LAN host and is not the active local
game path. Sources: [main.js](../../game/main.js), lines 202–219 and 302–308;
[sim-worker.js](../../game/sim-worker.js), lines 1–4.

The actual `EnduranceRace.step()` order is:

1. During countdown, prime controllers in the final 1.5 seconds while the car is
   held and race time stays zero. No ordinary race physics runs.
2. In racing, advance time and weather; obtain projections and running order.
   During a rolling formation, the formation pilot owns controls until green;
   bridges only prepare during its final handover interval.
3. Make the team's pit call at its decision station. Race control can override it
   for a penalty or damage repair.
4. Obtain the active driver's controls, or run/blend the pit autopilot. Restore
   automatic gearing for AI takeovers.
5. Apply that driver's roster/governor policy, where applicable. Slow finished
   cars. Pit approach has its own speed scrubber.
6. Choose AI hybrid deployment using same-class gaps and session/laps remaining;
   run `hybridStep()` with the resulting controls.
7. Calculate wakes and integrate all vehicles; run marshal recovery; establish
   ghosting; resolve collisions.
8. Run stewards, timing, classification and finish checks.

Sources: [race.js](../../game/core/race.js), lines 163–288. A private forecast must
use this order. Calling only `Vehicle.step()` is not the complete race plant.

`FIXED_DT` is 1/120 second in native headless runners. The browser instead divides
each frame into `n = ceil(frameTime/FIXED_DT)` substeps and uses `frameTime/n`.
Those steps are near 120 Hz, not always exactly 1/120. `timing()` accumulates
off-track seconds using 1/120 directly. Record native lap validity, native
off-track counters and independently integrated off-track duration; do not
silently treat them as identical in variable-step tests.

## 2. What a driver can currently observe and write

The bridge receives public car objects and
`{ projections, order, totalLaps, mode, time, paceObjective }`. Both `mode` and
`paceObjective` currently say `race`, even during qualifying. The isolated probe
confirms the same six context keys in both sessions.

The car carries pose, velocity, yaw/steering, gear/shift state, setup, fuel,
damage, wheel state, tyres, public race progress/timing, class ID, hybrid store
and current hybrid force. Class specs are immutable. Worker transport omits
`spec` and reconstructs it using `classId`; deep-assignment into an immutable
spec is invalid. Opponent public motion is available; opponent controller memory
is outside the permitted observation contract.

The driver writes `car.controls` only. Throttle/brake are 0..1 and steering is
-1..1. Low-speed recovery may use the native `reverse` control after verifying
clearance. Normal AI gears are automatic. It cannot implement direct manual
short-shifting by changing `gear` or `automatic`, and cannot change setup,
energy, tyre state, fuel, pose, ghost status, timing or incidents.

Sources: [field.js](../../game/core/field.js), [remote-sync.js](../../game/bridges/remote-sync.js),
[vehicle.js](../../game/engine/sim/vehicle.js), lines 34–54 and 70–95.

## 3. GTP and GT3 are distinct physical classes

The race-class keys are `gtp` and `gt3`; vehicle-class keys are `lmdh` and `gt`.
Use both correctly in adapters, fixtures and reports.

| Property | GTP (`lmdh`) | GT3 (`gt`) |
|---|---:|---:|
| Dry mass | 1030 kg | 1290 kg |
| Wheelbase | 3.10 m | 2.78 m |
| Peak engine torque parameter | 720 Nm | 575 Nm |
| Forward gears | 7 | 6 |
| Aero coefficient `cl` | 4.30 | 2.25 |
| Frontal area | 1.60 m² | 1.90 m² |
| Tyre grip multiplier | 1.08 | 1.00 |
| Tyre wear multiplier | 0.80 | 1.00 |
| Spec half-length | 2.55 m | 2.30 m |
| Hybrid | 3 MJ | None |

Source: [car-specs.js](../../game/engine/sim/car-specs.js), lines 4–17. Acceleration,
braking, load transfer, gearing, aero and slip limits must be computed per class;
a faster GT3 reference alone is inadequate.

`classes.js` uses a 1.14 multiplier to scale the governor's GT3 pace reference for
GTP. This is a difficulty reference, not a measured GTP performance limit.
Multiclass assigns roughly 40% of teams to GTP, puts class groups on the grid,
classifies results by class and uses qualifying times within each class.

**Registration gap:** GTP accepts only `solstice` and `gemini-supreme-v4`. A new
roster driver is replaced during class assignment unless added to that allowlist.
The class-assignment name/short-name fallback also assumes those two names.
The probe's unregistered `next-racer` seat becomes `solstice`.
Source: [classes.js](../../game/core/classes.js), lines 6–8 and 33–59.

## 4. Latest hybrid behavior

The native implementation, not the prose roadmap, defines these values:

| Mode | Maximum deployment | Minimum forward speed | Lift regeneration |
|---|---:|---:|---:|
| QUAL | 120 kW | 8 m/s | 0 kW |
| ATTACK | 95 kW | 14 m/s | 40 kW |
| BALANCED | 70 kW, charge dependent | 25 m/s | 80 kW |
| BUILD | 20 kW | 45 m/s | 130 kW |

The store is 3 MJ. Braking harvest is up to **300 kW**, with 86% efficiency.
Deployment requires throttle >0.8, forward speed above the mode threshold,
gear ≥2, non-reverse driving and positive charge. Brake >0.05 harvests; otherwise
throttle <0.05 permits lift regeneration. Both fade at low speed. A full store
accepts no harvest. BALANCED reduces deployment as charge falls.

Braking harvest belongs to the brake torque already requested: it is not a
second extra braking force. Lift harvest is extra rear-axle drag. `hybridForce`
is `(deployment - lift)/max(forwardSpeed,12)` and joins engine torque before TC.
Source: [hybrid.js](../../game/core/hybrid.js), lines 17–55.

The host picks ATTACK when a same-class car is within 40 m ahead or 25 m behind
and charge is above 30%, or charge exceeds 90%; final-lap and low-charge rules
also apply. Qualifying builds on the out lap and uses QUAL on timed laps. It
does not expose a driver-owned deployment request. A new controller must predict
this native policy on private state; it must not write the live hybrid dial.
Other-class traffic does not itself trigger ATTACK. The present host gap scan
does not exclude a rival solely because it is pitting or finished; reproduce
current behavior rather than assuming a cleaner policy.

**Measured forecast gap:** at 45 m/s, gear 5, 60% charge, BALANCED produces
1,329.29 N at full throttle. On the next lift, the native force becomes
−1,777.78 N. A forecast retaining observed thrust still uses +1,329.29 N and does
not recharge the store. The isolated one-step world-velocity discrepancy is
0.003068 m/s; this is a transition probe, not a lap-time attribution.

SOLSTICE copies observed `hybridForce`, but does not run future hybrid energy or
mode transitions in its rollout. Its existing hybrid parity check covers the
observed-force path. Sources: [plant.js](../solstice/src/plant.js), lines 19–38;
[driver.js](../solstice/src/driver.js), lines 202–222; [audit JSON](analysis/game-audit.json).

## 5. Grip, tyres, aero and the road

Vehicle integration includes steering lag, automatic shifting and shift cuts,
four tyre/wheel substeps per chassis step, TC, ABS, differential torque, combined
slip, load transfer, pitch/heave-dependent aero and barrier/pit-wall response.
Fuel adds 0.75 kg/L. Forecasts need wheel transients and actuator state, not just
a bicycle-model curvature cap. Sources: [vehicle.js](../../game/engine/sim/vehicle.js),
lines 42–140; [tyre.js](../../game/engine/sim/tyre.js).

| Compound | Grip multiplier | Wear multiplier | Core optimum | Heat multiplier |
|---|---:|---:|---:|---:|
| Soft | 1.07 | 1.65 | 82°C | 1.06 |
| Medium | 1.00 | 1.00 | 90°C | 1.00 |
| Hard | 0.96 | 0.58 | 99°C | 0.90 |

Peak force depends on each wheel's core temperature relative to that wheel's
optimum, hot pressure, load sensitivity, wear, compound and surface grip. Wear
is driven by slip power, multiplied by race calibration, class and compound.
Surface heat above 115°C accelerates wear. Grip falls gently until 72% wear,
then more sharply. With 75% wear the wear-only factor is 0.92392; at 95% it is
0.84152. Neither factor captures accompanying heat, pressure or axle imbalance.
The most degraded rear wheel matters; averaging all four tyres hides it.

Wakes extend to 110 m, with a widening cone. They reduce drag by up to 42% of
the wake factor and downforce by up to 16%. A tow is useful on the straight but
changes the braking/corner budget. SOLSTICE's private rollout presently retains
the observed wake; a new planner should recalculate it against predicted public
rival poses. Source: [vehicle.js](../../game/engine/sim/vehicle.js), lines 59–61 and 145–162.

Harbor's native centerline is **2704.619 m**, its road width **16.4 m**, with
**1.25 m kerbs** per side. A 53-second lap implies a centerline-average
51.031 m/s; a 64-second lap implies 42.260 m/s. These are scale checks, not proof
of target feasibility. The map has a long straight, heavy-braking hairpin,
technical esses, a medium-speed loop and a final chicane. Geometry and signed
road curvature, not names or the hot-lap line's lane changes, must locate turn
inside and maneuver gates. Source: [harbor-ring.js](../../game/engine/sim/harbor-ring.js).

Rubber is stored in 13 lateral lanes. On dry asphalt it adds grip. In rain the
rubbered lane receives a larger wet penalty, so an alternate line can improve
grip as well as passing access. Kerbs have lower grip and bumps. Use the actual
wheel footprints and surface sampler. Spec/render size differs from the native
collision box, which currently uses fixed half-width 0.98 m and half-length
2.28 m for all classes. Enforce the native collision test and a conservative
class-body road footprint; do not alter physics to reconcile them.

Sources: [track.js](../../game/engine/sim/track.js), lines 85–108;
[vehicle.js](../../game/engine/sim/vehicle.js), lines 165–203.

## 6. Endurance strategy and pit ownership

Calibration deliberately compresses an endurance problem into a short race:

| Race laps | Full-tank reference laps | Medium tyre reference laps |
|---:|---:|---:|
| 6 | 4 | 5 |
| 12 | 8 | 10 |
| 20 | 9 | 11.25 |

Fuel reference laps are clamped to 3..9; do not infer a 14-lap tank from
`20 × 0.68`. The tank is 60 L. Fuel burn depends on throttle and engine RPM,
not direct road distance. `wearScale` and `fuelScale` are race-specific.
Sources: [rules.js](../../game/core/rules.js), [vehicle.js](../../game/engine/sim/vehicle.js), line 123.

`TeamStrategist` learns fuel per lap, worst-wheel wear and compound fade. Its
dynamic program compares compounds, stint lengths and stops under fuel/tyre
life constraints, with per-team aggression, patience and undercut styles. Pit
calls occur near the approach once per lap. It owns mandatory stops and swaps;
the driver should consume its resource target, not bypass its decisions.

The planner's initial lap/compound/stop-loss model is based on older GT races,
not a fitted GTP combat campaign. It learns lap reference/fade, but currently
uses worst-wheel wear and no explicit weather/human stint-pace input. Public
pit requests can override compound, fuel and swap. A fast human's earlier soft
stint followed by an AI hard stint is a separate test from two all-AI cars:
their total race times are not interchangeable.
Source: [strategy.js](../../game/core/strategy.js), lines 10–172 and 195–201.

The pit autopilot owns lane entry, box positioning, service and release. The AI
keeps control through the approach until nearly the entry, with host speed
scrubbing and a one-second blend. Service can refuel, change tyres, repair and
swap drivers. On exit the active bridge is reset. Harbor's finish line lies
within the pit-lane span, so the plan remembers the lap on which it was called.
Source: [race.js](../../game/core/race.js), lines 204–231 and 291–350;
[pit.js](../../game/core/pit.js).

**Transport gap:** SOLSTICE's local `teamState()` callback can read `entryOf()`
and calibration, but the team worker's fake race has only `cars`, `track` and
`lineFor()`. That callback returns null there. Public pit phase, plan and resource
targets should be transported explicitly for the new driver. A four-second fade
budget must cover the actual planned stint; repeatedly pitting early cannot
substitute for controlling degradation.

## 7. Weather, day/night and reproducibility

Weather writes wetness, temperature grip and ambient air onto the physics
track. Changeable uses seeded dry/building/shower/clearing fronts. Soft/medium/
hard are the entire compound catalog; there are no intermediates or wet tyres.
No weather-phase-aware compound planner currently exists in `TeamStrategist`.

`EnduranceRace` defaults `weatherSeed` to the race seed. **The active browser
explicitly generates a new random weather seed for each Changeable session.**
Capture the actual seed/front trace in future browser evidence; the displayed
race seed alone does not replay that weather. The standard endurance script
currently passes no weather option, so appending `--weather changeable` does not
exercise Changeable. Use an explicit native test harness that passes it.

Day/night is more than lighting: the browser's race clock drives `weather.sun`,
which changes track heating. Standard headless runs keep the weather object's
default sun unless the harness supplies the same clock. Sources:
[weather.js](../../game/core/weather.js), [main.js](../../game/main.js), lines 121–130,
218 and 528–532; [sim-endurance.mjs](../../scripts/sim-endurance.mjs), lines 71–95.

**Transport gap:** workers receive wetness and `tempGrip`, but not ambient.
The native rain probe has 14.3°C ambient while a newly constructed worker track
defaults to 24°C. Ambient changes tyre cooling and pressure, so matching surface
grip alone does not give thermal prediction parity. No wet retuning was performed
in this investigation.

## 8. Race control, recovery and results

Stewards group incidents over 2.5 seconds, assign points, issue drive-throughs
and disqualify for excess incidents or unserved penalties. Heavy contact points
begin above 3.5 m/s closing speed. The vehicle's severe-contact counter uses
6 m/s. Minor contact may score no points but still slow/damage a car; zero
incident points is not zero contact.

Flags are visible through the public race snapshot, not the current bridge
context. They include local yellow, blue, penalty black, damage meatball and
finish flags. Blue is triggered by a car >half a lap ahead on race progress
within 70 m behind; class difference alone is not that condition. The HUD has a
separate GTP-behind warning. The new driver needs actual flag/hazard observations
plus class-aware traffic behavior; it should not invent enforcement that the
game does not implement.

Marshal rescue is an automatic host fallback for beached cars. It moves the
car and ghosts it, retaining resources. The AI must detect that reset/reposition
and clear its maneuver. A rescue is a robustness failure in a clean test, even
when the game's pit rescue does not increment incident points.

Qualifying is an out lap plus two timed laps, soft warm tyres, initial full
hybrid store, ghosted cars and a time limit. AI controls are still called with
the generic race context. Race results can include lapped finishers or DQs;
`finishTime !== null` alone does not mean all requested laps were completed.
Check `lapsDone`, `dq`, penalties, clean lap states and finish reason.

Sources: [stewards.js](../../game/core/stewards.js),
[race.js](../../game/core/race.js), lines 77–113, 116–136, 352–379 and 416–470.
Career ratings use class position and incidents; the driver should produce good
native results, not alter ratings or their calculation.

## 9. Worker cadence, debug and future adapter work

### Rolling formation and green handover

The browser now defaults to `startType: 'rolling'`; the native constructor and
standard headless script still default to standing. The latter needs `--rolling`
to match the browser start. Race phase is already `racing` during formation.
The pole slot is moved before the start zone, cars start at 24 m/s and the native
formation pilot drives two-wide rows. Weather, tyre/fuel physics, hybrid and
collisions run. Hybrid mode is forced to BUILD while formation remains active;
steward stepping is suspended until green. Raw contact diagnostics still matter.

About one second before green, the formation pilot resets active bridges and
calls their `update()` to prepare live controls, then **overwrites those controls
with its own autopilot output**. On the green step a bridge can also receive the
normal race update at the same timestamp. The current context exposes neither
formation ownership nor this preview status. Sources:
[formation.js](../../game/core/formation.js), lines 10–24 and 73–85;
[race.js](../../game/core/race.js), lines 105–110, 184–189 and 253–255.

The isolated single-GTP smoke run confirms first preparation at 10.825 s while
formation still owns the car, green at 11.783 s, three bridge resets (constructor,
start and handover), and one duplicate update timestamp. It completes with zero
contacts. These times describe this fixture, not a general field timing guarantee.
Forward formation/preview status and handle duplicate timestamps without double
advancing estimates, resource budgets or a battle episode. Learning actuator or
traction response from overridden formation controls would produce bad models.

### Worker transport

The host uses the last returned controls while a worker thinks. Only one request
per seat is in flight. Snapshot time and sequence are sent; accumulated posted
`dt` is capped at 0.1 s. The true observation interval may exceed that cap.
Use timestamp differences for estimation and stale-state detection. Countdown
priming must not start stall recovery. Reset, inactive seat, handover and session
transitions must invalidate old plans/replies.

The current seat worker rebuilds projections and order, but omits session,
phase/formation, weather ambient, flags/hazards and team/strategy data. It returns controls
and a small debug summary. `visualDebug()` in the adapter draws the summary's
`trackingPoint`. The old `remote.js` / `ai-worker.js` path is a separate benchmark
offload system and needs its own factory/registration if used; it is not a
substitute for testing actual `AsyncSeats`.

Keep any future public context additions optional and additive so existing AI
semantics remain unchanged. These adapter additions are **proposed**, not applied
here. They extend the original registration-only file scope and need an explicit
integration scope when implementation begins. Sources:
[async-seats.js](../../game/core/async-seats.js),
[seat-worker.js](../../game/core/seat-worker.js),
[ai-debug.js](../../game/ui/ai-debug.js), lines 35–65.

## 10. Evidence and limits

`tools/game-audit.mjs` reproduced class remapping, live race/qualifying contexts,
rolling handover, ambient mismatch, current calibration and the isolated hybrid
transition. It
records source hashes and uses native rules/vehicle/race code. Transport findings
are source checks plus a reconstructed default track, not a browser latency test.

On this baseline, `game:build` passed (167 modules) and SOLSTICE's existing suite
passed 33/33. No game, competitor, SOLSTICE tuning, governor or strategy file was
edited. Previous SOLSTICE reports remain historical: the 6/11 passes at 30 Hz,
62.03-second GT3 lap and approximately 3.08-second hard-stint fade are not new
GTP results and do not certify the architecture proposed here.

The roadmap's 54.4-second Harbor GTP reference is an older solo report, not a
fresh sustainable-energy benchmark. There is no measured sub-53 result for the
new driver. Pace sweeps are intentionally deferred until the combat gates pass.

The newly added [CLAUDE REVOLUTION proposal](../claude-revolution/ARCHITECTURE.md)
also has no runtime. Its 55-second GTP objective and pace-first milestone sequence
are different from this user's <53-second, combat-first objective. Its
[pace probe](../claude-revolution/tools/bench-pace.mjs), lines 12–20, collects
completed lap times but does not filter invalid laps from its best/fade sample.
Its printed baseline is therefore not sufficient evidence of clean sustainable
pace. No other subject's code or document was changed in this investigation.
