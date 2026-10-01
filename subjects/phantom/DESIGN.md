# PHANTOM — audit of the field and design of a distinct controller

## 1. Audit: what each rival assumes

| | Path geometry | Vehicle execution | Opponent occupancy | Tyre state |
|---|---|---|---|---|
| **Astra** | A precomputed racing line plus quintic-Hermite lateral offsets (`Trajectory`). Every candidate is "line + extra offset". | A quasi-steady `PerformanceModel` speed profile along the chosen path. A tracker is assumed to follow it. | `Perception` predicts rivals in (s, lateral), and `pathRisk`/`physicalContactCost` score clearance. A rule layer (racecraft policy, battle memory, attack windows) adds manoeuvres. | Implicit: a speed profile margin. There is no thermal state. |
| **NOVA** | Candidates are "deformations of the measured free-air line" inside a corridor `[qmin, qmax]`, with a topology choice (FREE_AIR / side). | A certified quasi-steady Bellman oracle for speed, and a coupled controller that tracks station-indexed q(s), v(s). | `NovaBeliefEngine` uses a 7-mode Bayesian intent posterior and emits space-time occupancy tubes O(s, q, t), driven by a racecraft phase machine. | `computeTyreScale` scales target speed by a grip factor from tyre telemetry, as a reactive derate. |
| **Gemini Supreme** | `GlobalTimeOptimalEngine` fits a multi-scale bump-basis curvature profile, with an analytical velocity solve on it. | An analytical quasi-steady car model: μ, aero and power drive forward/backward speed passes. | `GameTheoreticCombatEngine` morphs the corridor `[dmin(s), dmax(s)]` with scripted tactics (apex shield, divebomb, switchback, break-tow). | Wear and temperature widen entries and square off corners, as a heuristic shaping. |
| **VORTEX** | `TrackAtlas`/oracle builds a lateral line limited by a slope budget, and a multicorner planner picks from candidates. | A learned `VehicleEnvelope` feeds a trajectory optimiser, then a servo/allocator, with a safety kernel on top. | Filtered opponents feed occupancy prediction, then an engagement graph, then corridor *ownership* (who owns which lane). | `tyre-predictor` feeds the envelope estimate. |

**Shared assumptions, where all four fall short:**

- **Path first, speed second.** Every one of them treats the plan as a curve (a line, or a line plus an offset) with a speed profile laid on it. The speed profile comes from a quasi-steady (g-g) model. A downstream tracker is then trusted to realise it. The gap between model and plant is what shows up as T1 being "impossible", as exploitable slip, and as pace that fades.
- **Opponents as lanes.** Every one of them maps opponents into the (s, q) corridor frame: tubes, corridors, lane ownership, offset risk. Tactics are layered on top as named modes.
- **Tyres as a derate.** Tyre state is at best a reactive speed or grip scale. It is never a cost the plan pays when it chooses how to use the tyre.

## 2. PHANTOM's core representation

PHANTOM plans in **control space on the exact plant**. It has no path.

1. **Ghost tape as a value clock** (`ghost.js`). A lap the real plant physically drove is stored per metre: arrival time, speed and controls. The planner never tracks it. It only reads `clock(u)`, the ghost's time-to-reach station u, to value where a rollout ends. A brakeability envelope, built from the plant's measured straight-line decel, caps the terminal speed before the next apex. Any line that arrives earlier is better, whatever geometry produced it. This is why T1 is taken flat: nothing forbids it.
2. **Exact-plant shadow rollouts** (`plant.js`). Every candidate is integrated with the benchmark's own `Vehicle.step` on a deep copy of the car, tyre temperatures and pressures included. The model error is zero by construction. Slip, kerbs and wake are the real ones.
3. **Control-knot MPPI** (`sampler.js`). Steer and pedal knots every 0.1 s over a 2 s horizon, with K = 40 samples at 15 Hz. The seeds are the previous plan, a ghost-control replay, and pursuit policies at several lateral offsets, plus ±5 m offsets in combat. A plan is simply the control sequence with the lowest cost.
4. **Opponents as world-space oriented boxes** (`field.js`). Predicted poses along the ghost's speed shape, with an uncertainty inflation that grows over time, checked by SAT against the rollout car at each step. The host wake formula is applied to those poses, so drafting and dirty air come out of the plant. There are no attack or defend modes that change the plan. "Defend" is only a small reward for boxes that cover the line of a car behind.
5. **Tyre shadow price** (`tyre-price.js`). Every rollout pays `Σ price(core_i)·slipPower_i`. This is the exact quantity the tyre model turns into heat. The price has an always-on base plus a convex term above 84 °C. Slip beyond the force peak costs extra, because `tanh` force saturates while heat keeps growing linearly with slip. This closes the slip exploit at its source.

None of the four rivals uses any of these three: a value clock in place of a reference line, the true plant in place of a quasi-steady model, or tyre energy as a planning price.

## 3. Results

**Harbor Ring, GT class, 5-car penta field.** Five heats, 3 laps each, with a cyclic grid rotation so PHANTOM starts from every slot once.

| Heat (PHANTOM slot) | Raw | Legal | PHANTOM best lap | PHANTOM penalties |
|---|---|---|---|---|
| 1 | P3 | **P1** | **72.31** | 1 contact, 1 offtrack |
| 2 | P2 | **P1** | 75.23 | 1 contact |
| 3 | P3 | P3 | 73.88 | 2 contacts, 1 offtrack |
| 4 | P3 | P2 | 74.72 | 3 contacts, 1 offtrack |
| 5 | **P1** | **P1** | 74.23 | 1 contact |

- **Fastest lap:** PHANTOM set the fastest lap in all 5 heats. The rivals' best laps were 74.86–81.15.
- **Contacts:** 8 in total. Astra had 7, VORTEX 28, NOVA 32 and Supreme 36.
- **Solo:** 70.1–72.6 on laps 1–2.

**Known limitation.** Tyre cores still rise about 10 °C per lap at this pace, so laps 3+ fade by 3–8 s. The shadow price trades pace for temperature, but no setting tried both held 73 s and stopped the rise.
