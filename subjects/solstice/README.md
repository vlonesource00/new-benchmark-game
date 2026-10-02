# SOLSTICE

A game-specific driver for Phantom Endurance. It optimizes a periodic line for
each circuit, computes braking and acceleration envelopes from live tyres,
and evaluates traffic trajectories with the game's own Vehicle physics.

The current implementation is an experimental candidate. Harbor has measured
62.642 and 64.600-second clean laps before its first pit in GT / soft / 20-lap
conditions, with zero off-tracks, rescues and bridge errors over a 500-second
probe. Later stints and mixed-field dominance still need validation. See
RESULTS.md for measured outcomes and remaining gaps.

## Run

From the repository root, with Node 24 and the repository dependencies installed:

```sh
node subjects/solstice/tools/build.mjs
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
GT lines are saved in the small runtime asset `data/lines.json`.

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
The user subsequently authorized governor changes. This pre-port build lets
every AI manage its own tyre pace on ALIEN; `MANAGE_ALIEN=true` restores the
original thermal cap in headless comparisons. Wheelspin and weather protection
remain active. The driver writes only controls; game physics, resources,
timing, strategy, and other AI implementations remain unchanged.
