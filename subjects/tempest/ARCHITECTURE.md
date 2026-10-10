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

The budget was rebuilt on RAZOR's StintBudget pattern (b8f54c6). Wear was measured against push (margin 0.97 → 0.999:
−0.23 s a lap, +6 % wear a metre, so wear ∝ 1 + 2·(push − 1)). The window is what the set must last: the race,
the planned tyre stop or the fuel window. The push is bisected to the largest value whose projected end wear stays
under 0.9 and whose projected fade stays under 3 s. It is capped at 1/margin (the force peak: past it the car slides).
Nothing is spent on a set's first lap, before its wear rate is measured: spending on an unmeasured prior hit the wall
on GT lap 1. Solo, Harbor: LMDh 52.70 / 52.72 / 52.90 s, GT3 62.04 / 62.18 s, against RAZOR 52.74 / 52.82 / 53.01 and
62.07 / 62.17 s. On the fuel-fixed field bench (four tracks, seeds 7–9, native) it still loses: base 5.04, clean-air PACE
only 5.08, spent everywhere 5.50 (incident points 1.0 → 1.7–2.4). Over 12 laps in the field (Harbor, Alpine, seeds 7–9) it is neutral too: place 4.83 → 4.92, incidents 3.0 → 3.5, damage 3.9 → 3.4 %. It stays opt-in. Regression checks: `node --import ./scripts/json-loader.mjs subjects/tempest/tools/check.mjs` (perception, bridge, pit + swap, SC, FCY, rain, changeable weather; ~35 s).

Line hold (`routeGate`, `routeHeavy`, `defend: false`): most race places were lost by leaving the racing line, to route
around a car (contact risk priced at ~3 s), to cover a lane, or to an off-line lane with no pass in it. The cars behind took
the line. Field place (seeds 7–9 / 10–12, four tracks, 24 car-races each): base 5.04 / 5.29; no combat at all 3.00 (damage
10 %); gate fully open + no defence 3.75 / 3.88 (passes 2.4 a race, damage 6–7 %); shipped: the line is held unless
leaving it passes someone or the line holds a heavy impact (closing past 6 m/s, a stopped, spun or finished car), 4.50 /
4.29, damage ~2 %, rain clean. On a wet road a lane taken for water is kept (gating it put a car off in the rain check);
gating only for traffic in the dry gave 5.08. Field races are deterministic (same seed, same result at any load).

Qualifying (`scripts/bench/quali-bench.mjs`, every AI in one ghosted session, soft tyres): the session hands TEMPEST
`qualiMargin` in place of `margin` (LMDh 1.0; the race keeps 0.97, tyre life and traffic). LMDh best laps Harbor / Solenne /
Alpine / Desert 51.18 / 48.59 / 59.14 / 63.58 s against RAZOR 51.47 / 48.57 / 59.14 / 63.60 (mean 55.62 vs 55.69, the
fastest of the four AIs). GT3 stays at 0.97: at 1.0 it slid on Harbor and Desert, 0.985 was neutral; it trails RAZOR by
0.04–0.45 s. Tread push does nothing here: it never spends on a set's first lap, the only fresh lap qualifying has.

Bench note: `--opts` go in after `prepare()`, so keys baked there (`brakeExp`, `gears`, `notch*`) never take effect
through `--opts`; per-class config is merged in `prepare()` and overrides earlier options.

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

**Both rows above are invalid**, and so is every field ranking made on the fuel-starved bench (the tread budget's
included; tread stays off). The field bench disables pit stops, but a 5-lap race gives each car a tank for about
3 laps (`calibrate`: `fuelLaps` = 0.68 of the distance, then a stop). Every car ran dry on lap 4, coasted to a halt,
and was "recovered by marshals" for incident points. The bench now gives each car a tank for the whole distance (its
`fuelScale` divided by laps + 1 over `fuelLaps`). With that change an 8-car, 5-lap race finishes on both paths with
about 20 L left. Places must be re-baselined before any comparison. The pass fixture runs a 20-lap race, which carries
fuel for 9 laps, so its 90–120 s runs were never affected.

Fresh baselines with the full tank, four tracks × seeds 7, 8 and 9, 24 cars per AI (place, best lap):

| | native | worker, zero lag |
|---|---|---|
| RAZOR | 2.25, 57.88 s | 2.25, 58.11 s |
| TEMPEST | 4.71, 58.37 s | 5.04, 58.45 s |
| APEX | 5.21, 58.23 s | 5.46, 58.29 s |
| Spearhead | 5.83, 58.86 s | 5.25, 58.82 s |

