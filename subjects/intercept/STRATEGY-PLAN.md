# INTERCEPT race strategist: build plan (2026-10-17)

Goal: an INTERCEPT strategist that reads the whole race, not only its own car, and chooses pit calls, compounds,
fuel and a pace mode to maximise **finishing position**. It must beat the current `InterceptStrategist`
(`src/strategy.js`) in full races with the same INTERCEPT driver, on paired seeds.

Inputs it must understand (user list, 2026-10-17):

1. everyone's tyre usage
2. future weather
3. rivals' predicted pit stops
4. time a future stop of ours will cost
5. where we rejoin after the stop
6. pace fade from tyre usage
7. pace needed to take or hold a position

## 0. Ground rules

- **Public information only at decision time:** timing, gaps, every car's compound and laps on the set, stops made,
  race control, our own telemetry, and the radar (`game/core/road-outlook.js`, the game's team weather radar).
  Never rivals' true wear, fuel or strategist state, and never the seeded future weather beyond the radar.
  Hidden truth is allowed **only as training labels**.
- **Hard rules stay in code, never in a model:** mandatory stops and swaps, the fuel minimum, the pit-lane-closed
  rule under caution, and human box requests and overrides (priority unchanged).
- **One measured step at a time.** Every model is checked against a baseline on held-out races before anything
  uses it. The planner goes into the game only after it wins the race benchmark.
- **Runs stay inside the CPU budget:** ≤ 6–8 simulations, BelowNormal. Full races cost 12–15 min of wall time each.
- **Plug-in point:** `class InterceptStrategist2 extends InterceptStrategist`, installed by
  `installInterceptStrategy` behind a `config.json` flag (default off until it wins). The current strategist stays
  as the fallback.

## 1. Architecture

```
 race state (public) ──► estimators ───────────────► lap-level race simulator ──► planner ──► pit call + pace mode
   timing, compounds,     M1 rival tyre wear           every car: pace, tyres,       candidate plans x       box / compound /
   laps on set, stops,    M3 rival pit hazard          fuel, stops, traffic,         Monte Carlo samples     fuel / swap,
   our telemetry, radar   M6 pace fade (all cars)      weather samples (M2),         score = expected        push / normal / save
                          M2 radar + error band        our stop (M4), rejoin (M5)    finishing place         (-> Resources.allowance)
```

| # | Input | Component | Type | Baseline it must beat |
|---|---|---|---|---|
| 1 | Everyone's tyre usage | **M1 wear estimator.** Reads compound, laps on the set, track, class, and the car's lap-time drop vs its stint best. Outputs estimated max wear for each car. | small NN | laps × learned wear per lap |
| 2 | Future weather | **M2.** `RoadOutlook.forecast()` plus a measured error band per horizon, which replaces the fixed 3 s `WEATHER_MARGIN_S`. | measured table | the current fixed margin |
| 3 | Rivals' pit stops | **M3 pit hazard.** Per rival, the probability of boxing this lap, next lap, ... From: stint laps, estimated fuel laps left (laps since the stop × calibrated burn, 60 L tank), stops and swaps owed, M1 wear, pace drop, laps left, weather call vs their tyre family, caution, and the gap to the cars around them (undercut threat). | small NN | fuel-window heuristic |
| 4 | Our stop's time cost | **M4.** `serviceTime()` + the INTERCEPT lane loss per track + out-lap loss on cold tyres + the caution discount, plus a learned residual for release holds and lane traffic. | formula + residual | formula alone |
| 5 | Where we rejoin | **M5.** Simulate every car forward to our pit exit, then apply a learned stuck-in-traffic cost: time lost per lap behind a car with pace gap Δ on this track. | simulation + fitted curve | none (new) |
| 6 | Pace fade | **M6 pace model.** Lap time vs the car's reference, from compound, wear per wheel, core temperatures, fuel mass, line wetness, laps into the stint, class and track. Runs for every car, with M1 standing in for wear on rivals. | small NN | `wearLoss` + `WEAR_K` + fade factor |
| 7 | Pace needed for a position | **Planner output.** Gap ÷ laps left against the predicted pace difference. It drives undercut / cover / extend calls and the push-or-save pace mode. | planner | none (new) |

The planner runs at the existing decision point (pit approach, once per lap) and on events: caution, a weather call,
a rival's stop. Candidate plans:

- box in k laps, k = 0 … K (K = the fuel or tyre limit);
- compound;
- fuel to the end, or to the next window;
- pace mode.

Each candidate gets N Monte Carlo samples of rival stops (M3) and weather (M2 band). Score: expected finishing place;
tie-break by expected gap, then race time. Budget: ≤ 50 ms per decision, off the control path.

Every call carries a readable reason for the AI debug view, e.g. `UNDERCUT APX#7 +1.3 s` or `COVER SLC#4`.

The models are trained in Python and exported to JSON. Inference is plain JS: the game gets no torch dependency.

## 2. Phases and gates

### P0. Logging and the strategy benchmark (day 1–2)

- `tools/strategy-log.mjs`: headless full races on `game/core` (the same race loop and pit autopilot as the browser).
  - Fields: the standard team field, with INTERCEPT teams on the current strategist; the rivals keep their own
    strategists.
  - Formats: CLASSIC 12 and MARATHON 20.
  - Conditions: dry, Changeable and wet weather; caution on.
  - Tracks: harbor-ring, solenne, alpine, desert, nurburgring.
  - Both classes.
- **One row per car per lap** (at the line and at each decision point), with three groups of fields:
  - **public:** position, gap ahead and behind, last lap, compound, laps on the set, stops and swaps made, pit lap
    flags, caution phase, line wetness now, radar forecast summary;
  - **own-car telemetry:** fuel, per-wheel wear and core temperatures;
  - **hidden labels:** true wear, true fuel, the future stop lap and what was fitted, final place and race time.
- Every stop is logged: lap, service content, time in the lane, release hold, rejoin position, gaps after the stop.
- `tools/strategy-bench.mjs`: A/B of two strategists with the same drivers and paired seeds.
  - Metrics: finishing place, race time, gap to the class winner, stops, illegal outcomes.
  - Breakdown: by condition (dry / changeable / wet / caution).
  - Seed sets: 1–10 for selection, 11–20 to confirm, 101+ fresh.
- **Gate P0:**
  - Logs reproduce the races exactly: deterministic, same seed gives the same rows.
  - A first dataset of ≥ 60 races, about 3 h at 6 parallel.
  - A current-strategist benchmark is on file.

### P1. Estimators (day 2–4)

Python venv, the same style as `subjects/slipstream`. Splits are by race seed: train on 1–40, validate on 41–60.

- **M6 pace:**
  - Metric: lap-time MAE overall and per wear bucket, with the cliff (> 0.6) reported separately.
  - Gate: beats the analytic fade on held-out races, including after the cliff.
- **M1 rival wear:**
  - Metric: wear MAE from public inputs.
  - Gate: beats laps × wear per lap.
- **M3 pit hazard:**
  - Metrics: log-loss; share of stops predicted within ±1 lap, 3 laps ahead.
  - Gate: beats the fuel-window heuristic.
- **M2 radar error:** measured as realised line wetness minus predicted, by horizon (1–20 min).
  Output: the error band table.
- **M4 residual and M5 traffic cost:** fitted from the stop and traffic rows.

### P2. Lap-level race simulator (day 4–6)

`src/race-model.js`, pure JS with no physics.

- **State per car:** race time, lap, compound, wear (true for us, M1 for rivals), fuel, stops owed.
- **Each simulated lap:** lap time from M6, the stuck-in-traffic cost when within 1 s behind a slower car, and stops
  from M3 samples (rivals) or the plan (us), costed with M4.
- **Validation on logged races:** start from the real state at lap k and predict the running order 3 and 5 laps
  later, and at the finish.
- **Gate P2:**
  - rejoin position within ±1 place in ≥ 80% of logged stops;
  - order 5 laps ahead more accurate than "order unchanged + scheduled stops".

### P3. Planner and integration (day 6–8)

- `InterceptStrategist2`: candidate plans × Monte Carlo through the race simulator.
  - The hard rules are applied before scoring.
  - Pace mode goes to `Resources.allowance` (push = full ceiling, save = current fade-limited value).
- Unit checks in `tools/check.mjs`:
  - a mandatory stop is never missed and fuel never runs out;
  - a human request still wins;
  - each decision takes ≤ 50 ms;
  - a known undercut scenario is taken and a hopeless one is refused.

### P4. Benchmark decision (day 8–10)

- `strategy-bench` A/B, with paired seeds against the current strategist, across the full matrix.
- **Gate:**
  - mean finishing place better, with the 90% CI excluding 0;
  - no condition worse beyond noise;
  - zero illegal outcomes.
- Then confirm on seeds 11–20 and on fresh seeds before the flag is turned on. Deploy only on the user's call.

### P5. Optional decision net (later)

Only if the planner is too slow or too noisy: distil the planner's choices into a small policy net, then optionally
fine-tune it with RL inside the lap-level simulator. Validate in real races as in P4.

## 3. Day 1 checklist

1. Read the rival strategists that run in the field and list what each exposes publicly:
   `game/core/strategy.js` and the `subjects/*/src/strategy.js` that are installed (APEX, TEMPEST, ...).
2. Write `tools/strategy-log.mjs` (row schema above, public / hidden split) and smoke-test one 12-lap Harbor race.
   Check that two runs of the same seed give identical rows.
3. Write `tools/strategy-bench.mjs` and run the current-strategist baseline smoke: 2 tracks × 2 seeds.
4. Queue the first dataset batch: 60 races, ≤ 6 parallel, BelowNormal, and log it in this file.
5. Start the P1 venv and the loaders while the batch runs.

## 4. Risks

- **Rivals are scripted strategists with seeded styles**, so M3 can fit them closely. That suits the game (they are
  the opponents) but can fail against human teams. Mitigation: hold out style seeds, and keep a heuristic floor.
- **Driving and strategy interact:** a pace mode changes lap times, and the logs only hold the current driver's
  behaviour. Mitigation: log `Resources.allowance`, and run a few push/save-forced races for M6 coverage.
- **Full races are slow.** Mitigation: the lap-level simulator carries the search; real races are used only for data
  and final decisions.
- **Weather and caution races are rarer and noisier.** They are reported separately so a dry-race gain cannot hide
  a wet regression.
