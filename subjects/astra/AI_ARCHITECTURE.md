# Astra racing AI architecture — 6 September 2026

This is an original extension of Astra's driving stack. It uses the same Vehicle force solver as the player; there are no AI power boosts, extra tyre grip, ghosting or collision immunity.

## Driver architecture

1. **Performance model.** Shared tyre-grip equations account for temperature, pressure, wear and load sensitivity. The driver estimates acceleration, braking and lateral force from fuel mass, gearing, torque, wing setting, aerodynamic wake, surface rubber, wetness and damage. A friction ellipse reserves force for steering during acceleration/braking. Straight-line, high-brake telemetry updates a bounded braking calibration; collision and high lateral-acceleration samples are excluded.
2. **Race context.** Push, battle and preservation modes change the value of an attack. Defensive decisions require a closing or nearby challenger. Aggression changes opportunity/risk scoring; it cannot relax hard contact limits or bypass the collision supervisor. Settings offers Measured (40%), Race (72%) and Fierce (95%).
3. **Battle planning.** Up to 27 immediate quintic paths search the usable track width across three transition horizons. Up to six additional continuations compare holding the corridor, passing then returning, and switching sides for an exit. Selected exit locations are anchored to track coordinates so repeated replanning does not indefinitely postpone the manoeuvre. The continuation evaluates up to 270 metres. Returning to the base line preserves geometric continuity when traffic clears or recovery finishes.
4. **Opponent responses.** The planner evaluates holding the observed course, returning toward the racing line and braking early. These are weighted hypotheses, not access to another driver's commands. High-speed perception expands according to braking distance, up to 420 metres. Distant stopped/very slow cars constrain the extended braking profile; moving traffic has near-term speed constraints and longer-term response costs.
5. **Speed planning.** The blanket penalty for driving away from the base line is removed. Actual path curvature and the estimated force envelope set corner speed. A backward braking pass and forward acceleration pass produce a speed profile and arrival times within the reduced model. Existing conservative racing-line limits remain a reference; this is not an unrestricted minimum-lap-time optimizer.
6. **Dynamic control search.** Fifteen steering/acceleration combinations are predicted over 0.66 seconds. The two-axle chassis model includes steering lag, tyre relaxation, longitudinal load transfer, combined slip and yaw dynamics. It starts from measured body velocity, yaw rate and tyre forces. Cost includes tracking error, speed error, grip use, developing slip and predicted track-edge crossing. Corrective steering authority increases near an edge or during a slide.
7. **Independent supervision and recovery.** A physics-frequency supervisor uses relative velocity and rotated footprints to constrain speed and apply emergency braking. It also reacts to outward motion near a track edge. Recovery clears stale plans, uses slower manoeuvres in runoff, avoids reversing outward when forward travel leads back in, and retains control until position and heading are suitable for racing again.

The tactical and control-search target intervals remain 80 ms and 40 ms; they are quantized by the 120 Hz simulation. Vehicle forces and player input still run at 120 Hz with the existing wheel substeps. The predictor is a reduced model, not a duplicate of every vehicle subsystem or a general nonlinear optimization solver.

## Visual debugger

Press **B** or choose **Watch AI Race**. The engineer view includes selected/candidate/rejected paths, footprint corridors, opponent forecasts, dynamic control rollouts and red braking crossbars. Telemetry shows the selected exit manoeuvre, projected exit speed/gap, strategy, aggression, braking-calibration confidence, opponent pressure and supervisor intervention.

Forecast gaps are estimates, not guaranteed passing margins. The three opponent-response probabilities are heuristic and have not been statistically calibrated against human drivers.

## Validation

- `npm test`: unit and integration regressions, including retained overtaking, an unexpectedly braking rival, runoff recovery, high-speed perception and continuity after traffic clears.
- `npm run test:racecraft`: the standard eight-car, 240-racing-second quality contract.
- `npm run test:racecraft:fierce`: the same contract at 95% aggression.
- `npm run benchmark:long`: seven minutes with eight cars.
- `node tests/field-quality.mjs --fierce --long`: longer aggressive-field stress run.
- `npm run diagnose:ai`: recent driver telemetry leading to an excursion or major slide.

`FIELD`, `SECONDS`, `AGGRESSION`, `WETNESS` and `SIM_ROOT` allow controlled comparisons. The benchmark excludes countdown from battle time. A confirmed pass requires an order reversal with more than six metres separation. A retained pass must survive another 120 metres without being reversed by more than two metres. Clean retained passes must also avoid new pair damage during that interval. These are diagnostic proxies, not a racing steward or proof that a pass was held through a specific corner.

The baseline was copied into a temporary directory before this architecture work, rather than reconstructed from memory. Historical results for the preceding upgrade remain in AI_REVIEW.md.

## Measured results

Same dry Circuit Solenne, driver skills, car setups and duration. All 33 regression/scenario tests, both eight-car quality contracts, and the production build pass. Race remains the default; Fierce is an optional risk preference, not a promise of more overtakes in every race.

| 8 cars, 240 racing seconds | Previous AI | New Race mode | New Fierce mode |
|---|---:|---:|---:|
| Confirmed passes | 16 | 18 | 16 |
| Clean confirmed passes | 15 | 17 | 15 |
| Clean passes retained another 120 m | Not captured | 14 | 14 |
| Close-racing vehicle-seconds | 389.5 | 690.8 | 654.3 |
| Off-track vehicle-seconds | 0 | 0 | 0 |
| Contact impulses | 84 | 12 | 1 |
| Impacts above 6 m/s | 0 | 0 | 0 |
| Peak normal impact speed, m/s | 4.66 | 3.67 | 1.76 |
| Sum of damage fractions | 0.099 | 0.034 | 0.011 |
| Field spread, metres | 575.1 | 445.7 | 462.6 |
| Fastest valid lap, seconds | 85.42 | 85.07 | 85.40 |

The standard grid's average best lap improved from 88.96 to 86.71 seconds. This includes the effect of traffic; it is not a solo lap-time comparison. In the six-car standard run, all cars stayed on track with no contact or damage, but clean passes decreased from seven to six. Field spread improved from 537.8 to 452.5 metres.

The final **420-second Fierce stress run** still produced one impact above 6 m/s and 53.82 off-track vehicle-seconds. Against the previous AI's equal-duration run, these improved from two severe impacts and 76.55 off-track vehicle-seconds; damage fell from 0.513 to 0.228 and field spread fell from 2404.5 to 1598.2 metres. However, clean confirmed passes decreased from 35 to 28, and the leader covered less distance. This is improved long-run stability and proximity, not dominance on every metric. The 129 contact impulses in this longer Fierce run include repeated low-energy contact; count alone is not an impact-severity measure.

Machine-readable measured summaries are in `tests/results/architecture-review.json`. These deterministic comparisons are regression evidence, not statistical confidence intervals or a cross-project ranking.

## Engineering limits

Finite trajectory sampling can miss a better manoeuvre. Opponent responses remain approximate, especially against unpredictable human inputs. Longer races, wet conditions and different starting situations require separate evaluation; one clean benchmark is not a collision-free guarantee.

An experimental corner-memory governor and stronger tracking gain were rejected after inconsistent race results. The shipped adaptation uses physical-condition estimates and bounded braking identification. It does not claim to learn an opponent's personality or an optimal racing policy.
