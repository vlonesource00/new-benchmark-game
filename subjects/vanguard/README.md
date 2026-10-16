# VANGUARD

VANGUARD continues Argon's driver. It keeps the original force controller, asynchronous worker planner, spatial C2 corridor contracts, connected traffic routes, hazard forecasts and resource strategist. It is selectable as `VANGUARD` in the game's driver roster.

## How it drives

- **The host controller runs every physics substep.** It steers and allocates throttle/brake from current vehicle and rival state, while a slower worker chooses routes. A late worker reply does not freeze local feedback.
- **The worker plans connected corridors.** It considers passing lanes, chained traffic routes, defended-corner switchbacks and returns to the racing line. Routes carry an epoch and sequence; stale, duplicate and non-finite contracts are rejected.
- **Immediate hazards have a local response.** Stopped and spun cars use inertial forecasts rather than being treated as ordinary moving targets. Pit-lane cars remain outside the physical avoidance set.
- **The pace model adapts.** Local water depth, wet rubber and tread wear affect the speed and braking envelopes. Clean-air slip evidence adjusts station trims, while dirty air and nearby rivals cannot teach the clean-air pace model.
- **Reduced-grip GT braking keeps more lateral reserve.** The dry reference model was too optimistic under simultaneous braking and turning in rain or on heavily worn tyres. Both the base line and combat corridors use the corrected combined-force forecast; fresh dry tyres keep the original pace settings.
- **Wet geometry changes are staged.** A candidate follows shallower wheel tracks, changes gradually, and is accepted only when the paired speed-profile calculation predicts a gain on the same surface snapshot. The active geometry and speed profile swap together.
- **Short arrival prediction uses the real vehicle integrator.** The worker predicts a measured reply delay with the game's unchanged `Vehicle.step`, using private mutable car and surface buffers. Wake stays at its observed value. Longer tactical rollouts still use Argon's approximate planner model.
- **Strategy remains separate from route control.** The existing pit, tyre, fuel and hybrid/resource logic is retained.

The continuation also fixes the reproducible collision while returning alongside a defending rival. The driver yields enough longitudinal room before merging; it does not brake in front of a car it has already cleared.

## Run checks

Run commands from the repository root with Node 24 or the project's supported Node runtime:

```powershell
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/encounter-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/traffic-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/predict-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/surface-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/learning-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/maneuver-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/attack-check.mjs
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/setup-check.mjs
```

Run the game-scored solo matrix, including both car classes and all five tracks:

```powershell
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/matrix.mjs --profile dry
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/matrix.mjs --profile wet --start standing
node --import ./scripts/json-loader.mjs subjects/vanguard/tools/matrix.mjs --profile worn --start standing
```

`probe.mjs` also accepts rival grids (`--ids`), individual classes (`--classes`), worker delays, seeds, live strategy (`--strategy`), and optional traces (`--trace 0.2 --out trace.json`). Use `--race-laps 3` for an actual three-lap race and its finishing classification; `--lap-target 3` on its own is a lap collection cutoff, not an official three-lap race result. Traces include worker candidates as well as host controls. They can be large; generated results stay local and are ignored by Git. `matrix.mjs` writes a report after each case and records its source/harness hashes and game revision.

For actual WebWorker and host-controller timing in a browser:

```powershell
node ./node_modules/vite/bin/vite.js --config subjects/vanguard/tools/browser.vite.mjs
```

Open `http://127.0.0.1:4192/subjects/vanguard/tools/browser.html` and run the checks. This fixture runs the real race loop and workers without a 3D renderer, so it measures controller/transport cost rather than whole-game frame rate.

## Read the results correctly

See [RESULTS.md](RESULTS.md). Three clean laps on one seed demonstrate a working case, not a statistically established reliability rate. Same-pace combat remains a limitation: successful scripted encounters do not establish a full-field advantage. The explicit switchback candidate is implemented and geometry-tested, but it has not yet demonstrated a race-level benefit.

The speed solver and controller still allocate objects. Zero-GC operation, complete exact-physics tactical rollouts and dominance over the other racers are not established claims.

The original 24 Argon files were preserved before continuation in the workspace's `vanguard-audit-2026-10-16/argon-baseline/` directory. Original audit results and corrected continuation results are kept separately. Reports made before `post-start-setup-v2` fitted tyres before the race reset them, so their requested compound/wear labels must not be used as condition-specific evidence.
