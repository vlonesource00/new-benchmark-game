# INTERCEPT implementation checkpoint

Independent racer on `intercept-dev`, based on `graphics-aaa`. This checkpoint was measured on 9a8282d; the subsequent upstream changes through d996abd affect only opt-in TEMPEST experiments and documentation. Existing drivers and their experiments are preserved.

Readiness estimate: approximately 70%. This is an engineering estimate against the gates below, not a measured probability of winning or an ETA. INTERCEPT is not yet a proven best racer.

The asynchronous planner chooses small connected corridors. The shared controller executes at the physics rate with fresh body clearance, a latched attack side, private course arrays and bounded route contracts. Labels never choose a pedal profile. A cached, short physical forecast models rival acceleration, braking and road distance without reading rival plans. A moving off-road car is still predicted as moving.

Completion gates:

- [x] Physics-rate executor, bounded contracts, private route buffers and continuous joins.
- [x] Three retained traffic passes around bodies blocking the fast line, with a following-only causal control.
- [x] Actual Chromium workers withstand the tested 500/250 ms wall-clock reply delays without contacts or worker errors.
- [x] Native regression coverage for pits, retired/off-road bodies, swaps, rain, changeable weather, SC and FCY.
- [x] Harbor pace targets in the measured runs; dynamic tyre/fuel/energy planning and measured stint fade below 4 s.
- [ ] Repeatable retained same-class inside/outside/exit maneuver passes and useful defense in matched grid orders.
- [ ] Fast hazard recovery; safe clearance alone does not meet this gate.
- [ ] Consistent endurance superiority against RAZOR, APEX and SPEARHEAD across tracks, seeds, mixed fields and real browser scheduling.

## Changes accepted in this checkpoint

- Cache a bounded physical rival forecast instead of freezing acceleration. Preserve powered predictions for upright off-road cars.
- Compare corridor clearance in the future road section and preserve an established lane through a reachable traffic train. Abort routes cannot chain another attack.
- Use at least 3.3 m center separation for new GTP passes of GT3s; retain the smaller owned space once alongside.
- Reset wear forecasts on renewal and estimate wear over meaningful distance. Distinguish a fuel-only stop from tyre renewal. Do not make an extra late tyre stop when the current set can finish economically within fuel, mandatory-stop, swap and fade limits.
- Permit a close combat hybrid burst only when the nose is clear, the car is accelerating and battery reserve permits it. The race bridge now represents green as no active caution; previously the string `green` silently disabled the burst.
- Preserve GT's measured grip reserve in qualifying. Spending the full modeled peak gained only 0.10 s but caused an excursion; the reserved run stayed clean.
- Release unreachable stored braking after a hazard escape. Recovery remains too slow.
- Add four replay cameras, actual trails, same-time solo/no-hazard ghosts, pair clearance readouts and encounter bookmarks. Capture race peak/cumulative damage and actual solver contact pairs so pit repair cannot erase safety history.

## Traffic and browser evidence

The controlled Harbor train starts the GTP at 20 m and three RAZOR GT3s at 100, 180 and 260 m. GT3 speed is limited through ordinary pedals; bodies are neither moved nor ghosted. The trace continues through the next corners.

Current worker train: three retained passes, one new maneuver and two carried-lane passes, zero contacts/damage/incidents. Straight delay is -0.085 s against matched solo; drafting accounts for the negative delay. Following-only retains zero passes on the straight. The seeded simulated-delay checks also retain three clean passes.

Actual Chromium module workers, with 500/250 ms wall-clock reply delays: three retained passes at 263.2, 252.1 and 271.9 km/h; last clearance at 10.12 s. Straight delay is +0.343 s against matched solo. No contacts, damage, incident points, worker errors or browser errors. Maximum route age is 1.28 simulated seconds. Headless frame cadence differs from a laptop or 60 fps real-time play; this is one validated case, not a guarantee that all deadlines or hardware are safe.

Pinned stopped/spun obstacles are cleared without rescue or damage. Current total straight delays are +0.347 / +0.468 s. Incremental delay at clearance versus the moving-field counterfactual is +0.118 / +0.170 s, but speed recovery takes about 6.84 / 7.00 s. The 1.5 s recovery gate remains open. The isolated spun case and a very late hazard require separate scrutiny.

## Pace and endurance evidence

Matched solo worker qualifying setup on Harbor, warm softs, seed 7:

| Class | INTERCEPT best | RAZOR best | APEX best | SPEARHEAD best |
| --- | ---: | ---: | ---: | ---: |
| GTP | 50.71 s | 51.42 s | 51.50 s | 52.42 s |
| GT3, measured reserve | 61.00 s | 60.86 s | 61.01 s | 62.66 s |

Both accepted INTERCEPT qualifying runs have zero damage and incident points. These short qualifying runs do not establish endurance superiority.

Current four-driver, 12-lap worker races, seed 11, INTERCEPT starting last:

| Class | INTERCEPT finish | RAZOR finish | INTERCEPT peak damage | Incident points | Stop / swap |
| --- | ---: | ---: | ---: | ---: | ---: |
| GTP | 691.92 s | 694.81 s | 0.40% | 0 | 1 / 1 |
| GT3 | 812.64 s | 809.19 s | 5.72% | 6 | 1 / 1 |

The GTP field includes a severe APEX/RAZOR collision; INTERCEPT is not involved in that severe contact. Its win is not proof of a clean maneuver pass of RAZOR. It records one retained pace pass and no retained new maneuver. GT3 loses 3.45 s and records no retained pass. Finish damage is zero after GT3 pit repair, which is why peak/cumulative damage and pair history are required.

Clean timed samples in the final medium stints span 0.94 s in GTP and 2.03 s in GT3. They satisfy the fade target for these runs, not every track or traffic condition. Earlier front-start runs on the pre-burst bridge won GTP by 1.44 s and lost GT3 by 0.82 s; they are historical comparisons, not results of the final bridge fix.

## Remaining development

1. Convert overlap into retained same-class maneuver passes, with a causal following-only control and both matched grid orders.
2. Diagnose GT3 lap-1 off-track loss and contact history; measure peak damage rather than finish damage.
3. Recover speed rapidly after stopped/spun-car evasion without sacrificing body clearance or stability.
4. Validate defense, mixed-class endurance, rain pit decisions and variable scheduling in actual browser workers and on slower hardware.
5. Extend qualifying and endurance comparisons beyond Harbor and establish consistent wins before claiming superiority.

Thirty system checks and the controlled traffic regressions pass. Result JSON/CSV/HTML files remain local and excluded from Git. `TOOLS.md` contains reproduction commands and the visual review workflow.
