# Where Astra's AI can materially improve

Implementation and final measured results: [AI_IMPROVEMENTS.md](AI_IMPROVEMENTS.md).

Reviewed 7 September 2026 against the project handoff, current simulation code, and a fresh six-lap pace benchmark. This is an assessment, not an implementation or a promise of particular gains. Vehicle physics should stay unchanged.

The highest-value next step is **sustained race pace**, followed by better control and opponent prediction. The project already has trajectory search, alternative opponent responses, a dynamic chassis predictor, overtaking commitments, switchback continuations, and an independent collision supervisor. Rebuilding those under new names would add little.

## 1. Predict tyre heat before it costs lap time

**Evidence:** The six-lap benchmark reproduced 83.975, 79.258, 80.333, 82.567, 85.200, and 87.825 seconds, with zero damage and off-track time. One rear tyre reached 127.9°C; rear wear was only about 0.001. This run points primarily to temperature/pressure and the resulting pace restriction, rather than worn-out tyres.

`src/sim/performance.js:14–21` reduces pace using current rear temperature. `src/sim/strategy.js:10–18` switches modes using current wear, average heat, damage, and nearby traffic. Neither predicts how today's driving affects the next laps.

**Change:** Predict axle temperature and slip-energy accumulation over upcoming corners. Include that cost when choosing throttle, rotation, and attack intensity. Allow cooling on appropriate straights and more restrained exits before the tyres become hot. Give qualifying and race modes different objectives: best single lap versus total time to finish.

**Proof:** Compare total six- and ten-lap time, later flying-lap median, peak rear temperature, slip energy, and incidents. A slower first flying lap can still be a better race driver. The current six-lap test checks completion and a best lap below 80 seconds; it does not constrain late-stint deterioration.

## 2. Make predictive control choose the controls actually applied

**Evidence:** `src/sim/controller.js:103–132` evaluates 15 combinations of steering correction and acceleration bias over 0.66 seconds. Each rollout holds its steering demand and acceleration bias constant. In the real control path, `:74–76` only applies negative acceleration bias through throttle reduction and a small brake adjustment; the positive bias is not applied. This is not a fully matched joint control optimizer.

**Change:** Search short sequences of steering, throttle, and brake, beginning with a small number of control segments. Model the same actuator smoothing and pedal mapping used in execution. Apply the selected first action, then replan. Warm-start from the previous solution. Keep the independent emergency supervisor authoritative.

**Benefit:** Better brake release, corner rotation, and earlier usable exit throttle, with less unnecessary sliding. This can help both outright speed and tyre life.

**Proof:** Measure sector time, prediction error versus actual chassis motion, steering oscillation, slip energy, and control computation time. Expand the search only if the simpler matched model wins first.

## 3. Optimize the racing line for time, not just smoothness

**Evidence:** `src/sim/ai.js:12–36` generates one elastic-band line and then assigns acceleration/braking-feasible speed profiles. That is a useful geometric baseline, but the line itself is not optimized against the resulting lap time. `src/sim/planner.js:100–104` only considers a zero extra offset in clear air. Alternative traffic paths also inherit a baseline speed cap at `:127` and `:193`.

**Change:** Evaluate line and speed together across complete corner sequences. Search apex position, entry width, and exit shape using the existing performance model. Favor exits onto long straights when that lowers total time. Generate a few useful variants for dry, wet, and hot-tyre conditions; interpolate or select rather than recomputing everything every frame. Check whether the baseline speed cap unnecessarily limits a gentler alternative path.

**Proof:** Sector and lap improvements under unchanged grip, power, setup, and boundary rules. Test unfamiliar corner sequences as well as this circuit to avoid producing one-track tuning.

## 4. Learn what each opponent actually does

**Evidence:** `src/sim/perception.js:32–50` predicts bounded acceleration and lateral drift, then uses fixed HOLD/RACING LINE/EARLY BRAKE probabilities of 60/25/15 percent. There is no persistent opponent history in this class. The planner already supports switchbacks and exit continuations; the opportunity is to make their predictions better.

**Change:** Maintain lightweight per-opponent estimates of braking location, braking strength, preferred corridor, and defensive response. Update hypothesis weights from observed prediction errors, with uncertainty and fallback defaults for unfamiliar opponents. Predict defensive movement as well as returning to the racing line. Never read another driver's chosen plan or future controls.

**Benefit:** Fewer repeatedly failed attacks, more credible switchbacks, and better handling of an opponent who consistently brakes early or protects the inside.

**Proof:** Held-out scenarios with early/late braking, defensive movement, and changing behaviour. Track prediction error, retained passes, time trapped behind slower cars, and contact rates—not just pass count.

## 5. Give strategy actual race context and recovery foresight

**Evidence:** `RaceStrategy.update` receives car state and local observations, but no standings, remaining race distance, or explicit finish objective. Its output mostly changes attack value. Recovery in `src/sim/controller.js:96–99` checks whether moving cars are within seven metres; it does not estimate their arrival at the rejoin point.

**Change:** Supply race progress, remaining laps, position, and gap trends. Decide when to attack, preserve tyres, follow for a better exit, or protect a result. Handle lapping traffic distinctly. For recovery, predict traffic arrival and choose a merge gap before crossing onto the racing surface. Introduce driver differences through braking confidence, consistency, and preferences rather than only speed multipliers.

**Proof:** Late-race decisions, lapped-car interactions, and rejoining ahead of a rapidly approaching car. Measure finish time/position, recovery success, and unnecessary time loss. Keep risky aggression from changing collision dimensions or physical limits.

## 6. Spend computation where decisions are difficult

**Evidence:** Tactical search runs approximately every 80 ms; control search every 40 ms. Traffic search generates 27 initial paths, adds continuations, and checks opponent responses across path samples. Control search allocates rollout point objects even when they are only needed for diagnostics. These are optimization candidates, not yet proven runtime bottlenecks.

**Change:** Profile first. Share immutable per-tick car projections; cache repeated track geometry and predictions at identical sample times; reuse rollout buffers; capture full diagnostic paths only when requested. Spread routine planning across cars and trigger early replans on material threats. Keep the physics-frequency supervisor running regardless of planning budget.

**Proof:** Median and p95/p99 AI update time and rendered frame time at increasing field sizes, with equivalent driving outcomes. The headless solo benchmark completed in about 2.5 wall seconds, so there is no evidence yet that solo AI computation needs urgent optimization.

## Verification in this review

- The current test suite exited successfully.
- The six-lap pace benchmark reproduced the documented lap times, zero damage, and zero off-track time.
- A fresh normal eight-car quality-contract run exceeded the inspection's 50-second process limit; its result is unverified here. Previously documented race-contract passes are historical evidence, not a fresh result from this review.
- No simulation code or calibration was changed.

## Recommended implementation order

1. Add sector, slip-energy, prediction-error, late-stint, and AI-time measurements; preserve existing racecraft contracts.
2. Match predicted and executed controls, then add predictive thermal management. Judge both by whole-stint time.
3. Optimize clear-air line variants and their coupled speed profiles.
4. Add opponent history, adaptive response probabilities, and race-context decisions.
5. Optimize measured runtime bottlenecks and expand the scenario matrix.

Use dry/wet conditions, multiple starting positions and skill gaps, longer stints, surprise braking, blocked corridors, and high-speed rejoin scenarios. Do not claim improvement from one fastest lap or one deterministic race. No learned policy or language model is required for these upgrades: the present physics-based architecture has substantial room to improve through better objectives, predictions, and control fidelity.
