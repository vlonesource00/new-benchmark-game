# TEMPEST: a lane-lattice traffic racer

TEMPEST is a new driver architecture for GTP and GT3, built from what APEX,
RAZOR and SPEARHEAD document about their own limits. It does not extend any of them.
It imports only shared *libraries*: APEX's identified vehicle model (`model.js`), the
`Line` geometry container and the baked minimum-time lines (`data/lines.json`).
Those are physics measurements, not tactics. Everything that decides what the car
does is TEMPEST's own: perception, forecasting, the planner, the rollout, the arbiter,
the controller, the weather sense and the strategist.

## 1. What the others teach (the targets)

| Source | Documented weakness | TEMPEST answer |
|---|---|---|
| APEX §13.1 | Many behaviours write one shared plan, so a move kills itself mid-way | **One arbiter, one committed lane.** Behaviours are candidates scored on one scale; the committed lane is itself a candidate (the *hold*) and is only replaced when beaten by a margin. |
| APEX §13.2 | Lanes are scored against its own racing line, not against the race | **Outcome scoring.** Every candidate is rolled forward and scored by time to the horizon and the predicted order against every rival there. |
| APEX §13.4 | Dirty air is a scalar applied where the car is | **Wake in the rollout.** The game's wake cone is modelled per station: corner speed loss behind a car, tow on straights. |
| APEX §13.5 | Stability is reactive | **Anticipated stability.** The yaw-overshoot trend eases the pedals before the slide; a protective slip layer caps throttle on a loose rear. |
| RAZOR limit 2 | Ego and rival progress measured in different frames | **One coordinate system:** track distance `s`, lateral `d`, time per station. |
| RAZOR forecast audit | Long-range rival forecasts are uncertain | **Uncertainty tubes.** Forecast bodies grow with time; contact clearance is `0.2 + 0.5·σ`. |
| RAZOR limit 3 | Commits to an outside lane that closes in braking | The rollout covers the braking zone and corner in one horizon, so a closing lane costs its true time. |
| RAZOR / SPH | No multi-car routing | The lattice routes through any number of cars at once. |
| SPH | 125–330 ms planner, wall-clock budget, emergency fallback | Fixed-size DP + 9 rollouts, deterministic, no wall clock. |
| All three | Rain is one global grip number | **Water in the planner.** Lanes read the shared water map at their own lateral position. |

## 2. System

```
car, cars, context.state
  └─ Perception (road frame s, d; rates; class, team, architecture, pit/hazard flags, spray)
       └─ Forecast (per rival: speed along its line, lateral decay, defender reaction, uncertainty)
            └─ Atlas (static lane library: the line shifted by −6…+6 m in 1.5 m steps, each solved for speed;
            │         corners, braking points, inside sides)
            └─ Lattice (DP over stations × lanes with lane-change lengths, follow caps, water)
                 └─ Rollout (simulates the exact lane window the controller will execute, ~9 candidates:
                 │           drive/brake envelope, wake cone, contact as a peak event per rival)
                 └─ Arbiter (candidates: hold, DP best, line, beside-left/right; margins; commit)
                      └─ Controller (APEX-law preview steering, side guard, friction circle, traction)
                           └─ car.controls
```

## 3. Mechanics

- **Lane library (Atlas).** Each lane is a full-lap speed profile, scaled live by grip,
  push and water.
- **Lattice.** Chooses a lane sequence to the horizon. Its cost is travel time plus
  following caps behind forecast rivals and change cost.
- **Rollout.** The DP's cost is approximate, so each serious candidate is simulated
  station by station on the window the controller will actually drive.
  - Contact is scored as an **event**: the peak risk per rival, weighted 0.4 when the
    rival is behind. A summed cost made long, slow lanes look safe and was measured worse.
  - **Wake.** Inside the cone `cw = 2.4 + 0.05·gap`, with weight
    `exp(−gap/55)·(1−(lat/cw)²)`, corner speed is capped by `model.wakeSpeed` and tow
    adds acceleration on straights. This made ATTACK prediction bias go from +0.17 to ~0.