TEMPEST per car-race, native: declared 6.38, started 4.04, overlap 3.25, completed 0.96, retained 0.88, places lost
2.42, incidents 1.3, damage 4.7 %. Worker: declared 7.54, started 4.88, overlap 4.00, completed 1.21, retained 1.04,
lost 3.13, incidents 3.2.

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

In the one-lag run, TEMPEST retained a race pass at 62.6 s. **That pass was made by the contact, so it is not gate
evidence.** The fixture's `--ghost 57,61` drops collisions only in that window (armed from the race's ghost setter to
the end of the step, so both drivers still see each other). The runs are identical to 58.0 s. Without the collision
RAZOR exits at 25–33 m/s and TEMPEST ends 20.2 m behind; with it RAZOR is held to 16–22 m/s. The contact, at 58.4 s,
was not part of an attack:
- TEMPEST was routing behind RAZOR into a braking zone and was 3 m/s faster at a 6.4 m gap.
- In 0.8 s it moved 7 m sideways onto RAZOR's line.
- It released the brake while its target speed (18.3 m/s, lane envelope, no cap) ignored the car ahead in the lane it
  joined.

The fix for that is a following cap on the chosen lane (Step 2).

Why it was off its line: from 52.8 s, braking 65 → 27 m/s in RAZOR's wake (0.3–0.7) with one frame of lag, the steering
oscillated (±0.3–0.46, a sign change about every 0.3 s), sideslip reached 0.32 rad and stability 0–0.3. The car
reached the kerb at 56.0 s and the gravel at 56.2 s, 13.8 m off its path, and rejoined across RAZOR's line. Halving
`slideGain` (5 → 2.5) or `yawGain` (0.45 → 0.3) still ends in contact; this needs a delay-aware steering law,
judged on tracking over several runs, not on one gap. The fixture now prints the tracking (path error, time off the
asphalt, steering reversals per second, mean sideslip).

### Scoring against execution (Step 2, opt-in)

The pass fixture now checks, on every controller step under a committed plan, that what the controller receives matches
the plan that was scored. It checks four things:
- **Geometry:** the path is the chosen lane, or the line.
- **Lane:** the lane's speeds in its window are unchanged since it was built.
- **Cap:** the plan's cap reaches the controller.
- **Demand:** the controller drives the profile the rollout scored.

Geometry, lane and cap never mismatched. Demand did, on 73 % of the steps behind RAZOR: the rollout scores the speed
profile (`lane.v`), but outside PACE, or in wake, the controller drives the braking envelope (`lane.vbrk`). The label
changes only when a new plan is chosen, so no mismatch appears between decisions.

