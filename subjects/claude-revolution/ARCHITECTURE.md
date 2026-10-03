# CLAUDE REVOLUTION: racecraft-first driver for GTP and GT3

Status: design (no driver code yet). Author: Claude (Anthropic), for the Phantom Endurance game.

CLAUDE REVOLUTION is built around one idea: **a race is won in the corners where
you meet other cars, not in free air.** Pace and tyre life are the foundation it
needs to get there. The architecture spends its effort on attacking, defending and
racing side by side, and keeps the solo-lap machinery cheap and predictable.

## Targets (acceptance)

| Metric | GTP (lmdh) | GT3 (gt) |
|---|---|---|
| Best racing lap, Harbor Ring | < 55.0 s | < 64.0 s |
| Fade, best → slowest flying lap of a stint before the in-lap | ≤ 4.0 s | ≤ 4.0 s |
| Stint length | the fuel stint (no extra tyre stop) | same |
| Incidents, 12-lap multiclass race | ≤ 4x | ≤ 4x |
| Overtake success vs equal-pace Solstice / Gemini v4 (duel bench) | > 50 % within 3 laps | same |
| Defence vs a car 0.5 s/lap faster | holds ≥ 2 laps, no contact | same |

These hold on all four circuits, not just Harbor; Harbor is the reference.

### Baseline at design time (solo, Harbor, soft start)

| AI | Class | Best lap | Stint |
|---|---|---|---|
| Gemini v4 | GT3 | 66.7 | 5-lap stints, ~1 s fade |
| Gemini v4 | GTP | 59.6 | 6-lap stints, ~1 s fade |
| Solstice | GT3 | 63.4 | stops every 3 laps |
| Solstice | GTP | 53.5 | 6x incidents; stops after 2 laps, then 57–60 s and fading |

The current best AIs are either fast or sustainable, never both. REVOLUTION's
pace target sits between the two because of the fade and stint constraints.

## Design principles

1. **Own the tyre budget.** On this tyre model, sliding pays for lap time (lateral force
   peaks at 15–19° slip) but costs wear. REVOLUTION does not hunt for the fastest lap. It
   chooses the fastest lap that leaves at most 4 s of fade at the planned stop.
2. **Plan combat around corners, not around the next 2 seconds.** Overtakes are set up
   one or two corners ahead: a cutback to win the exit, or a tow onto a straight that ends
   in a heavy braking zone. A short sampling horizon cannot see that, so the corner map
   provides the long horizon.
3. **Model the rival, not a box.** Each opponent gets a learnt per-corner profile: where
   it brakes, its apex speed, which line it takes, and whether it covers the inside. A
   pass is judged against what that car will actually do.
4. **Many cheap candidates, one expensive check.** Trajectory candidates are scored with
   a point-mass g-g-v model, which is fast enough for 60+ candidates at 20 Hz. Only the
   chosen one is validated with a private copy of the game `Vehicle`.
5. **Race clean by the rules the stewards enforce.** That means:
   - one defensive move per straight, and no moves under braking;
   - leave a car's width once overlapped;
   - predictable lines when being lapped in multiclass.

   Expected incident points and damage are a cost in every decision.

## Modules (`subjects/claude-revolution/src/`)