- **Hold candidate.** The committed path is re-scored every decision. A challenger must
  beat it by 0.15 + commit·|Δoffset|, or by 0.05 when the challenger is the racing
  line. This stopped dithering.
- **Line snap.** A path within 0.3 m of the line becomes the line. Re-anchoring happens
  only when committed to a lane.
- **Beside candidates.** These are rival-relative lanes on both sides of the nearest
  target. Each joins the rival's forecast lateral position plus clearance, holds for
  max(70 m, 2.3·v), then rejoins. They are exempt from the side-change margin when they
  stay on the current side.
- **Side guard.** A car behind counts as alongside only within its length + 0.5 m +
  closing·0.4 s. The guard never pushes the car past the road edge.
- **Defender model.** The forecast predicts each architecture's reaction to an attacker
  in its tow: RAZOR covers once, APEX holds its line, SPEARHEAD keeps the fast course.
- **Team play.** A team-mate is never a defence target.
- **Hazards.** Stopped, spinning and pit-entry cars are obstacles and are never targets.
- **Spray.** In rain, a car within 50 m ahead widens its forecast tube.

## 4. Controller

Preview steering on the committed path, with feed-forward and slip from the identified
maps, yaw-rate and sideslip feedback, and a jerk-limited slew. The pedals:

- follow the path's speed profile, or its braking envelope when tow or hybrid is
  available
- apply the plan's follow cap and an immediate nose cap
- share the friction circle with lateral demand
- use a traction governor on driven-axle combined slip
- have a protective slip layer for a loose rear

## 5. Weather

TEMPEST reads the shared water map (`WaterField`). Lanes read the water at their own
lateral position, so puddles and the drying line shape the route. The strategist uses
the shared rain and crossover rules.

## 6. Measured decisions

Harbor, LMDh, 3 laps, 8-car fields of 2-car teams (TEMPEST, RAZOR, SPEARHEAD, APEX
last), hard tyres, rolling start (`scripts/bench/tempest-field.mjs`). Mean place for
TEMPEST, lower is better.

| Change | Mean place |
|---|---|
| Initial lattice | 7.50 |
| Contact as peak event | 6.38 |
| Hold candidate | 5.25 |
| Wake in the rollout | 5.50 (prediction bias fixed) |
| Clearance 0.2 + 0.5·σ | 4.88 |
| Beside candidates | 4.58 |
| Side-guard fix | 4.33 |

Rejected after measurement:

- route gate: 4.67 / 5.58
- wider beside clearance: 4.83
- harder braking caps: 4.54
- lane jerk limit: no effect

Four-track bench (Harbor, Solenne, Alpine, Desert; seeds 7–9; 12 races). The
baseline is 4.00 and repeats exactly.

The two prediction fixes below make the rollout more accurate, but they lose
races. The clearances and margins were calibrated against the old biased
predictions, so these fixes need a joint re-tune, not a drop-in.

| Change | Mean place |
|---|---|
| LMDh `brakeExp` 2 instead of 1.85 (solo −0.04 s/lap) | 4.71 |
| Forecast arc length converted to road distance (rival error at 1.5 s: 3.5 → 1.2 m) | 5.04 |
| Rollout clock started at the car instead of 1–2 stations behind (PACE bias −0.08 → 0.01 s per 1.5 s) | 4.88 |
| Both prediction fixes | 4.42 |
| Both prediction fixes + `clearSig` 0.7 | 5.00 |

Behaviour bench (a local field script, not in the repository: 6 field races; place, lane changes per minute), after stable labels:

| Change | Place | Lane changes/min |
|---|---|---|
| Stable labels (baseline) | 4.67 | 20.2 |
| ATTACK named only when the move starts (kept; field 4.17 vs 4.13) | 4.42 | 18.8 |
| Delayed beside candidates (`besideDelay`, off) | 5.42 | 26.8 |
| Lattice wake = the game's cone (rejected: a wider cone needs a bigger sidestep, taken more often) | 4.92 | 22.5 |

Per-state 1.5 s prediction bias is negative everywhere (PACE -0.063, TOW -0.045, ATTACK -0.036 s): TOW is not chosen
on an over-promise. Off-line time is mostly ROUTE (3.6 m mean) and TOW (1.9 m).

