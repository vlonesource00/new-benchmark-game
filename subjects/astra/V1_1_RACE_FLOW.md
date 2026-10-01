# v1.1 — close racing and preserving flow

Implemented on `v1.1`; `main` remains the imported baseline (`952c136`). Repository: https://github.com/vlonesource00/astra (private).

## Behaviour

- Cars no longer treat the lateral uncertainty padding around a forecast as physical bodywork when deciding whether to reject a path. Physical overlap, relative speed and lateral closing still determine hard exclusions; uncertainty still contributes to cost. Longitudinal prediction buffers remain.
- A car running alongside another at a settled relative speed can hold its speed, including a light rub. The planner previously applied a rear-end following-speed cap even beside another car's doors, despite the supervisor allowing that rub. The exemption now requires **observed current overlap**, not merely a forecast of a future pass. High closing speed, deep overlap and crossing into a car still retain braking constraints.
- A substantially slower, unexpectedly braking or unstable car ahead can interrupt an existing defensive commitment. The planner adds a 1.1-second candidate horizon alongside its normal 2.0/2.8/3.6-second options, retaining grip, trajectory, traffic and front/rear exit checks.
- Ordinary shared braking is distinguished from lost momentum: the unexpected-braking trigger requires the rival to decelerate more than 3 m/s² harder than the observing car. Very low rival speed and lost heading are independent triggers.
- An existing side-by-side overlap takes priority over a new escape opportunity. An already selected attacking side is preserved while responding to the same slowing car.
- The engineer's detailed telemetry includes `FLOW RESPONSE`; the explanation names the slowing rival. All candidate/rejected paths and simultaneous attack/defence visuals remain.

No engine power, tyre forces, collision response, driver skill, track-limit allowance or baseline grip/pace settings were changed in this branch. Light contact remains real and can cause damage.

## Reproducible results

Same deterministic setups, compared with the `main` baseline. The opponent's scripted braking/steering is applied only to its actuator; the pursuer sees ordinary observed motion.

| 40-second incident scenario | Main progress | v1.1 progress | Progress gain | Braking time saved |
| --- | ---: | ---: | ---: | ---: |
| Early brake | 1327.86 m | 1345.31 m | 17.44 m | 0.317 s |
| Lost control | 1303.79 m | 1337.19 m | 33.40 m | 0.633 s |

Both scenarios have zero pursuer damage, zero half-car-limit excursions and zero severe impacts.

The 30-second attack-under-pressure fixture improves from 1009.64 m to 1043.84 m. Its pursuing car changes from 19.81 m ahead to 10.26 m behind. All three pack fixtures pass with zero excursions, zero severe impacts and zero damage.

| Full-race check | Result |
| --- | --- |
| Default six-car, three-lap showcase | P4; 4:12.258 total; best lap 1:22.525; zero excursions and damage |
| Normal eight-car, 240 seconds | 19 clean passes; 354.5 m spread; zero excursions, severe impacts and damage |
| Maximum-aggression eight-car, 240 seconds | 17 clean passes; 349.4 m spread; zero excursions and severe impacts; aggregate damage 0.027 |

The default showcase finishes 0.575 seconds sooner than `main` and improves from P5 to P4, but its best lap is 0.858 seconds slower. This branch improves the measured incident response and close-racing outcomes; it is not a universal lap-time improvement or a guarantee against racing incidents. The maximum-aggression track-limit failure documented for `main` did not occur in this branch's accepted run.

## Verification

- 76 unit/integration tests pass.
- `node tests/flow-benchmark.mjs --check` passes.
- `npm run test:pack`, `npm run test:showcase`, `npm run test:racecraft`, and `npm run test:racecraft:fierce` pass.
- Production build passes; the existing Vite bundle-size warning remains.
- Default-showcase edge diagnostic records no excursions.

Compact results are committed in `tests/results/v1.1-validation.json`. Detailed local records are in `artifacts/v1.1-eighth-*`; these scratch files are excluded from Git. `SIM_ROOT` selects an archived simulation for the standalone benchmarks. The main baseline used here was exported with `git archive main`.

The private phone preview serves the rebuilt `v1.1` files. Reload an existing phone tab to load them.