Three options, all off by default:
- **`unifiedLane`:** the rollout builds the lane the controller will drive (its margin, its demand starting from the
  line's speed or faster), and the arbiter keeps it instead of rebuilding it.
- **`capEnvelope`:** the rollout drives in two passes. The first pass finds the following caps. The second drives the
  whole loop again against their braking envelope, so rival encounter times, contact and caps are recomputed at the
  new arrival times.
- **`freeThrust: true`:** the controller always drives the envelope, and the rollout now scores the envelope too.

Worker fixtures, 90 s, gap (− = behind):

| | behind RAZOR | behind APEX 0.94 | demand mismatches (RAZOR) |
|---|---|---|---|
| baseline | −24.2 | −22.8 | 3488 / 4749 |
| `unifiedLane` | −41.7 | −22.8 | 3222 |
| `capEnvelope` | −51.2 | −51.2 | 2868 |
| `freeThrust` | −51.0 | −60.6 | 0 |
| all three | −65.3 | −46.1 | 0 |

None of them improves on the baseline, so none went to the field bench.

The loss behind RAZOR comes from one corner (40–45 s). With `capEnvelope`, TEMPEST arrives 14–16 m behind instead of
22–25 m. It then exits 3–5 m/s slower, in RAZOR's wake, 5–7 m to the side, under traction cuts. The options do what
they say: they put the car closer. Being closer costs more on the exit than it gains, because the rollout does not
price lost exit grip in wake. Corner exits in wake (Step 4) come before these options can be judged.

**The gap alone misjudges these options.** Over 180 s, lap times for both cars (worker, zero lag):

| | TEMPEST laps | RAZOR laps | first line, TEMPEST / RAZOR | gap |
|---|---|---|---|---|
| baseline | 53.58, 53.67 | 53.58, 53.55 | 69.70 / 69.15 s | −34.7 m |
| `freeThrust` | 53.60, 53.22 | 52.94, 52.97 | 69.83 / 68.69 s | −137.5 m |

TEMPEST close behind costs RAZOR about 0.6 s a lap; once TEMPEST drops back on lap 1, RAZOR runs free. TEMPEST's own
time against a solo reference (24 sectors, best of a 240 s solo run: laps 52.93, 52.99, 53.20) is the cleaner measure:
lost 3.38 s (baseline), 3.53 s (`capEnvelope`), 3.13 s (`freeThrust`), 3.10 s (all three), of which 1.74, 2.32, 0.84
and 1.43 s in sectors run in wake. Single runs; the worst sectors are the same in all four (20, 21, 0, 12).

### Corner exits (Step 4, measured)

Throttle cuts are applied in order: grip share (cap), traction (cap: combined slip `hypot(10.5κ, 8.6 tan α)` against
about 2.1, falling at 10·excess + 1 per second, recovering at 2.5/s), slip protection (multiplier: lateral slip over
2.15, or the rear looser than the front), stability (multiplier). A rear slide can be cut by three layers at once. The
game's own TC (`setup.tc` 3) acts gently above κ 0.113. On exits behind RAZOR (pedal-seconds over 90 s): traction
spin 1.67, slip 1.11, stability 0.96, traction lateral 0.66, both 0.31; two or more layers cut together for 4.0 s. In
clean air spin is 2.38: wheelspin dominates with or without wake.

Pedal-seconds are not lost time. A predictive traction cap (bisect the pedal on the game's own `Vehicle` stepped
0.12 s ahead) cut more (7.22 against 5.39) and gave the same solo laps (52.94, 53.03, 53.22 against 52.93, 52.99,
53.20). Traction control is not the clean-air bottleneck, so the change was not kept. The exit loss is in wake, which
points at the planner (follow closely or not) rather than the limiter.

### Beside-lane timing (Step 3, opt-in)

The beside lane reads the rival's forecast lateral at the time the car reaches each point. It used x / v0 (present
speed held, cut at 4.4 s), which is too early wherever the car brakes. Against the rollout's own drive time at the end
of the hold, 90 s behind RAZOR (native): held speed p50 1.16 s, p90 5.41 s, max 7.38 s off. `besideTime: true` (line
profile limited by the drive from the present speed) halves the tail but stays early (mean −0.72 s: the drive is capped
behind the rival). `besideTime: 'drive'` places the lane once, drives it, and places it again on the drive's times:
p50 0.36 s, p90 1.31 s. Update cost is unchanged (p99 1.55 ms). Behaviour over 180 s duels is inconclusive (1–2
attacks a run; APEX −60.9 → −60.1 m, RAZOR −34.7 → −92.3 m on one slow lap). Off by default until a field run.

### The rolling start (measured, nothing kept)

Of the places lost on the field bench, 39 of 68 go within 20 s of the green. Place at green + 10 s, 12 races paired by
seed (two TEMPEST cars each), is cheap and less noisy than the finish: base 4.08. By grid slot the loss sits on the car
that starts a few metres behind its own teammate (slots 3 and 5: 6.0 and 6.75 at green + 10 s, against RAZOR 4.5 /
5.0 and Spearhead 3.5 / 6.0 from the same slots); the other car matches them. Traced case (Alpine, seed 8, slot 3):
the plan changes six or more times in 3 s (lane −6, −3, line, −1.5, beside +, −4.5 m). Each start join is C2 with the
committed path but can reverse its curvature within a few metres. The jerk-limited steering keeps turning on the old
curvature: heading error 0.25 rad, 8 m off the path, a rear slide, the slip and stability layers lifting for 2 s. The
committed path then carries curvature 0.01 at the car, and every candidate's lateral-jerk speed limit dips to about
40 m/s while it unwinds, against about 52 m/s for the cars around it.

Measured and rejected (green + 10 s place; field place / incident points where run):

| Variant | Start place | Field |
|---|---|---|
| Base | 4.08 | 5.04 / 1.0 |
| `startLine` (no planner for the first seconds) | 3.58 | 4.88, damage 7.5 % (teammate and side merges) |
| Beside lane on the smoothed outer envelope of the rival's track (0.5 / 1 s) | 4.00 / 3.96 | – |
| Side guard only on overlapping cars ahead (margin 1.5 → 0.3 m) | 4.13 | – |
| Start join sized to the steering jerk (65 / 100 m/s³) | 4.13 / 4.17 | 5.08 / 3.7 |
| Plan caps, traction governor or stability lift off; follow-first contact window; direct line | no gain | – |

The join sizing fixes the traced case (63 against 48 m/s at green + 6 s, path error 3 against 8 m) but longer joins
make every lateral move slower and contacts rose. Also measured without gain at the start: gearbox, forecast acceleration, change length and
share, hold margin, wake envelope. The start is a plan-stability problem in a dense pack:
the next lever is committing to one side through the first corners rather than re-choosing every 0.1 s.

