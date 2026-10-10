# INTERCEPT traffic laboratory

Run from the repository root. Results are local artifacts under `subjects/intercept/results/` and are excluded from Git.

## Three GT3s on Harbor's straight

```sh
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs
```

The GTP starts at road position 20 m and 234 km/h. Three RAZOR GT3s start at 100, 180 and 260 m, at 155 km/h, on their normal line. The default controlled train limits their speed to 169 km/h using ordinary throttle and brake inputs. It does not move or ghost them during the run. Cars have warm softs and enough fuel; pit decisions are disabled for this short fixture.

The benchmark drives the real game, vehicle physics, `async-seats.js`, `seat-worker.js` and INTERCEPT's physics-rate executor. Its Node worker stand-in models message delivery and held controls; it does not measure actual browser scheduling. The native path is available with `--path native`.

The endpoint is 780 m, including the approach to T1. The trace continues for 22 s through the following corners so a fast straight followed by a crash is visible. Use `--end 730` to stop the straight clock before the main braking zone.

The designated stopped/spun obstacle is exempt from marshal rescue so it stays in place for a valid evasion test. Other cars retain the game's recovery behavior, and every rescue is logged. `--rescue` enables ordinary recovery for the designated obstacle too; rescue-assisted clearance cannot pass the fast-evasion gate. Forecast errors across a logged rescue are excluded from the model-error statistics.

Hazard modes also run a matched counterfactual with the same two moving GT3s and the obstacle removed from reachable space. The report distinguishes total loss against solo from the extra loss caused by the obstacle, so time spent passing ordinary traffic is not attributed entirely to evasion. Both measures remain visible.

Each run writes JSON, CSV and a standalone interactive HTML replay. For example:

```sh
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --out my-traffic
node subjects/intercept/tools/serve-traffic.mjs
```

Open `http://127.0.0.1:4180/my-traffic.html`. The server binds only to this computer and serves generated report filenames, without exposing other repository files. HTML files also open directly without a server.

## Useful variations

```sh
# Unrestricted GT3 controllers; no artificial speed limit.
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --mode natural --out natural

# More widely spaced or staggered cars.
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --positions 130,220,330 --out spaced
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --offsets -1.2,1.2,-1.2 --out staggered

# Last GT3 stopped or facing across the road, with the other two still driving.
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --mode stopped --out stopped
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --mode spun --out spun

# Variable worker delay and frame length; only the tested GTP receives the two extra spikes.
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --lagJitter 4 --frameJitter .3 --spikes 2:0.5,6:0.25 --out spikes

# Causal control: same GTP/controller and fast line, with tactical moves disabled.
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic.mjs --follow --out following-only

# Compare drivers against the same three RAZOR GT3s.
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic-matrix.mjs --drivers intercept,razor,apex,next-racer --scenarios train,natural,spikes
```

The default matrix covers train, natural, stopped, spun, staggered and spikes. Additional scenarios are `spaced`, `close`, `fast` and `follow`. `--seeds 7,11,23` expands the matrix. `--speed`, `--gt-speed`, `--limit`, `--time`, `--frameSteps`, `--lagFrames`, `--lagJitter` and `--frameJitter` configure the individual fixture. Values for speeds are metres per second; positions and offsets are metres; injected delay pairs are simulated seconds.

## Measurement definitions

- A clearance requires the GTP's rear to pass the rival's nose, with yaw-dependent projected body lengths. A retained pass stays clear for one uninterrupted second.
- A move needs actual separation from the matched solo trajectory, longitudinal overlap and an executed route other than the fast course. A carried lane uses an already established passing lane. Label changes never count as passes.
- Contact-assisted and incident-assisted outcomes are flagged separately. Contacts after retention do not retroactively change a completed pass, but remain in the full-run safety totals.
- Every traffic run has a matched solo run at the same start position, speed, fuel, tyre state, weather and controller configuration. Delay is compared at equal road position. Tow can make a delay negative.
- `soloEndGap` compares each GT3's position when the solo GTP reaches the endpoint. `reachableAtSoloEnd` is a rough reachability check based on that observed trajectory; drafting and opponent reactions can change it. Faster GT3s farther ahead may be unreachable before T1.
- Speed recovery means at least 98% of solo speed at the same position, with tracking error below 0.75 m. Returning to the original course is a separate measure. A safe hazard clearance can still fail the fast-evasion checkpoint: at most 0.5 s delay at clearance and 1.5 s to recover speed. These are development gates, not proven capabilities.
- `minSideGap` is projected lateral body clearance during longitudinal overlap. It is not the collision solver's full separating-axis clearance. Contact frames are distinct from contact episodes.
- Own contact estimates use simultaneous collision and own-damage changes. Wall damage is separate; severe contacts use the game's 6 m/s collision-normal threshold. Full-field counts are also retained.
- Planner and executor wall times are measured in Node; simulated reply age and injected spikes are reported independently. Browser workers need separate validation.

