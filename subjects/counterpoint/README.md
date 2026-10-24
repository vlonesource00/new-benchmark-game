# COUNTERPOINT

Non-RL racing AI. No neural network, no learned policy, no GPU.

COUNTERPOINT decides every move by **playing the next seconds of the fight forward through the game's own
physics** — its own car and the rivals around it, together, with the game's slipstream (`wakes`) and collision
code (`collisions`) — and choosing the move that comes out best. Earlier architectures (VANGUARD, INTERCEPT, ORACLE,
and COUNTERPOINT v1, now in `legacy-v1/`) forecast rivals with a point-mass or kinematic model and then vetoed any
lane that put two cars into the same space. That makes equal-pace passing, elbowing and contact-tolerant
side-by-side racing unreachable by construction. Here nothing is vetoed: a move that touches is priced by the damage
the game's collision actually gives it.

## Layers

| File | Role |
|---|---|
| `src/pilot.js` | How to drive: ORACLE's tuned path and pedal controller with ORACLE's racecraft removed. Takes a command `{lateral, cap}`: a lane in metres right of the racing line and an optional speed cap. |
| `src/follow.js` | The follow rule: the speed a car may carry toward the car ahead in its path and still stop behind it. |
| `src/rivals.js` | What is known about each rival: its station and lane on its class's line, its pace against that line, and its lane at each station on earlier laps (its habit). |
| `src/rollout.js` | Joint rollout: copies of COUNTERPOINT and up to three rivals stepped together through `Vehicle.step`, `wakes` and `collisions`, each driven by a pilot copy. |
| `src/planner.js` | The candidate moves (the line, the lane held, either side of each rival, following or pressing) and their value in metres of race. |
| `src/driver.js` | Ties it together: observe, plan every `period` seconds when rivals are near, drive the chosen move. |

The live car runs the same pilot and the same follow rule as its rollouts, so a plan is executed exactly as it was
simulated. Rivals in a rollout are pilot copies at their learnt pace, holding their habitual lane and following
the car ahead of them; the best few moves are also played against a rival that **covers** (moves a car's width
toward COUNTERPOINT when it is close behind). A move's value is the worse case weighted as much as the average.

## Value of a move (metres of race)

`progress + 0.8 s × (speed − profile speed at the end) + 10 per place won − 12 per place lost
− 4000 × damage − 30 per severe contact − 1.5 per rub − track-limit time × 150 − slide`

Damage is the game's own damage from the simulated contact (1% damage = 40 m), so a light elbow while
side by side can be worth it and a rear-end never is.

## Strategy

The same stint model as ORACLE (INTERCEPT's strategist), so races against ORACLE differ in racecraft only.

## Benchmarks

From the repository root:

```powershell
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/traffic.mjs --driver counterpoint --class gt --seed 53
node --import ./scripts/json-loader.mjs subjects/counterpoint/tools/traffic.mjs --driver oracle --class gt --seed 53
node subjects/counterpoint/tools/summary.mjs traffic-
```

`traffic.mjs`: two subject cars start behind six governed real rivals (INTERCEPT, RAZOR, APEX, TEMPEST,
SOLSTICE) on Harbor Ring, 4 laps, hard tyres, rolling start; finish time, time stuck behind a car, retained passes,
damage, incidents and track limits.