With the line hold (field 4.29 on seeds 10–12) a second start mechanism showed up: a lane change committed during the
formation lap (about 30 m/s) is kept on replan at that length, and its curvature caps the lane at about 34 m/s while the
field accelerates. Sizing changes for the speed reached through them (iterated drive acceleration) fixes that car but
lengthens every change: field 5.63 (all edges, kept short transitions dropped), 5.46 (kept transitions kept), 5.25 (start
edge only). Rejected.

### Rival acceleration in the forecast (measured, kept)

The pass fixture against RAZOR never slowed it: RAZOR keeps a base margin and rescales `options.margin` from it every
update, so every fixture run "at 0.94" was at full pace (the bench now sets both). Slowed for real, RAZOR at margin
0.88 laps about 2 s slower than TEMPEST alone, and TEMPEST still sat behind it for 240 s without a pass. With it ahead,
TEMPEST lifted on the straights under following caps 25–40 m back, and the racing-line candidate was priced with
contact (4–11) while the controller had none. The forecast was short of the rival: +5 m at 3 s on average, +8 m
while the rival accelerated. Cause: its drive came from `gearAt(v)`, which starts at the top gear and only shifts down
under 3450 rpm, so an accelerating car was read lugging its tallest gear: 2.7 against 6 m/s² at 50 m/s. The game's box
upshifts at 7450 rpm. The forecast now starts from the gear the car is in and carries the box forward (hysteresis).
The bias while accelerating went from +4.8 to −0.5 m at 3 s (braking: still about +5 m, the rival brakes later than
forecast). Field (seeds 7–9 / 10–12): 4.50 / 4.29 → **3.58 / 3.75**, passes 1.3 → 2.0–2.2 a car-race, damage
about 2 %. `forecastGear: false` restores the old reading.

Measured alongside and left opt-in:

- `lineFrame`: positions in the racing line's frame. Harbor's centre line kinks at s ≈ 862 (radius 6.4 m, under the
  8.2 m half width) where the line runs 6–8 m inside; there the nearest centre point jumps, s by 6–9 m and d by up to
  20 m between frames, and every lateral rate with it. In the line frame the forecast spread at 1.5 s fell from
  −3.7…6.9 to −0.2…4.9 m (p10…p90). Field 3.75 (equal), damage 3.8 %: only one corner of one track changes.
- `paceLearn`: each rival's speed against our line, per 20 m, smoothed over laps, as the pace its forecast fades to.
  Field 4.54 against 3.75: worse.

### Braking into a slide behind a car (measured, nothing kept)

Pass fixture against RAZOR at margin 0.88: TEMPEST spun at 52 s, 7.6 % damage. Holding the racing line at 69 m/s in
a fast corner (sideslip 0.13 rad, what the model expects there), 25 m behind and closing 4 m/s, the following cap
arrived late and asked for full brake mid-corner. The grip share let 0.54…0.88 of it through as the lateral demand
eased; the fronts saturated (slip 2.3 against the 2.15 limit) and the rear let go as the brake came off (rear slip
1.4 → 3.4) while the wake rose 0.2 → 0.6. Two controller fixes both removed the spin in the fixture and both lost
on the field (seeds 7–9, base 3.58), so both stay opt-in, default off:

- `wakeShare`: the grip share from the lateral grip left in the wake (the wake envelope's downforce loss). 4.42.
- `frontRelease`: the slip protection that eases the brake for a saturated rear also eases it for the front. 4.08.

The late cap is the root: the racing line is held under the line-hold gate at a contact cost of 2 and the cap only
bites once the forecast puts the rival's lateral path back on ours.

- `capZone`: the rollout's following cap stopped the car at `Ls + 0.8 + 0.25 σs`, inside the contact zone
  (`Ls + 0.5 σs`) once σs passes 3.2 m (about 2 s out), so a car the cap keeps in line was charged contact as well
  and the racing line carried that cost. Following to the zone's edge instead: fewer incidents (1.1–1.4 against
  about 1.4) but field 4.08 / 3.96 against 3.58 / 3.75 (seeds 7–9 / 10–12). Off.

### Off the green (measured)

