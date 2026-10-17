# INTERCEPT race strategist: build plan (2026-10-17, rev 2)

Goal: an INTERCEPT strategist that reads the whole race and chooses pit calls, compounds, fuel and a pace mode to
maximise **finishing position**. It must beat the current `InterceptStrategist` (`src/strategy.js`) in full races
with the same INTERCEPT driver, on paired seeds.

**User decisions, 2026-10-17:**
- **No neural network.**
- **Full information:** read everything the game knows, including rivals' true tyre wear and fuel, their
  strategists' own plans, and the seeded future weather. This deliberately overrides the public-information rule in
  `INTERCEPT-DESIGN.md` §10. It applies to strategy only; the driver stays as it is.

Inputs (user list) and how each is read:

| # | Input | Source (exact, no estimation) |
|---|---|---|
| 1 | Everyone's tyre usage | Every car's `wheels[].tyre`: wear, core temperature and compound, read directly from the race object. |
| 2 | Future weather | The race's own seeded `Weather` (`weather.js`), stepped ahead to the flag. `RoadOutlook` already does this for 1200 s; extend the horizon to the full race. The road water uses the outlook's learned traffic-drying rate; its residual error is measured in P1. |
| 3 | Rivals' pit stops | Each rival entry's own strategist (`race.entries[i].strategist`), queried on a side-effect-free copy: its stint plan (`planStint`), fuel limit, stops owed and weather call. Run on projected future states, this gives the lap each rival will box and what it fits. |
| 4 | Our stop's time cost | `serviceTime()` + INTERCEPT's per-track lane loss + out-lap loss + caution discount + the live state of the pit lane (cars in the lane, release holds). |
| 5 | Where we rejoin | Lap-level projection of every car (true state + item 3) to our pit-exit time, plus a measured stuck-in-traffic cost. |
| 6 | Pace fade | Per car, an online fit of its own lap times against its true wear, fuel and temperatures. It starts from the game's tyre model (`wearLoss`) and calibrates per car, per compound, as laps come in. Formula, not a network. |
| 7 | Pace needed for a position | Planner output: gap ÷ laps left against the projected pace difference. It drives undercut / cover / extend calls and push / normal / save. |

## 0. Ground rules

- **Hard rules stay in code:** mandatory stops and swaps, the fuel minimum, the pit-lane-closed rule under caution,
  and human box requests and overrides (priority unchanged).
- **Strategy only reads the race; it never writes to other cars or to the weather.** Rival strategists are queried
  on copies, so asking a question can never change their decisions.
- **Deterministic:** the same seed gives the same decisions. This is checked in P0.
- **One measured step at a time.** The planner goes into the game only after it wins the race benchmark.
- **CPU budget:** ≤ 6–8 simulations, BelowNormal. Full races take 12–15 min of wall time each.
- **Plug-in point:** `class InterceptStrategist2 extends InterceptStrategist`, installed by
  `installInterceptStrategy`. It keeps a reference to the race so it can read the whole field. It sits behind a
  `config.json` flag (default off until it wins), with the current strategist as the fallback.

## 1. Architecture

```
 full race state ──► field projector (lap-level, pure JS) ──────────────────────► planner ────────────────► pit call + pace mode
   all cars: wear,     every car: lap time (item 6), tyres, fuel, stops      candidate plans for us        box / compound /
   fuel, temps,        from its own strategist (item 3), traffic cost (5)    x weather to the flag (2)     fuel / swap,
   positions, gaps,    our stop: item 4                                      score = projected place       push / normal / save
   strategists,                                                                                            (-> Resources.allowance)
   seeded weather
```

- **Field projector** (`src/race-model.js`). State per car: race time, lap, compound, wear, fuel, stops and swaps
  owed. Each projected lap:
  - lap time from the per-car fade fit, adjusted for line wetness from the forecast;
  - the stuck-in-traffic cost when within 1 s behind a slower car;
  - stops when that car's strategist would call them (item 3), costed with item 4.
