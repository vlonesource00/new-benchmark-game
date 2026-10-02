# SOLSTICE

A game-specific driver for Phantom Endurance. It optimizes a periodic line for
each circuit, computes braking and acceleration envelopes from live tyres,
and evaluates traffic trajectories with the game's own Vehicle physics.

Developed against upgraded-game commit `2935523`. The pace target is normal
GT / soft / 20-lap Harbor running near 62.5 seconds, with no more than four
seconds of measured stint fade. `RESULTS.md` distinguishes achieved AI laps,
complete races, and analytical paired schedules using a human's assumed
65-second average. Universal mixed-field dominance is not established.

The final isolated Harbor run completes 20 laps with a 62.033-second best lap
and 2.708 seconds of hard-stint fade, with zero off-track time, contacts,
rescues, or controller errors. Full held-control runs at 20 and 30 Hz also
complete without those failures and achieve clean laps below 64 seconds.

## Run

From the repository root, with Node 24 and the repository dependencies installed:

```sh
npm run game:build
node subjects/solstice/tools/serve.mjs
```

Open http://127.0.0.1:4175, choose SOLSTICE as co-driver, and select ALIEN.
Team Principal lets the AI drive immediately. Press B to see intent, target
speed, worker latency, and the gold aim-point ring.

```sh
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/check.mjs
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/bench.mjs --driver solstice --track harbor-ring --teams 4 --laps 6 --seconds 1800 --seed 7 --weather clear --sun .6 --output subjects/solstice/results/example.json
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/bench.mjs --field astra,phantom,phantom-v2,gemini-supreme-v4,solinator-6.1,solstice --track harbor-ring --teams 6 --laps 6 --seconds 1800 --seed 7 --weather clear --sun .6 --output subjects/solstice/results/example-mixed.json
```

The local JSON loader accommodates the existing Solinator JSON imports under
Node 24. It does not change another driver's source or the game simulation.

## Configuration and diagnostics

`config.json` contains driver settings. The bridge merges its `options` over
that file. Node experiments can set `SOLSTICE_OPTIONS` to a JSON object; nested
`path` and `policy` overrides merge independently. Each layer can also include
`tracks[trackId]` overrides. Harbor uses its own curvature sampling; all four
GT lines are saved in the small runtime asset `data/lines.json`. Per-circuit
policy settings balance corner speed, tyre energy and lateral transfers.

`bench.mjs` runs the normal EnduranceRace with the normal resources, strategist,
governor, mandatory pit stop, and driver swap. It records source hashes and the
actual overrides. `cadence-bench.mjs` additionally tests held controls at a
specified update rate; this is a deterministic transport approximation, not a
measurement of browser worker throughput. `station-probe.mjs` explains speed,
slip, tyre work, and governor losses by 100-metre track section.

PowerShell can pass probe configuration without native JSON quoting problems:

```powershell
$env:SOLSTICE_PROBE = '{"seconds":180,"output":"subjects/solstice/results/example-probe.json"}'
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/station-probe.mjs
```

`ARCHITECTURE.md` describes the model and its limits. `RESULTS.md` is the
acceptance record; short development probes do not establish race dominance.

## Integration scope

The only existing-driver integration edits are registrations in field.js,
teams.js, ai-worker.js, and remote.js. The user additionally approved one line
in async-seats.js to forward the worker's existing debug trackingPoint to the
3D lens. That local patch and large raw diagnostics are excluded from Git;
`results/compact-summary.json` carries the public measurements.
The roster gives SOLSTICE `manage: false` and `governor: false`. race.js skips
its governor only when the native base difficulty is ALIEN; AI-only teams at
lower levels retain the normal difficulty cap. Human-containing teams keep
the upstream game's base-difficulty semantics. Other drivers retain their
upstream governor behavior. SOLSTICE manages wheelspin through its controls,
and the car's built-in traction control still acts. Upstream difficulty.js is
unchanged. The driver writes only controls; game physics, resources, timing,
strategy, and other AI implementations remain unchanged.

## Paired race estimate

```sh
node subjects/solstice/tools/pair-model.mjs subjects/solstice/results/example-stations.json --output subjects/solstice/results/example-pair.json
```

This tool alternates human and AI stints at every stop, charging the measured
in/out-lap loss once; that loss already includes fuel, tyres and the driver
swap. It compares two through five stops and human stint-length assumptions.
Extra stops are allowed when they reduce combined time. Human fuel reach and
tyre performance are unmeasured assumptions. The tool neither simulates human
controls nor changes the game's strategist or race results.