43 of 57 race places TEMPEST lost (seeds 7–9) went in the first 60 s. In the first 4 s after the green it runs
2–4 m/s slower than RAZOR and Spearhead (37.3 against 40.8 m/s at 2 s) at the same lateral load (|ay| 3.9 against
4.0): it asks for more throttle (0.89) but sends 0.73 against RAZOR's 0.82. Its own layers take the difference:
stability 0.077 (almost all the yaw-rate term, active 30 % of the time), traction 0.067 (mostly wheelspin, where the
game's traction control already acts) and slip 0.013. Field noise: the base scores 3.58 / 3.75 / 3.71 on seeds
7–9 / 10–12 / 13–15, so a change needs more than ±0.15 to show. Tried, all off by default:

- `joinAccel` (lattice): size the start join at the speed reached at its end, not the speed at the green. 4.96.
- `overRel` (control): yaw-rate tolerance growing with the yaw asked for. 4.54, more incidents.
- `overSteerRef` (control): the steady-state yaw of the lock last sent is a reference too, so the yaw the car
  carries behind the jerk-limited steering through an S is not read as a slide. Places lost 2.6 → 2.1 per race
  and first-minute losses 43 → 31, but fewer passes: 3.67 / 3.75 / 3.71 (equal), damage 2.9–3.5 % (from 2.2–2.8).
- Governor on lateral slip only, wheelspin left to the game's traction control (setup 3: from kappa 0.113, mild):
  4.08, first-minute losses 52. TEMPEST's own wheelspin limit earns its keep. Not kept in the code.
- Drive inside the friction circle in the rollout (drive x sqrt(1 - u^2), u the lateral grip in use on the lane):
  the S-join to the line off the green was priced the fastest plan (4.7 s against 5.0–5.3) while the car was cut
  back to 0.73 throttle on it. 4.25, first-minute losses 46. Not kept in the code.

Pattern over this round: each change that corrects one measured error moves the field 0.3–1.4 places the wrong way,
while the base is stable across seed sets. The planner's margins were set together with today's errors; a correction
alone unbalances them (as with the forecast fixes in 2026-10-08). The next attempt at the start should be judged with
the margins it interacts with (routeGate, holdMargin, contact weights) re-set for it, not alone.

## 7. Open work

- Delay-aware steering under one frame of lag (braking in wake oscillates; see the worker path)
- Price dirty-air exit loss in the planner: following close against another route
- `besideTime: 'drive'` on the field bench
- 4× time scale through the worker path: the delayed replies span several physics steps and the car still loses control

- Rain damage (12.7 %) and rain pace
- Early braking behind slowing cars on straights
- Start and first-lap routing
- Defence: passed 2.4 times a race, against 0.5 for RAZOR
- Duels against RAZOR (`scripts/bench/tempest-duel.mjs`): 0–1 wins of 8, about −1.1 s. Following RAZOR loses time to failed attacks into slow corners and to corners taken in heavy wake on lap 1
- Own strategist
- Other tracks

### Routing through other-class traffic (default: `zoneFollow: "traffic"`, `gateProgress: "traffic"`)

Fixture `scripts/bench/tempest-traffic.mjs --scene gt3`: TEMPEST (LMDh) at the back of a rolling single file behind
three RAZOR GT3s, 80 s on Harbor. Before: 1/3 cleared, 53 s to clear the one it passed, laggy routes that left late
and wide. Two causes:

- The line gate held the racing line unless a lane completed a same-class pass inside the 3.4 s horizon. GT3 traffic
  never counts as a pass, so the car only left the line ahead of a heavy (>6 m/s closing) impact: late, and out at
  the edge. `gateProgress` lets a lane through the gate when it clears or draws alongside a car ahead and beats the
  line on time plus contact (by 0.05 s).
- Inside the contact zone the rollout had no following cap, so the line run drove into the car ahead on paper and
  booked a squeeze-pass and a large contact cost for what the controller's nose cap really does: follow.
  `zoneFollow` applies the nose cap in the rollout (clearance under 0.15 m, 0.6 m for hazards).

Both on: 3/3 cleared at 20.5 s each, progress 2787 → 3007 m (solo 3507), contacts 55 → 61. Applied to every car
(`true`) the same-class field went 3.58 → 3.78 (seeds 7–9, noise ±0.15), so the default (`"traffic"`) applies them to
other-class cars only (not teammates or hazards): a same-class race is bit-identical to before (A/B on Harbor seed 7).

Open: a slow, weaving same-class car is still followed rather than passed (`--scene slow`). The forecast fades the
rival's pace ratio (0.82 at the time) back to ours within ~2.5 s and brakes it ~5 m late, so every rollout sees it
escape through the braking zone; the beside lane rides the rival's weave (≈1 s slower geometry). Measured without
effect: `roadCap` (follow the rival's road progress, not its path speed), wider `besideClear` (0.8, 1.3), a partial
progress value for being part-way through a pass.