- **Planner.** It runs at the pit-approach decision point and on events (caution, a rival's stop, a weather change).
  - Candidates: box in k laps (k = 0 … the fuel or tyre limit) × compound × fuel to the end / to the next window ×
    pace mode.
  - Everything is known, so each candidate needs **one deterministic projection**, not Monte Carlo.
  - Score: projected finishing place, tie-break by gap, then race time.
  - Budget: ≤ 50 ms per decision.
  - Every call carries a readable reason for the AI debug view: `UNDERCUT APX#7 +1.3 s`, `COVER SLC#4`,
    `RAIN IN 2 LAPS -> INTER`.
- **Pace mode** goes to `Resources.allowance`:
  - push when the projection says pace wins or protects a place;
  - save when the place is safe and the tyres must last.

## 2. Phases and gates

### P0. Logging and the strategy benchmark (day 1)

- `tools/strategy-log.mjs`: headless full races on `game/core` (the same race loop and pit autopilot as the
  browser).
  - Fields: the standard team field, with INTERCEPT teams on the current strategist; rivals keep their own
    strategists.
  - Formats: CLASSIC 12 and MARATHON 20.
  - Conditions: dry, Changeable and wet; caution on.
  - Tracks: harbor-ring, solenne, alpine, desert, nurburgring; both classes.
  - One row per car per lap (position, gaps, lap time, compound, laps on set, wear, fuel, temps, stops, caution,
    line wetness) plus every stop: lap, service, lane time, release hold, rejoin position.
- `tools/strategy-bench.mjs`: A/B of two strategists with the same drivers and paired seeds.
  - Metrics: finishing place, race time, gap to the class winner, stops, illegal outcomes.
  - Breakdown: dry / changeable / wet / caution.
  - Seed sets: 1–10 for selection, 11–20 to confirm, 101+ fresh.
- **Gate:**
  - same seed gives identical logs;
  - baseline benchmark of the current strategist on file;
  - first dataset of about 40 races, for validating the projector and fitting the traffic cost.

### P1. Field projector (day 2–3)

- Read the true state, query rival strategists on copies, project every car, extend the weather horizon to the
  flag, and fit the per-car fade online.
- **Validation on logged races:** from the real state at lap k, predict:
  - each rival's next stop lap;
  - the running order 3 and 5 laps later, and at the finish;
  - our rejoin position for each logged stop.
- **Gate:**
  - rival stop lap exact in ≥ 90% of stops (they are deterministic strategists, so misses point at bugs or at
    caution);
  - rejoin position within ±1 place in ≥ 90% of stops;
  - line-wetness forecast error measured by horizon.

### P2. Planner and integration (day 3–4)

- `InterceptStrategist2`: candidates × projection, hard rules applied before scoring, pace mode to `Resources`.
- Unit checks in `tools/check.mjs`:
  - a mandatory stop is never missed and fuel never runs out;
  - a human request still wins;
  - each decision takes ≤ 50 ms;
  - a known undercut is taken and a hopeless one is refused;
  - an incoming shower is met with the right tyre;
  - querying rivals never changes their decisions (a race with and without INTERCEPT2 querying is identical for
    every rival up to INTERCEPT's own effect on the track).

### P3. Benchmark decision (day 4–6)

- `strategy-bench` A/B against the current strategist across the full matrix, paired seeds.
- **Gate:**
  - mean finishing place better, with the 90% CI excluding 0;
  - no condition worse beyond noise;
  - zero illegal outcomes.
- Then confirm on seeds 11–20 and on fresh seeds. Deploy (flag on) only on the user's call.

## 3. Day 1 checklist

1. List the strategist class each rival in the field runs (`game/core/strategy.js`, `subjects/*/src/strategy.js`)
   and how to query each one without side effects. Each stateful method (`decide`, `planStint`, memo, `plan`,
   `boxThisLap`) runs only on a copy.
2. Write `tools/strategy-log.mjs` and smoke-test one 12-lap Harbor race; run the same seed twice and diff the logs.
3. Write `tools/strategy-bench.mjs` and run the current-strategist baseline smoke: 2 tracks × 2 seeds.
4. Queue the first dataset batch: about 40 races, ≤ 6 parallel, BelowNormal. Start the projector while it runs.

## 4. Risks

- **Caution periods** come from incidents, which aren't scheduled, so they can't be read ahead. The planner
  re-plans when caution starts; caution races are reported separately.
- **Rival strategists react to us**, for example through undercut styles or traffic. The projector re-queries them
  every lap, and P1 measures how often their reaction breaks the forecast.
- **Driving and strategy interact:** pace mode changes lap times. Log `Resources.allowance`, and refit fade per mode.
- **Fairness:** with full information, strategy comparisons against other AIs are no longer like-for-like. This is
  the user's choice; benchmark reports label INTERCEPT's strategist as full-information.