## Diagnostics and replay

```sh
node subjects/intercept/tools/analyse-traffic.mjs subjects/intercept/results/my-traffic.json subjects/intercept/results/my-analysis.json
node subjects/intercept/tools/replay.mjs subjects/intercept/results/my-traffic.json
node --import ./scripts/json-loader.mjs subjects/intercept/tools/traffic-check.mjs
```

The analysis reports the worst 50 m delays, extra braking compared with solo, throttle lift events, constraint durations, rival forecast errors at 0.5 and 1.5 s, latency injections and damage events. The replay shows actual bodies, road boundaries, executed route, rival forecasts, speed/target/solo plots and pedal history. Scrubbing or clicking an event exposes nose geometry, speed caps, axle reserve, wheelspin, tyre state, candidate scores, public target eligibility and plan age.

The additional camera panel provides body view at true metre scale, road-aligned view, a selected-rival close-up and the whole track. It includes zoom, two-second actual trails, same-time solo/no-hazard ghosts and pair body clearance. Previous/next encounter buttons jump to overlap, clearance and retention; arrow keys step the trace and space plays it. The original expanded lateral view remains available separately.

Generate a review index and regenerate its camera pages:

```sh
node subjects/intercept/tools/review.mjs
node subjects/intercept/tools/serve-traffic.mjs --port 4180
```

Open `http://127.0.0.1:4180/review-intercept.html`. `review.mjs --cases name1,name2` chooses existing result names. It never reruns or changes their recorded simulations.

For actual Chromium module workers, provide Playwright's module path in `INTERCEPT_PLAYWRIGHT` and a Chromium executable in `INTERCEPT_CHROME`, then run:

```sh
node subjects/intercept/tools/browser-traffic.mjs --spikes --out browser-train-spikes
node subjects/intercept/tools/replay-check.mjs --screenshots
```

The browser fixture injects 500/250 ms wall-clock reply delays, drives the ordinary browser seat path and runs a matched solo control. Headless frame cadence is measured, not forced to 60 fps; simulated route age is reported separately. This does not establish performance on every device. The UI check exercises all four cameras, target choice, zoom, encounter bookmarks, keyboard stepping and a narrow viewport.

Existing tools remain available: `probe.mjs` for solo/pack pace, `encounter.mjs` for controlled two-car situations, `race.mjs` for real endurance and strategy, `browser.mjs` for actual browser workers, and `check.mjs --races` for game-system regressions. Traffic performance is one gate; it does not establish qualifying, defensive or endurance superiority.

Use `race.mjs --path worker --trace --trace-period .1 --out endurance.json` to save ten samples per second of stint forecasts, tyre state, fuel, battery, executed pedals and their constraints alongside lap and stop outcomes. The default trace interval is one second. Actual physical road distance is separate from accumulated race progress. This helps distinguish intentional tyre preservation from unnecessary race-pace loss.

Every endurance run records peak damage, cumulative damage gained, actual solver contact frames/episodes, peak collision closing speed and the steward incident log. Pit repair can clear finish damage, so finish damage alone must never be used as a clean-race verdict. Contact episodes split after 0.25 s without that pair; contact frames remain available separately.

`race.mjs --energy-stock` provides an energy-policy A/B for INTERCEPT alone. The result records the selected policy; trace rows include hybrid power, mode and intent for every car. This is a diagnostic switch, not a production tuning change.

`race.mjs --follow` disables INTERCEPT tactical paths; `--kinematic` selects the simpler kinematic rival forecast. `traffic.mjs --separation` changes its requested clearance for diagnostics; new GTP-to-GT3 passes retain a production minimum of 3.3 m. These switches are reported in result metadata and are not alternate production defaults.

The two-car encounter fixture initializes pose from road distance, preserving speed while setting heading, and initializes the game's `previousS` progress field. Stopped/spun/off-road obstacles stay in place by default; `--rescue` restores normal marshal recovery. Older encounter measurements made before these fixture corrections must be reproduced before being used as evidence.