Strategy: the current-physics stint model on every clear race (was Harbor only): Alpine 12 laps 814-818 -> 803 s,
Solenne 10 laps 583-585 -> 577 s.

Envelope profile only in a real tow (not in every non-PACE state): duel −1.32 s,
against a −1.17 s baseline.

What the corrected rollout shows: ATTACK lanes over-promise by 0.1–0.24 s per
1.5 s whenever the traction governor or the stability layer acts. That is the
next target.

Solo pace with a forced plan matches the line: 52.26 s against 52.25 s.

Deterministic baseline, 12 seeds:

| AI | Mean place |
|---|---|
| RAZOR | 2.00 |
| TEMPEST | 3.88 |
| SPEARHEAD | 5.54 |
| APEX | 6.58 |

Tread budget (`src/tread.js`, off by default, `tread: true`): spend the set's life as grip margin, with the push
solved so the projected end wear lands on a cap under the wear cliff. Solo it beats RAZOR's best laps (Harbor 52.42 s,
Alpine 60.79 s, Solenne 50.16 s at cap 1.05), but every field variant lost places (four-track bench, 4.17 without):

| Variant | Mean place |
|---|---|
| Spent everywhere, cap 1.05 / 1.03 | 5.29 / 5.54 |
| Racing line only (lanes at the unspent margin) | 4.83 |
| Clean-air PACE only | 4.75 |

The pace gap to RAZOR is its stint budget (margin 0.97 → ~0.999 by lap 3 on clear tracks), not the speed profile:
with `brakeExp` 2 the two profiles are identical.

### Outcome books and the pass fixture

