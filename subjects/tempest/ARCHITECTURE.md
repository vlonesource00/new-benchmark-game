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

## 7. Open work

- Rain damage (12.7 %) and rain pace
- Early braking behind slowing cars on straights
- Start and first-lap routing
- Defence: passed 2.4 times a race, against 0.5 for RAZOR
- Duels against RAZOR (`scripts/bench/tempest-duel.mjs`): 0–1 wins of 8, about −1.1 s. Following RAZOR loses time to failed attacks into slow corners and to corners taken in heavy wake on lap 1
- Own strategist and lens profile
- Other tracks
