# COUNTERPOINT

Experimental non-RL racing challenger. No reinforcement learning, neural network,
policy checkpoints or GPU training is used by this driver.

COUNTERPOINT reuses VANGUARD v2's course geometry, observer, physical vehicle
controller, hazard recovery and stint strategy. It owns a separate tactical
module and a narrowly scoped frontal-guard extension. Existing racers and the game's physics are unchanged. It is registered
for explicit benchmarks and excluded from automatic race grids pending acceptance.

## Tactical design

While following, evaluate a bounded corridor fan against candidate-dependent
hold-line, delayed-cover and mild-braking hypotheses. Every option uses the same
time horizon, with moving rival forecasts through the full horizon. The response
hypotheses are bounded engineering assumptions, not calibrated probabilities or
learned opponent policies. Observation counts in the debugger are diagnostic only.

Admission can use full clearance, useful overlap or a sustained setup advantage,
with body-risk and continuation checks rather than a zero-contact requirement.
An already admitted baseline attack keeps its commitment, rather than repeatedly
switching back toward the ideal solo line. Hazard handling, owned side-by-side
space, defence and safe returns retain the established controller protocol.
Response trajectories retain accumulated lateral displacement and braking
distance through overlap; their headings follow their actual lateral motion.

The frontal-guard extension can preserve closing speed before lateral motion
has developed when an already tracked passing corridor demonstrates body
clearance before impact. It rejects braking rivals, hazards, poor path tracking
and low grip reserve. The normal guard still sees all uncertified blockers;
steering, axle allocation and physical contact remain in the shared controller.

The planner caps additional work at 12 candidates, three response branches and
six seconds of forecast. Interactive search runs no more often than every 0.15
simulated seconds. The live executor follows stamped route replies at physics
rate (normally 120 Hz), so steering feedback does not wait for a tactical search.

`interactive:false` selects the original tactical and control implementations
for matched baseline comparisons. `routeEscape:false` disables only the added
frontal-guard extension.

The experimental driver now enables these tested mechanisms by default. Explicit
overrides remain available for controlled comparisons:

- `stagedAttacks:true`: a useful safe overlap can start a move before a full
  pass is forecast. It does not count that overlap as a completed pass.
- `setupAttacks:true`: a useful gap-closing move may start before overlap, with
  positive continuation and low risk in every modeled reaction branch.
- `commitWindow:.35`: tolerate a short forecast setback only while the existing
  route continues to pass a fresh near-term body-risk check. Hazards and impacts
  bypass this delay; persistent failure ends the window.
- `coastRecovery:true`: stop applying drive when an outward-growing path error
  consumes lateral correction capacity on the clear-air pace route. It is
  disabled near physical rivals and during combat/returns. Brake and steering
  commands are preserved; control memory follows the removed drive. GTP lift-off
  regeneration may still decelerate the car through the game's existing rules.
- `contestSpace:true`: keep the commanded line when the existing race damage
  budget and contact geometry approve holding a contested door. Hard squeezes,
  road-edge conflicts and return merges retain the ordinary avoidance.
- `smoothReturns:true`: continue the gradual return corridor until actual
  movement is aligned with the pace route, rather than switching routes while
  the car is still crossing that line sideways.

Before publishing a tactical corridor, Counterpoint checks the final joined
geometry against the road, including near-edge segment midpoints. It preserves
kerb use while reserving tracking room. A rejected route keeps the prior
corridor and starts a gradual return; it does not snap to the pace line. The
previous route stays reserved while candidates are constructed. Unchanged pace
segments keep their established geometry. This checks the final path, because
bounding raw offsets before smoothing does not bound the resulting world path.

Harbor Ring, Solenne and Desert use a measured 1.5% GT grip-spend allowance
increase. The inherited resource rules disable that extra allowance in wet
conditions or on substantially worn tyres. Other tracks retain their previous
allowances. This does not establish the fastest possible racing line.

An ordinary merge resets the maneuver without clearing opponent observations,
search cadence or race-level counters. A driver restart calls `resetEpisode()`
to clear those values. Worker planner diagnostics are exposed under
`debug.planner.interactive`; the live executor does not run that search.

## Verification

From the repository root:

```powershell
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/integration.mjs
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/campaign.mjs --phase deep --tag trial
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/campaign.mjs --phase grip --tag trial
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/campaign.mjs --phase acceptance --tag acceptance-trial
```

The campaign runs one low-priority child process at a time. It stores commands,
logs and source fingerprints in `results/`. Shared game-scored race, solo and
combat reports remain under `subjects/vanguard/results/`.

`tools/latency.mjs` measures computation and request-to-reply time using the real
seat module in a Node worker thread. It includes structured cloning and separates
cold initialization. It does not measure browser rendering, frame scheduling or
simultaneous full-grid worker contention. Lockstep race tests model reply delays
in frames independently of measured computation cost.

No universal performance claim is made from prepared encounters. Final acceptance
requires joint pace, retained-pass, reliability, damage and latency evidence.
The completed review and exact reports are catalogued in [RESULTS.md](RESULTS.md).
ORACLE still wins the latest matched fields. The updated behavior is enabled
for explicit COUNTERPOINT tests; the challenger remains off regular grids.
ORACLE is the primary traffic reference: matched rear-start races report finish
time, stuck time, actual retained passes, damage and cuts as well as prepared
encounters. Light rubbing is reported separately from severe contact. Each
subject's safety counters freeze at its own finish, and retired or finished
rivals cannot create new pass counts.
