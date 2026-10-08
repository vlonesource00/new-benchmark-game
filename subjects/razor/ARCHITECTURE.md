# RAZOR — committed corridor attacker

RAZOR is a separate driver for GTP and GT3. Its primary acceptance criterion is useful, smooth attack conversion against close rivals. A fast lap, a strategy win, or an ATTACK label does not establish that a maneuver made a pass.

## Baseline and ownership

Game base: `origin/graphics-aaa` / `origin/main` at `86d3005` (8 October 2026). Development branch: `razor-architecture`, isolated checkout `razor-dev`. Existing APEX working edits are outside this checkout.

Reuse APEX's identified vehicle model, baked line assets, gear-aware speed profiles and pace tracker through imports. RAZOR owns its traffic field, corridor generation, maneuver decisions, commitment, tyre policy, debug labels and strategy installation. It never changes another driver's configuration, the physics, or track-limit rules.

## Attack first

- Follow the fast lap geometry while no reachable opportunity exists.
- Track the moving rear/wake of a useful racing target. Leave the tow at the latest feasible pull-out time computed from closing speed and reachable lateral separation.
- Evaluate a small set of inside, outside, hold and return corridors. Fit moves to real available width and current lateral motion; do not run fixed scripts.
- Share the selected corridor between steering, acceleration and nose clearance. Side overlap and gentle rubbing are graded costs, not automatic braking vetoes.
- Commit to the chosen side through approach, overlap and clearance. A slightly different score cannot flip sides. A closed corridor triggers a continuous escape or return from the current pose.
- Defense is one smooth cover followed by a sustained lane and exit acceleration. GTP/GT3 class differences matter; do not defend against irrelevant faster-class traffic.

## Traffic and pits

Stopped, spinning, crashed, finished and much slower road cars are obstacles. Evade through reachable open space before braking is necessary. Brake for a directly blocked nose when lateral escape cannot be completed in time; normal grip-limited corner braking remains.

Pit entrants are not racing or drafting targets. They remain obstacles until physically off the racing road. Pit-lane/service cars are excluded. Rejoining cars are considered when they approach the road. Retired cars still occupying the road remain obstacles.

## Execution and resource use

Corridors start from measured lateral position and motion, with continuous joins. Steering has bounded lateral jerk. Recovery labels require sustained measured loss of control rather than a one-frame change of path reference.

Control combined driven-wheel slip near the useful force range and tighten unnecessary slip as heat/age rise. Reuse the lap geometry, adapt available drive/braking and the intended stint. Target Harbor peak laps below 53 s GTP / 64 s GT3, and no more than 4 s fade to the planned pit window, after combat acceptance.

## Cost and evidence

No native Vehicle rollouts in the hot combat path and no wall-clock search cutoff. Reuse lane buffers, retime local windows, and use a bounded road-space prediction horizon. Measure controller work separately from worker transport/debug serialization.

Debug shows target eligibility, chosen corridor/side, direct-nose cap, wake pursuit, entry/overlap/exit commitment, hazard evasion, candidate rejection reasons and actual pass associations. Runtime associations are not causal proof.

Acceptance uses the real race loop and actual seat worker: directly blocked fast trajectory, close same-class fights, both sides, outside against inside defense, packed slower traffic, stopped/spinning hazards, pit entrants/lane cars, delayed control updates, and endurance. Paired attack-enabled/disabled runs start from the same state and opponent policies to identify maneuver-dependent passes. Report incidents, contacts, steering changes, traffic time loss and latency percentiles alongside conversion.

## Development status

Foundation in progress. No combat superiority or endurance certification claimed.
