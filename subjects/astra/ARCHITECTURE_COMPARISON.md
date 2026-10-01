# Racing candidate architecture review

Reviewed 9 September 2026. Comparison inputs are the sibling development repositories only: Claude `96334bc19525`, GPT Racing `0dcd4744d4e5`, Gemini Gauntlet's checked-out NMPCC branch `17ccafbd3a65`, and Astra before this upgrade `b5b825e`. Benchmark and competition are excluded from rankings and architectural evidence. No benchmark scores or lap times from another simulator are used to rank them.

## Provisional ranking before the upgrade

For the combined question of complete racing AI, planning depth, physical integration and breadth, my source-based order is **Claude, GPT Racing, Gemini NMPCC, Astra**. This is engineering judgment, not a measured race result. The middle two could reverse under criteria that value local predictive control over field coordination. Visual quality is not included in that AI order; Astra's lighting/material pipeline is a strong base to retain.

| Area | Strongest source evidence | Astra's previous limitation |
| --- | --- | --- |
| Long-horizon planning | Claude `src/sim/TrackGrid.js` and `src/ai/Lattice.js`: shared state/edge costs and a terminal global value function | Elastic line plus short continuations; no equivalent lane/rate value function |
| Field coordination | GPT `src/ai/RaceSnapshot.js` and `AIRaceDirector.js:_planField`: one snapshot, ordered proposals, cross-trajectory conflict checks | Independent tactical choices; observations do not reserve a shared route |
| Explicit battle phases | Gemini `TacticalAttackEngine.js`, `TacticalDefenseEngine.js`, `v2/GameTheoreticCombatEngine.js`; GPT `RacecraftAgent.js` | Commitment and switchback sequences exist, but fewer explicit completion/transition states |
| Physical prediction and diagnostics | Astra `performance.js:predictChassis`, `controller.js:trackMPC`, `debugger.js`; Gemini V2 coupled controller | Astra's prediction was tied to the GT spec, limiting transfer to other vehicles |
| Scheduling | Claude `Scheduler.js` and `Pilot.js`: staggered requests plus a bounded plan budget | Fixed per-car 12.5 Hz planning can align across the field |
| Vehicle/track breadth | All three siblings have GT, Touring, Prototype and an authored Harbor Ring definition | Astra had one GT and numerous Solenne width literals |

Claude's actual lattice consumes `grid.J`, `edgeCost` and `edgeNext`; this is more than a class name claiming global planning. GPT's director calls `trajectoriesConflict` while choosing proposals and later applies per-car controls. Gemini's main imports both controller generations and constructs them for different slots, so the V2 source's presence must not be mistaken for every car using it. These wiring details matter more than file size or impressive terminology.

Potential trade-offs remain: centralized route arbitration can make drivers cooperate more than independently competing opponents would; occupancy penalties can inhibit close racing; a complex predictive controller can be hard to calibrate. Static source inspection does not establish which project actually wins.

## Implemented upgrades

- **Real class separation:** instance-owned mass, geometry, yaw inertia, power, gearing, downforce, tyre grip, springs and brakes. Touring transmits torque and differential forces through the front axle. Prototype is lighter with more power/downforce. GT retains Astra's own A1 calibration. Collision impulses now respect unequal masses. These are adapted Astra classes, not claims of physics parity with the sibling engines; prototype hybrid/ERS is not implemented.
- **Class-aware AI:** performance estimates, keyboard assistance and predictive chassis rollouts consume the car's actual specification. Session shares one racing-line/profile object per class, rather than pretending all cars have GT capabilities.
- **Global pace and exit value:** a periodic class-specific envelope propagates braking and acceleration around the full circuit. Harbor candidates price the time to recover exit-speed deficits over up to 450 metres. This improves the planning formulation; it is not a claim of a measured lap-time gain. It is also not equivalent to Claude's full lane/rate dynamic programming.
- **Exact Harbor Ring:** the authored definition is imported unchanged, including control points, width, curbs, sectors, start/grid and pit metadata. Astra's 544 centreline samples match the source geometry within `1.2e-13` metres. Length is 2704.619248914569 m; elevation remains flat. Road surfaces, rubber lanes, recovery thresholds, rendered curbs and timing follow the selected track. Pit metadata is preserved, but no automated pit service system is claimed.
- **Astra waterfront presentation:** instanced container yards, warehouses, crane gantries, moored freighter and animated water; existing PBR road materials, dynamic wetness, shadows and detailed wheels. Distinct Touring and Prototype greenhouse/aero silhouettes. Circuit and class choices are available in the menu and URL.

The remaining biggest gaps are a true lateral-state terminal value function, reachability-aware multi-pursuer defence, and field scheduling/arbitration. This upgrade closes important foundation gaps without claiming that Astra has overtaken every sibling architecture.

## Reproduce and try

Final validation: 85 unit tests pass and the production build succeeds. The fierce Solenne regression records zero off-track time, 17 clean passes and zero severe contacts. The final three-lap mixed Harbor stint finishes in 280.708 seconds, best lap 89.250 seconds, with 0.408 seconds aggregate off-track time, zero damage and zero severe contacts. The minor off-track duration is below the test's one-second limit; this is not a claim of a perfectly clean stint or superiority over another candidate.

Run `npm test`, `node tests/harbor-quality.mjs --check`, and `node tests/harbor-quality.mjs --mixed --check`. Set `ASTRA_LAPS=3` for stints. These validate Astra, not a cross-project ranking. Geometry tests pin the authored Harbor definition and check track dimensions; physical tests check driven axles and unequal-mass momentum conservation.

Phone URLs use `?showcase=1&track=harbor-ring&class=gt&camera=chase`, with `class=touring`, `class=prototype`, or `grid=mixed`. Solenne remains available with `track=solenne`. Once assets load, simulation runs on the phone; initial loading still needs the Tailscale connection, which can drop on a moving train.

Benchmark integration is a separate deliverable. It must import a detached, exact Astra commit from a benchmark-owned clone and translate state only at the host boundary. Existing edited benchmark subjects must remain visible as dirty inputs, not be silently restored or reported as clean pins.