| Module | Job |
|---|---|
| `corners.js` | Segments the track into corners. For each one: braking zone, turn-in, apex, exit, direction, minimum speed, length of the following straight, and whether the next corner reverses. From these it builds the **opportunity map**: how good each corner is for a dive, a cutback or a pass around the outside. |
| `lines.js` | A **family of lines** per car class. The racing line comes from whole-lap minimum-time optimisation with a quasi-steady-state lap sim. Around it sit an inside-defence line, an outside line and a late-apex cutback line, each with its own speed profile. Lane changes are smooth splines between members of the family. |
| `envelope.js` | A g-g-v envelope (lateral, braking and traction limits against speed and downforce). It is seeded from `car-specs` and the live tyre state (compound, wear, temperature, wetness), then refined online from measured accelerations. Iterative learning adjusts each corner's entry speed lap by lap from the observed slip margin. |
| `tyre-budget.js` | The stint planner. From the fuel-stint length and a learnt wear-per-slip-energy rate, it chooses an aggression λ (a slip ceiling and corner-speed scale) that lands fade at ≤ 4 s by the in-lap. λ rises when the stint is short or on the last stint, and falls if wear runs ahead of plan. |
| `tracker.js` | Low-level control. Steering: feedforward from path curvature and the understeer gradient, plus yaw-rate and sideslip feedback and a countersteer term. Longitudinal: feedforward from the envelope, plus a traction and ABS-aware brake release. The game gearbox stays automatic. |
| `rivals.js` | A per-opponent observer: a Kalman track of s, lateral, speed and acceleration from public state only, plus a learnt corner profile (braking point, apex speed, line choice, defend tendency). Its predictions follow that corner profile rather than assuming constant velocity. |
| `planner.js` | Batch evaluation at 20 Hz of a 2.5 s horizon. Candidates are line-family lane changes crossed with braking offsets. They are scored on progress, rival occupancy from the `rivals` predictions, track limits, tyre energy (λ) and etiquette. The winner gets one full-`Vehicle` rollout check. |
| `combat.js` | The tactical state machine: FOLLOW → SETUP → ATTACK (dive / cutback / outside / draft) → ALONGSIDE → DEFEND (cover / hold) → YIELD (multiclass) → RECOVER. A move is committed only when its expected value is positive: positions gained minus P(contact) × (incident points + damage + time). A dive is feasible when the car can be at least half alongside at the rival's predicted turn-in, using its own braking distance. |
| `etiquette.js` | iRacing conduct as hard constraints on `planner`. Multiclass rules: GTP picks the side the GT3 is not on, and GT3 holds a predictable line. |
| `driver.js` | Glue. It implements the game seat interface (`update(car, cars, dt, context)`, `reset(state)`, `debug()`), writes only `car.controls`, and handles takeover, pit release and the rolling-start handover. |

### Hybrid (GTP)
Deploy mode is chosen by the host today (`aiDeployMode`). REVOLUTION benefits from
asking for **attack** on the straight where a pass is set up, and **build** while
following before that. Proposal, which needs the user's OK because it changes the
host: an opt-in `car.intent = { deploy }` that `aiDeployMode` honours within the same
energy rules. All AIs could use it, and existing AIs are unaffected.

## Benchmarks (`subjects/claude-revolution/tools/`)

- `bench-pace.mjs`: solo stint on each track and class. Reports best lap, fade before
  the stop, stint length and incidents (the baseline table above came from this probe).
- `bench-duel.mjs`: REVOLUTION starts 0.6 s behind a rival (Solstice, Gemini v4 or itself)
  in the same class. Reports pass rate within 3 laps, laps to pass, contacts and incident
  points. It is also run with the roles reversed for defence.
- `bench-race.mjs`: a 12-lap multiclass race against the roster, with seeds rotated.
  Reports finishing position, incidents and stops.

Runs follow the machine budget: at most ~6 low-priority sims, each under 10 minutes.

## Milestones

1. **M1 Pace core**: corners, lines, envelope and tracker, reaching < 55 / < 64 solo on Harbor.
2. **M2 Tyre budget**: fade ≤ 4 s inside the fuel stint, on all tracks.
3. **M3 Traffic**: rivals and planner, with clean following and side by side through bends.
4. **M4 Combat**: EV-based attack and defence, opportunity map, cutbacks; the duel bench targets.
5. **M5 Multiclass and hybrid intent**: etiquette, plus the deploy-intent API (if approved).
6. **M6 Integration**: worker seat, roster entry (`claude-revolution`, short `CRV`), the AI lens debug view, and RESULTS.md.

## Boundaries

- Reads only public car state, which is what the worker seats receive, plus its own car.
  No access to other drivers' internals.
- Does not touch other AIs, the host simulation or the governor. The game gearbox and the pit
  autopilot stay host-owned.
