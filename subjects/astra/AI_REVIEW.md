# Astra AI review and upgrade

Historical review of the preceding update. The 6 September architecture upgrade is documented in [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md). Its benchmark also corrects the battle-time counter to exclude countdown; the historical battle-time figures below included countdown proximity.

The previous version had useful trajectory search but its claims of superior AI were not demonstrated by comparable cross-project tests. This update repairs concrete prediction, racecraft and control errors. It does not establish superiority over Gemini Gauntlet, Claude or GPT Racing on their different tracks and physics.

## Changes

- Opponent prediction now integrates acceleration for 0.8 seconds and continues at the resulting speed. Braking predictions stop at zero instead of predicting backward travel.
- Side-by-side detection uses longitudinal footprints and lateral separation. A car directly ahead no longer masquerades as a side-by-side opponent.
- Physical position determines which side to preserve, overriding an obsolete attack direction that would steer toward the opponent.
- Tactical commitment expiry is independent of path-switch hysteresis. Changing a candidate no longer renews an old tactical intent indefinitely.
- Threats within 32 metres behind activate full-width candidate planning; previously DEFEND could be selected while only the central path was searched.
- Collision-free candidates rank ahead of conflicting candidates. When all conflict, the debugger reports YIELD before SIDE BY SIDE.
- The controller consumes traffic speed constraints from the planner. Previously it used only corner speed limits and discarded planned slowing for traffic.
- Steering preview increases with speed from 0.37 to 0.50 seconds, reducing oscillation while following offset paths. The tyre/chassis equations and available grip are unchanged.
- Collision instrumentation records actual peak relative normal impact speed and contacts above 6 m/s without changing impulses.

## Equal-duration comparison

Both versions ran for 240 racing seconds on the same dry Circuit Solenne grid, using the same setups and driver skills. Countdown is excluded; a 10-lap race prevents a player finish from ending the measurement early. The previous implementation was reconstructed in a temporary simulation directory by reversing this update's control changes, retaining the same passive collision instrumentation. Its old sprint benchmark behavior matched the preceding implementation.

| Metric | Previous, 6 cars | Updated, 6 cars | Previous, 8 cars | Updated, 8 cars |
|---|---:|---:|---:|---:|
| Contact impulses | 18 | 59 | 40 | 84 |
| Peak normal impact speed, m/s | 9.41 | 6.63 | 25.75 | 4.66 |
| Impacts above 6 m/s | 1 | 1 | 3 | 0 |
| Confirmed passes | 20 | 12 | 17 | 16 |
| Passes without pair damage | 16 | 7 | 11 | 15 |
| Off-track vehicle-seconds | 5.82 | 0 | 7.51 | 0 |
| Sum of car damage fractions | 0.108 | 0.153 | 0.452 | 0.099 |
| Front-to-back distance, metres | 1011.1 | 537.8 | 914.3 | 575.1 |
| Battle vehicle-seconds | 199.2 | 199.3 | 388.5 | 421.6 |

A confirmed pass reverses a pair's progress order with more than six metres separation. It is counted as clean only if neither car accumulates damage during that transition. Battle time counts each car once per timestep when it is within 12 metres longitudinally and five metres laterally of another car. These are diagnostic definitions, not a racing steward or proof of pass causality.

The eight-car field shows materially softer contact and more clean passing. The six-car field is tighter and stays on track, but clean passes decrease and cumulative damage increases. Best laps in the 240-second window are 84.98 seconds (six cars) and 85.42 seconds (eight cars), versus 85.70 and 85.48 previously. This is primarily a racecraft/stability improvement, not a large solo-pace gain.

## Validation and limits

Run `npm test` for prediction, overlap, defensive planning, actuator, solo-lap and physics checks. Run `npm run test:racecraft` for the eight-car 240-second quality contract, or `npm run benchmark:quality` for metrics. `FIELD`, `SECONDS` and `SIM_ROOT` allow separate exploratory runs; the quality contract intentionally requires eight cars and 240 seconds.

Longer sprint runs still show occasional excursions: the updated eight-car run recorded 10.1 off-track vehicle-seconds before the player finished, versus 13.2 previously. These deterministic dry-grid results do not establish behavior against an unpredictable human, in every setup, or in wet conditions. The planner still uses an approximate forecast and can select the least-risk conflicting path if no safe candidate exists; it is not a collision-free guarantee. Further work should target wet/setup sweeps, variable starting positions, opponent intent uncertainty and explicit hold/brake escape trajectories.