`src/outcomes.js` books passes by body clearance (our rear past the rival's nose), retention as clearance held through
the whole interval (1 s), race passes apart from traffic and hazards, and every attack as declared → started (moved
toward a corridor) → overlap → completed, or failed with its reason. The controller records every constraint that
lowered the target speed and every layer that cut the pedal, and the worse driven wheel's spin and lateral slip.
`scripts/bench/tempest-pass.mjs` replays one encounter (TEMPEST behind one rival) with those traces, the rival forecast
error and when each claimed pass would resolve. The field bench reports these outcomes; its ranks columns are sampled
order changes, not passes.

Baseline outcomes (four-track bench, 24 TEMPEST car-races, place 4.17 reproduced exactly with the books on), per
car-race: attacks declared 19.9 → started 12.3 → overlap 2.9 → completed 0.83 → retained 0.75; race passes 0.96
(retained 0.88), race places lost 1.83. Of 293 failed attacks, 223 started and never reached the overlap.

First fixture (Harbor, behind APEX): 15 attacks declared, 1 reached the overlap, 0 completed. TEMPEST's own arrival
prediction was right (−0.1 s per 1.5 s) and the game never changed its pedals. The rival forecast covered 4.5 s, but
87 % of the passes the chosen plan claimed resolved later (median 6.0 s), against a rival frozen at its 4.5 s point;
the lattice also checked contact against that frozen car. Behind a slower rival the time is lost on corner exits in
its wake, where TEMPEST's own traction governor cuts the throttle.

Forecast validity: the forecast now spans 10 s; past it a rival keeps moving at its last forecast speed (never parked,
never gone), the rollout checks rivals over its whole horizon (it ignored them past 4.4 s), and neither the lattice nor
the rollout scores a pass or a lost place that resolves beyond the span. Per TEMPEST car-race, four-track bench:

| | Place | Declared | Started | Overlap | Completed | Retained | Places lost | Incidents | Damage |
|---|---|---|---|---|---|---|---|---|---|
| Stage 0 baseline | 4.17 | 19.9 | 12.3 | 2.9 | 0.83 | 0.75 | 1.83 | 1.3 | 3.3 % |
| 10 s span + validity | 5.04 | 6.4 | 3.7 | 3.2 | 0.67 | 0.63 | 2.46 | 2.9 | 8.3 % |

(10 s span alone, rollout still blind past 4.4 s: place 4.50.) Phantom attacks are gone and most started attacks now
reach the overlap, but the car does not convert them (stalled alongside 23 against 12) and defends worse. The
clearances, margins and pass value were tuned against the frozen forecast; retuning them around the rule is Stage 1.

**Both rows above are suspect.** The field bench disables pit stops, but a 5-lap race gives each car a tank for about
3 laps (`calibrate`: `fuelLaps` = 0.68 of the distance, then a stop). Every car ran dry on lap 4, coasted to a halt,
and was "recovered by marshals" for incident points. The bench now gives each car a tank for the whole distance (its
`fuelScale` divided by laps + 1 over `fuelLaps`). With that change an 8-car, 5-lap race finishes on both paths with
about 20 L left. Places must be re-baselined before any comparison. The pass fixture runs a 20-lap race, which carries
fuel for 9 laps, so its 90–120 s runs were never affected.

### The worker path

In the browser every AI seat runs in a Worker (`game/core/async-seats.js` → `game/core/seat-worker.js`). The car keeps
its last controls until a reply arrives, and the driver sees the reply delay as `controlDelay` and the held interval
as `dt`. `scripts/bench/lockstep-workers.mjs` stands in for the Worker in Node:
- it runs the unmodified seat-worker module, one instance per seat;
- it structured-clones the messages;
- it holds each reply to a frame boundary (2 physics steps per 60 fps frame), plus `lagFrames` whole frames of extra
  delay for a planner slower than a frame.

The shim is deterministic: two runs give identical output. Both benches take `--path worker [--frameSteps 2]
[--lagFrames 0]`. At zero lag the worker path matches native (behind APEX, 120 s: −39.6 m against −37.7 m, same
outcomes). TEMPEST's update takes 0.15 ms on average and 5.4 ms at most in Node. That does not prove a browser worker
never overruns a frame.

**Held controls.** The old delay compensation caused a steering limit cycle (±0.6 steer at about 3 Hz) under held
controls:
- it led the pose by `controlDelay` + 1.5·dt (cap 0.09 s);
- it extrapolated the yaw rate;
- the stability layer then cut the throttle.

`predict` now works like this:
- It caps the lead at 0.045 s.
- When dt + `controlDelay` is longer than that, it steps the game's own `Vehicle` on the held controls instead
  (`heldPose`), over `controlDelay` + 0.5·dt (cap 0.06 s).
- `heldPose` uses a road copy whose `deposit` returns 0, so no rubber or spray reaches the live track.
- The live car and track are unchanged in clear weather and rain.
- Native output is byte-identical.

Matched worker runs behind RAZOR, 90 s (gap, + = ahead):

| | old hold | new hold |
|---|---|---|
| zero lag | −37.4 m | −24.2 m (native −23.8 m) |
| one frame of lag | −392.6 m | +19.9 m, 1 contact, 4 % damage each |
| two frames of lag | −1019 m | −92.7 m |
| 2× speed (new only) | | −19.8 m |

Behind APEX 0.94 with one frame of lag: −416 m → −40.8 m. At 4× speed both cars still fall apart; this remains an
open limit.

In the one-lag run, TEMPEST retained a race pass at 62.6 s. The contact came earlier, at 58.4 s, and was not part of an
attack:
- TEMPEST was routing behind RAZOR into a braking zone and was 3 m/s faster at a 6.4 m gap.
- In 0.8 s it moved 7 m sideways onto RAZOR's line.
- It released the brake while its target speed (18.3 m/s, lane envelope, no cap) ignored the car ahead in the lane it
  joined.

The fix for that is a following cap on the chosen lane (Step 2).

## 7. Open work

- 4× time scale through the worker path: the delayed replies span several physics steps and the car still loses control

- Rain damage (12.7 %) and rain pace
- Early braking behind slowing cars on straights
- Start and first-lap routing
- Defence: passed 2.4 times a race, against 0.5 for RAZOR
- Duels against RAZOR (`scripts/bench/tempest-duel.mjs`): 0–1 wins of 8, about −1.1 s. Following RAZOR loses time to failed attacks into slow corners and to corners taken in heavy wake on lap 1
- Own strategist
- Other tracks
