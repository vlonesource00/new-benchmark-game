# SLIPSTREAM

Learned racer that drives the car directly (steer + signed pedal) inside the real game race loop.
No scripted executor, no route-offset layer, no physics port.

## Environment (`env/`)
- `race-env.mjs` builds the game's own `EnduranceRace` (core/race.js) with a custom `makeBridge`: learner seats
  read an action buffer, every other seat is the game's real driver bridge (INTERCEPT, APEX, RAZOR, ...).
  Weather, water, rubber, fuel, tyre wear, hybrid, collisions, stewards and track limits all run as in the game.
- `world.mjs` wraps one race: command delivery with game-like reply latency (1-6 physics ticks, occasional
  8-30 tick replies, dropped replies hold the last controls), observations, rewards on the game's rules, and
  episode resets (reached-state snapshots, perturbed placements, standing starts). Learner pit calls are cleared.
- `worker.mjs` steps many worlds in lockstep with the learner over binary stdin/stdout pipes.
- Checks: `determinism.mjs` (bit-identical reruns), `isolation.mjs` (a world is unaffected by its neighbours),
  `bench-race.mjs` (race-loop throughput).

Observation (296 floats): ego dynamics + applied controls, their age, last sent action and pending flag (48);
24 road samples reaching 60 + 4.2·v metres (ego-frame centreline, heading, curvature, water); 8 nearest rivals
(ego-frame position/velocity/yaw, gap, lateral, speed, damage, ghost, learner flag) with a presence mask.

Reward: progress while legal (game track-limit rule), off-track entry/tick penalties, damage priced per unit,
terminal penalty on wreck / 2 s off track / backwards / stuck.

## Learner (`learner/`)
- `model.py`: ego MLP, road MLP, rival attention (with null token) -> GRU 256 -> Gaussian steer/pedal;
  critic on the same features plus the actor's memory.
- `ppo.py`: recurrent PPO baseline (swappable; QR-SAC to be compared once driving works).

## Measured (2026-10-14, 16-core / RTX 5060 Ti, BelowNormal)
- Race loop, 8 learner cars: ~110-125k car-steps/s per core. Spearhead seat: 0.6x real time (eval only).
- Full learning loop, 6 workers x 12 worlds x 4 learners: 16.6k agent-steps/s (rollout 0.42 s / 18.4k steps,
  update 0.69 s).

## Milestones
1. Legal, competitive learned laps under realistic reply delay on all five tracks (APEX lap as the target).
2. Traffic and duels vs real INTERCEPT / APEX / RAZOR (beat INTERCEPT 1v1), solo/recovery kept in the mix.
3. Full grids, both car classes, stints; strategy heads (hybrid mode, pit/tyre); browser-worker promotion runs.
