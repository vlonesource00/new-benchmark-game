# SOLSTICE

A game-specific driver for Phantom Endurance. It optimizes a periodic line for
each circuit, computes braking and acceleration envelopes from live tyres,
and evaluates traffic trajectories with the game's own Vehicle physics.

Developed against upgraded-game commit `2935523`. The pace target is normal
GT / soft / 20-lap Harbor running near 62.5 seconds, with no more than four
seconds of measured stint fade. `RESULTS.md` distinguishes achieved AI laps,
complete races, and analytical paired schedules using a human's assumed
65-second average. Universal mixed-field dominance is not established.

The graphics-base verification retains a 62.033-second best lap in a complete
isolated 20-lap Harbor race, with 2.833 seconds of hard-stint fade and zero off-track
time, contacts, rescues, or controller errors. Controlled straight passes take
3.175 and 3.925 seconds instead of about eight. Defense can retain a physically
clear leading trajectory, avoiding the unnecessary corner slowdown reproduced
under close rear pressure. The existing line, tyre, and pace settings are unchanged.
The two Changeable races expose wet-weather contacts and pit-lane recoveries;
their findings are recorded in `RESULTS.md` without retuning the driver.

## Run

Development work currently starts from `origin/graphics-aaa`. Fetch and rebase
onto that branch before starting and before pushing, and target PRs at
`graphics-aaa` until its merge into `main` is confirmed. Keep public commits
authored as `vlonesource00 <vlonesource00@users.noreply.github.com>`.

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
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/combat-probe.mjs --hz 30 --seconds 10 --output subjects/solstice/results/example-combat.json
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
`combat-probe.mjs` compares free running with controlled passing and defending
encounters on native vehicle, wake, tyre, and collision physics. Its initial
placements and warm tyre state are fixtures, and its rival uses a fixed lane
and speed cap; these are targeted regressions, not complete races. The
`--case native-corners` option reproduces an encounter in the first 80 seconds
of the normal SOLSTICE/Gemini race.
`duel-probe.mjs` adds eleven encounters between two independent SOLSTICE drivers.
Both choose their own lanes and speed after initialization, and each is also
measured in free air. A completed pass requires a twelve-metre lead sustained
for a second; the matched-pace case is a control, not a guaranteed opportunity.

```sh
node subjects/solstice/tools/duel-probe.mjs --hz 30 --seconds 20 --output subjects/solstice/results/example-duel.json
```

`weather-probe.mjs` observes native Changeable races, recording wet/dry fronts,
box calls, services and lap weather without changing controls or strategy.

```sh
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/weather-probe.mjs --track harbor-ring --laps 12 --seed 7 --seconds 1800 --output subjects/solstice/results/example-changeable.json
```

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
