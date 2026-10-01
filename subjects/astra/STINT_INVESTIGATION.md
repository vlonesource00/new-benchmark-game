# Phone showcase regression investigation

8 September 2026. User screenshot: P6/6, race 257.208 s, best lap 83.733 s.

## Findings and fixes

1. **Hidden paths were a UI regression.** The previous update defaulted to focused battle paths. All candidate/rejected paths, response branches and control rollouts now show by default. Focused mode remains optional. On-track defensive callouts identify the rear rival, closing speed/time, current defensive response, and predicted rear position. An orange gate marks the selected corridor at the forecast time and an arrowhead shows rival motion; neither guarantees that a position can be held.

2. **The gap display was not an actual time interval.** It divided leader distance by each trailing car's instantaneous speed. Braking therefore enlarged the displayed seconds even without equivalent separation. The display now interpolates when the leader crossed the follower's current race distance, using recorded progress/time samples and the live leader position. Finished-car intervals use finish times. Unknown history displays a dash instead of an invented interval.

3. **Automatic restarts retained track rubber.** Cars and drivers reset while the track kept evolving across demonstrations. My prior first-race test did not cover that state. In three consecutive old-policy runs, race times were 253.125, 250.433 and 250.975 seconds; best laps were 82.408, 80.042 and 81.375 seconds. This demonstrates varying restart conditions, but does not reproduce the exact screenshot. Showcase starts now explicitly reset rubber; rubber still evolves during each race. Ordinary session restart policy, weather and setup are preserved.

4. **Finished cars were instructed to stop on the racing surface.** A permanent 25% brake command could create an obstacle ahead of cars still finishing. Finished AI cars now continue steering at a restrained cooldown pace. In this default scenario the timing gain is only 0.017 seconds, so this is not the main explanation for the user's slower race.

5. **The earlier solo comparison used a different driver skill.** The pace benchmark forced 0.976, while the red showcase car is configured at 0.952. Its benchmark default now uses the actual driver setting; `SKILL=0.976` still reproduces the historical calibration. With matched 0.952 skill, fresh solo laps are 82.717, 77.942 and 79.583 seconds. A solo lap is still not directly comparable with a grid race.

## Why the field separates

The current six-car race evidence shows the red car's rear cores at approximately 87–90°C at lap two. Thermal freedom is still 100%, wear is below 0.04%, but its pace calibration blend remains capped at 35% because of traffic. The leader in clear air uses approximately 96%; another clear-air rival uses 100%. Red lap two is 82.408 seconds versus the leader's 77.792 seconds. Real distance separation grows from about 45 m after red lap one to 292 m after red lap two.

The 35% value is **a blend between conservative and faster calibrations**, not 35% throttle or 35% maximum speed. The red car also has the joint-lowest configured skill (0.952); competitors range up to 0.976. Heat becomes a greater limitation later, but does not explain the lap-two separation in this run. The engineer's pace-mode label now identifies the dominant cap correctly rather than labelling thermal management whenever thermal freedom drops below 80% despite a lower traffic cap.

The remaining issue is the traffic pace policy and its interaction with unequal driver strength. No skill boost, artificial catch-up, force/grip change or blanket aggression increase was applied. Earlier attempts to release more traffic pace caused race regressions; this investigation does not claim that performance problem is solved.

## Verification

- 69 unit/integration tests pass, including interval interpolation, fresh-track policy and finished-car controls.
- Both eight-car 240-second quality contracts pass unchanged: normal 14 clean passes, 0 off-track time, 0 severe contacts; fierce 27 clean passes, 0.42 off-track vehicle seconds, 0 severe contacts.
- Two consecutive fresh-track showcase runs match: P3, 253.108 seconds, best lap 82.408 seconds. Red car damage/off-track time are zero; whole-field off-track time is 0.20 seconds, with zero damage and severe contacts.
- Build succeeds with the existing bundle-size advisory.

The exact Android P6/257.208/83.733 result has **not** been reproduced. Retained rubber explains differing test conditions, but is not proof of that exact outcome. Cross-device numerical sensitivity or another run-state difference remains possible. Slower rendering can slow wall-clock progress, but the simulation uses fixed 120 Hz steps; low FPS alone is not established as the cause of a slower simulated lap.

Evidence: `artifacts/stint-before.jsonl`, `stint-after.jsonl`, `stint-showcase-after.json`, `stint-solo-matched.json`, `stint-tests.txt`, `stint-field-normal.json`, `stint-field-fierce.json`. The pre-investigation simulation is archived at `artifacts/stint-baseline/src/sim`.

```powershell
npm test
npm run test:showcase
npm run test:racecraft
npm run test:racecraft:fierce
$env:FRESH_TRACK='1'
$env:REPEATS='2'
node tests/stint-diagnostics.mjs
```
