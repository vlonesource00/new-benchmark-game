# INTERCEPT implementation

Implementation worktree: `intercept-dev`. Existing drivers and TEMPEST experiments are preserved. Integration follows the published `graphics-aaa` base, now rebased onto cca58d1. The traffic laboratory measurements below began on 7df8b91; its regression checks also pass on the new base.

Design: an asynchronous battle planner with a shared controller executing at the physics rate. Small connected corridors, fresh body clearance, fixed attack side, continuous joins, and useful exit speed determine moves. Labels never select the pedal profile.

Completion gates (each requires evidence):

- [x] Shared controller, private course data, timestamped contract and physics-rate worker executor.
- [x] Clean retained maneuver pass around a car blocking the fast line, through the worker path, with a following-only control. Verified in the controlled Harbor train; general race passing remains open.
- [ ] Inside/outside/exit passes, both grid orders, defense and multi-class traffic.
- [ ] Stopped/spun/pit/finished-car evasion, rain, swaps, safety car and full yellow.
- [ ] Dynamic tyre/fuel/energy strategy; Harbor GTP below 53 s, GT3 below 64 s, comparable stint fade at most 4 s.
- [ ] Matched comparisons against RAZOR, APEX and SPEARHEAD; supported worker jitter/spikes and real browser checks.

Superiority is a test objective, not an established result. Local result files are excluded from commits. Fixed roster comparisons isolate integration effects on other AIs.

## Traffic laboratory checkpoint

`TOOLS.md` documents the sparse three-GT3 Harbor fixture, interactive replay, JSON/CSV capture, analysis, comparative matrix and regression checks.

The standard controlled train puts GT3s at 100, 180 and 260 m, with the GTP at 20 m. It retains all three passes at 263.1, 254.1 and 272.8 km/h; the last clearance occurs at 9.89 s. Straight time is 10.69 s against 10.38 s solo, a 0.31 s loss. There are no contacts, damage or incidents in this case. The first pass has new maneuver evidence; the next two use the already established passing lane. Following-only retains zero passes on the straight and loses 4.29 s.

The matrix covers six scenarios across seeds 7, 11 and 23. Standard train results are nearly identical across those seeds; seeded delivery jitter is the main source of seed variation here. Geometry, spacing, rival speed and unrestricted rival behavior are separate variations. Unrestricted GT3s are harder to reach before T1; the report records reachability rather than claiming every unmade pass was feasible.

The 500/250 ms injected-delay scenario retains three clean straight passes for seeds 7 and 23. Seed 11 retains two on the straight; the third completes just after the endpoint with a light bumper contact (0.50% damage), and is marked contact-assisted. This is an open latency/performance edge case, not clean passing evidence.

Stopped and spun obstacles remain in place, without marshal assistance. Both are cleared without damage. The stopped obstacle adds 0.09 s to the straight against the same moving field with that obstacle removed; the spun obstacle adds 0.85 s. Speed recovery against that moving-field control is 1.6 and 3.23 s respectively. Both fail the 1.5 s fast-evasion checkpoint; total recovery against solo is also shown and is slower still.

Native checks cover pit/boxing/off-road/retired bodies, true rear clearance, lane-buffer isolation, pedal/profile invariants, short-race compound selection, swaps, SC, FCY, rain and changeable weather. The production build passes. A real Chromium two-car run with 250 ms wall-clock reply delay completed 25 simulated seconds with no worker errors or severe contacts, but had light rubbing and 1.27% damage. It does not replace a real-browser three-GT3 pass fixture or full endurance validation.

## Open work

1. Keep body separation through a late pass into T1, including variable reply cadence, without unnecessary following brakes.
2. Recover useful speed promptly after hazard evasion; safe clearance alone does not meet the gate.
3. Validate inside/outside/exit attacks and defense, in both grid orders and actual browser workers.
4. Diagnose race-pace loss using `race.mjs --trace`, then measure stint fade, rain decisions and endurance results on matched fields.
5. Re-run qualifying against the new run-up rule. Earlier qualifying results do not establish the current ranking.

## Current endurance checkpoint

A matched 12-lap Harbor GTP race through the worker path, seed 7 with INTERCEPT starting behind RAZOR and APEX, finishes with RAZOR at 686.68 s, INTERCEPT at 698.41 s and APEX at 704.98 s. INTERCEPT's best lap is 52.53 s, with one stop, one swap, zero damage and zero incident points. Its final medium stint runs from 52.53 to 53.40 s. It declares 10 attacks, starts 10, and reaches no overlaps or retained passes. The result establishes useful pace and strategy in this setup, not effective same-class race combat.

The rival forecast now continues from its accelerated velocity after its one-second acceleration window, and never moves backwards after braking to a stop. Displacement and reported velocity agree. This corrects the motion model; it does not establish a race improvement.

An energy A/B leaves INTERCEPT on the shared game's policy instead of its own straight-speed taper. Race time is essentially unchanged (698.34 s), while INTERCEPT takes 3.17% damage and two incident points, still without a pass. The production energy policy remains unchanged. A lower hybrid demand on straights alone is insufficient to explain the combat loss.

All 19 system checks, the controlled traffic regressions and the production build pass on this base. The corrected two-car fixture also exposes a severe impact when a spun car is spawned only 23 m ahead at 58 m/s; this is an open near-hazard case, not covered by the clean sparse-train result. A moving-rival fixture damages the rival even without INTERCEPT damage, so it cannot establish clean passing. Fast hazard recovery, the late-pass latency edge case, same-class conversion, defense, GT3 endurance and broader browser validation remain open. INTERCEPT is a working prototype, not a proven best racer.
