# APEX results

All numbers come from the repo's own tools under `subjects/apex/tools/`, through the real `EnduranceRace`
loop (stewards on, difficulty 1, 120 Hz), medium tyres from a standing start, one car alone on track. Lap 1
is the standing start; "best" and "mean" are over the flying laps only (laps 2..N). The strategist's stop
decision is disabled inside the measured laps (`e.strategist.decide = () => null`), so no stop lands in them.
Deterministic: same command, same numbers.

## M0: baselines and wiring

Command: `node --import ./scripts/json-loader.mjs subjects/apex/tools/baseline.mjs` (6 laps on the four
short circuits, 3 on the Nürburgring). Raw per-lap data: `data/baseline.json`. `(Nx)` = steward incident points.

| Track | Class | SPH best / mean | SLC best / mean | CRV best / mean |
|---|---|---|---|---|
| Harbor Ring | GTP | 53.83 / 56.80 | 54.76 / 57.41 | 54.41 / 57.00 |
| Harbor Ring | GT3 | 63.79 / 64.89 | 63.29 / 65.61 | 64.08 / 65.28 |
| Solenne | GTP | 51.27 / 55.51 | 51.67 / 54.52 | 52.09 / 54.84 |
| Solenne | GT3 | 61.21 / 64.19 | 61.91 / 64.27 | 63.25 / 64.60 |
| Alpine | GTP | 62.92 / 71.18 | 67.73 / 70.47 | 63.68 / 68.90 |
| Alpine | GT3 | 74.70 / 78.99 | 80.07 / 81.19 | 76.18 / 79.09 |
| Desert | GTP | 67.03 / 70.59 | 70.77 / 72.02 | 67.43 / 70.72 |
| Desert | GT3 | 80.76 / 82.73 | 83.57 / 83.79 | 80.36 / 81.81 |
| Nürburgring | GTP | 508.43 / 517.83 (4x) | 494.33 / 497.79 | 500.57 / 502.52 (4x) |
| Nürburgring | GT3 | 560.27 / 565.49 (4x) | 554.58 / 558.44 | 632.84 / 659.81 (55x) |

Findings that shape the work:

- **SPH is the pace reference** on 7 of the 8 short-circuit rows; SOLSTICE leads GT3 Harbor, CRV leads GT3 Desert.
- **Tyre heat dominates the Nürburgring.** Lap 1 (cooler tyres) is the fastest lap of every AI: SPH GTP 462.98 s,
  then 508.43 s on lap 2 (+45 s, 10 %) as the core temperature climbs from 130 to 144 °C against a medium optimum
  of 90 °C. SOLSTICE fades 466 → 494 s, CRV 484 → 500 s. Holding the tyres in their window on a 25 km lap is worth
  several percent, more than any line or racecraft detail there.
- The short circuits fade 2–4 s from best to mean over 5 flying laps for every reference AI (SPH 53.83 best / 56.80 mean
  on Harbor GTP). That is the stint-management gap the planner targets.

### Wiring

Registration is opt-in and inert for every other driver (see ARCHITECTURE.md section 0): roster entry, GTP pool,
`createSeatBridge` case, `apexState` (P3), `car.intent` in `hybridStep` (P2), strategist install hook (P1, stub).
APEX loads and drives through `EnduranceRace` (`tools/solo.mjs`, `tools/lap.mjs`); the seat-worker path is exercised
from M1 onwards.

## M1: pace core

What is built: a g-g-v model identified on the real `Vehicle` per class (`tools/identify.mjs`), a minimum-time line per
track and class on a free-form corridor with a lateral-jerk limit (`tools/bake.mjs`, `data/lines.json`), a quasi-steady-state
speed profile that follows live tyre grip, a curvature-preview tracker with steady-state-sideslip countersteer, a friction-circle
pedal law, a traction governor, a tyre-slip protective layer, one-frame-delay pose prediction for seat workers and in-lap pit
guidance. Run time per update (`tools/cost.mjs`): median 4 µs on Harbor and 1.5 µs on the Nürburgring, p99 40 µs and 14 µs;
the only spikes are the speed-profile rebuilds when tyre grip moves (max 5 ms Harbor, 19 ms Nürburgring).

### Solo pace, same protocol as M0 (6 laps, Nürburgring 3)

Command: `node --import ./scripts/json-loader.mjs subjects/apex/tools/baseline.mjs --ais apex`. Best / mean of the flying laps, seconds.

| Track | Class | SPH best / mean | SLC best / mean | CRV best / mean | APX best / mean |
|---|---|---|---|---|---|
| Harbor Ring | GTP | 53.83 / 56.80 | 54.76 / 57.41 | 54.41 / 57.00 | 53.16 / 56.30 |
| Harbor Ring | GT3 | 63.79 / 64.89 | 63.29 / 65.61 | 64.08 / 65.28 | 62.60 / 64.94 |
| Solenne | GTP | 51.27 / 55.51 | 51.67 / 54.52 | 52.09 / 54.84 | 51.03 / 53.66 |
| Solenne | GT3 | 61.21 / 64.19 | 61.91 / 64.27 | 63.25 / 64.60 | 60.43 / 62.72 |
| Alpine | GTP | 62.92 / 71.18 | 67.73 / 70.47 | 63.68 / 68.90 | 61.85 / 67.45 |
| Alpine | GT3 | 74.70 / 78.99 | 80.07 / 81.19 | 76.18 / 79.09 | 73.38 / 78.20 |
| Desert | GTP | 67.03 / 70.59 | 70.77 / 72.02 | 67.43 / 70.72 | 66.42 / 69.31 |
| Desert | GT3 | 80.76 / 82.73 | 83.57 / 83.79 | 80.36 / 81.81 | 78.54 / 81.38 |
| Nürburgring | GTP | 508.43 / 517.83 (4x) | 494.33 / 497.79 | 500.57 / 502.52 (4x) | 487.80 / 492.40 |
| Nürburgring | GT3 | 560.27 / 565.49 (4x) | 554.58 / 558.44 | 632.84 / 659.81 (55x) | 548.10 / 550.43 |

APEX has the best flying lap on all ten rows (0.5 to 2.7 % under the best reference on the short circuits, 1.3 % on the
Nürburgring GTP and 1.2 % on the GT3) and the best mean on all ten, with zero incident points. The Nürburgring uses
`margin 0.8` (see below); every other circuit runs the default `margin 0.97`.

### Robustness (fitness tool `tools/score.mjs`, 4 circuits × 2 classes, 4 laps, SPH best from M0 = 1.000)

| Condition | best / SPH | mean / SPH | incident points | dirty runs |
|---|---|---|---|---|
| nominal tyres | 0.9850 | 0.9531 | 0 | 0 / 8 |
| rear tyres 8 % weaker (stint wear and heat make the rear the weak axle) | 1.0180 | 0.9860 | 0 | 0 / 8 |

Real-time seat-worker conditions (`tools/worker.mjs --realtime --burst-ms=75`: the game's `AsyncSeats` and `seat-worker.js` in
worker threads, 30 fps frames, replies one frame late, 75 ms delivery bursts): Harbor GTP standing start 52.41 / 53.45 / 55.31 s,
Alpine GT3 rolling start 71.77 / 72.32 / 77.81 s, both with zero contacts and zero incident points.

### What moved the numbers (each change measured with `tools/score.mjs`)

| Change | Effect |
|---|---|
| Friction-circle cap on brake and throttle (share = √(1 − use³)) | removed the mid-corner brake stamp that began most spins; solo 5-lap mean 66.7 → 64.3 s on Harbor GT3 |
| Curvature preview 0.08 s → 0.24 s | nominal incidents 10 → 0, rear-weak incidents 33 → 0 |
| Countersteer gain 2.2 → 5, dead band 0.04 → 0.02 | allowed the corner usage margin 0.90 → 0.97: best / SPH 1.0018 → 0.9850 with 0 incidents |
| Margin 1.0, countersteer 8 | 11 incidents: the limit of this tracker is near 0.97–0.98 |

### What did not pay (kept out, tools kept)

- **Per-corner trims from the on-simulator tuner** (`tools/tune.mjs`: lateral and braking trim per corner, clean lap time as objective,
  stress cases with weak grip and weak rear). Pinned-tyre laps improved by 1–2 % but real stints got worse (12 incident points over 8 runs
  versus 0): the trims sit on the edge of the tracker's stability and wear and heat move that edge. Default is `useTrim: false`.
- **Thermal throttling of the push level** (`thermalK`): 6-lap Harbor mean got worse (59.7 → 62.8 s at lap 6) because the tyre core has a
  4-minute time constant and the loss from slowing is immediate. The push level is a planning decision, not a reflex: M3.
- **Kerb use** (line bound from −0.9 to +0.3 m of the asphalt edge): all within ±0.1 %, so the kerb is not a lever for lap time with this
  tyre model (kerb grip 0.88 plus bump). Default −0.5.
- **Traction slip limit** (`tractionSlip`): lap time and wear per lap move together (1.2 → +2.6 % lap, −26 % wear), no free lunch: planner input.

### Findings that feed M2 and M3

- **Tyre heat is the stint.** At full push the Harbor medium core reaches 125 °C in five laps (optimum 90 °C) and the lap fades 6 s. The hard
  compound (optimum 99 °C, heat 0.9, wear 0.58) is flat: 7-lap GTP 55.9 → 58.3 s against medium 53.8 → 61.0 s; the 6-lap stint totals are within 1 s.
  Compound and push are decided together by the planner.
- **The Nürburgring is thermal.** Lap time against margin (GTP, lap 2): 0.9 → 518 s with 14 incident points, 0.85 → 493 s, 0.8 → 491 s, 0.75 → 495 s.
- **Wear is lopsided:** after two Harbor laps the rear-right tyre has 0.35 wear against 0.06 on the front-left (slip work 2.0 MJ against 0.6 MJ),
  and driven-axle exits carry 62 % of the slip work. The strategist stops on the worst wheel.
- **Axle limits:** the identified cars are front-limited by 1.7× against the rear in steady state, but in corners the outside rear tyre runs at
  0.85–0.9 utilisation against 0.8 for the front, so the weak-rear case matters in stints.

## M2: awareness and combat

What is built (ARCHITECTURE.md sections 5 and 6): full perception of every car in road coordinates, a rear-end speed cap and an alongside
guard (`combatMode: "cap"`, the shipping default), and an online rollout planner (`"pass"`) that weighs lanes against measured rival lines and the
game's own slipstream. The in-game debugger (AI MIND panel, radar, 3D path overlay) works on a live race, see
`docs/debugger-attack.png` (planner in ATTACK mode: lanes weighed with scores and risk, contact forecast, intent timeline, forecast ribbons).

### How combat was tested

`tools/combatlab.mjs` matches APEX's pace to the rival's best lap (margin bisected until APEX's solo best is within δ of SPH's, cached in
`data/match.json`), then runs the same scenario twice on the same seed: control (`cap`) and planner (`pass`), 3 cars on Solenne GTP, hard
compound, 3 laps. Every position change is logged with the plan in force, the speed edge and the lateral gap, and attributed: **by a move** when the planner held an
attack lane within 4 s before it, **on pace** otherwise. SPH reads wall-clock budgets, so n ≤ 8 results are noisy (a repeat of the same scenario can move
a place); the contact and incident columns are the reliable ones.

| Lab | Planner state | Scenarios (δ vs SPH) | Control: mean place / passes / incident pts | Planner: mean place / passes (move/pace) / places lost / contacts / incident pts |
|---|---|---|---|---|
| 3 | first planner, class-line rival model | 4 (−0.5 %, 0 %) | 1.25 / 7 / 0 | 2.25 / 6 (6/0) / 3 / 14 / 4 |
| 4 | same, APEX slower than SPH | 4 (+0.5 %, +1 %) | 1.75 / 5 / 0 | 3.00 / 4 (4/0) / 4 / 14 / 8 |
| 5 | lane ramp from the car's lateral slope, forecast overlap cap | 4 (+0.5 %, +1 %) | 1.75 / 5 / 0 | 2.00 / 4 (3/1) / 0 / 2 / 4 |
| 6 | measured rival lines, `hold` only beside a car | 8 (−0.5 … +1 %) | 1.25 / 14 / 0 | 2.13 / 7 (6/1) / 0 / 0 / 0 |
| 7 | pass gap 2.7 m instead of 2.35 m | 4 | 2.00 / 4 / 1 | 2.25 / 3 (1/2) / 0 / 0 / 0 |

Reading it:

- **Safety converged.** From lab 3 to lab 6 the planner went from 14 contacts and 4 to 8 incident points to 0 and 0. The causes were, in order: a lane that
  looked free only because the rollout ignored the car beside it (forecast overlap cap and overspeed penalty), a lane switch that asked for a lateral kink
  (ramp from the car's own slope, smoothing after the corridor clamp), and a rival forecast on the wrong line.
- **The rival line matters most.** `tools/duel.mjs --audit=1` (SPH, SPH, APEX, Solenne, 2 laps, 1 s forecast): median lateral error 1.26 m with the class line, 0.25 m with the
  measured SPH line (p90 3.22 m to 1.60 m, mean speed error 3.94 to 2.55 m/s); the same scenario had one 4.6 m/s side contact before and none after.
- **When the planner passes, it passes by a move** (20 of the 24 passes in labs 3 to 7, against none of the control's 35, which are made with the rear-end cap
  and the alongside guard and are logged as pace), but **it passes less often than the control** at matched pace (lab 6: 7 passes against 14, mean place 2.13 against 1.25).
  The second pass of the control comes from tow plus the guard holding the line next to the rival, which the planner does not reproduce yet. The speed cap band (2.46 m) against the
  2.35 m pass gap is one suspect; lab 7 widened the gap to 2.7 m and did not separate it from noise. `combatMode` stays `"cap"`.
- **Not solved, both modes:** the 8-car melee (Harbor, 5 GTP + 3 GT3, 4 laps, `tools/duel.mjs`). Control: APEX P1, 44 contacts in the field of which 1 severe (a 6.3 m/s side
  contact alongside a much slower SPH in a corner, 4 incident points to APEX); planner: APEX P2, 14 contacts, 0 severe, 8 incident points to APEX (a 4.1 m/s rear-end
  and a 5.7 m/s side contact, both against slow cars in corners). Slow-car contacts in corners are the open safety item (task: combat safety audit).

### Seat-worker conditions with the planner

`tools/worker.mjs` (the game's `AsyncSeats` and `seat-worker.js` in worker threads, rolling start, replies one frame late, answer delay p50 25 ms), Solenne GTP, SPH + APEX, seed 11:
0 contacts, 0 incident points, 0 worker errors in control mode (3 laps) and in planner mode (4 laps). Planner cost: mean 1.3 ms per 0.15 s cycle (max about 20 ms); `debug()` + `visualDebug()`
cost a median 0.14 ms. In a real-time-paced browser capture (60 fps, planner mode, headless software GL) APEX reported RECOVER in 3 of 18 samples (race time 186 to 216 s) and the race ran about 270 s instead of about 190 s;
the Node worker run of the same scenario shows no such stretch, so this is treated as a rig artefact until a paced run in the real client says otherwise.

### Finding that moved the plan: the pace reference was one compound

Running the same Solenne duel through the worker harness showed SPH 1.0 to 1.6 s faster per lap than the M1 solo table. Cause: the host starts every all-AI car on the compound its strategist
chooses (`race.js`: `e.strategist.startCompound(...)`), which in these short calibrated races is the **soft**, while M0 and M1 measured medium only. See the next section.

## Compound pace and the gearbox

The first M2 worker runs showed SPH 1.0 to 1.6 s per lap faster than the M1 table and nothing in the combat code could explain it. The cause is the pace reference: in a race
the host starts every all-AI car on the compound its strategist picks (`race.js`: `e.strategist.startCompound(...)`), and the short calibrated races pick **soft**. M0 and M1 measured medium only.
SPH gains 3.3 % from medium to soft on Solenne GTP (51.27 to 49.56 s); APEX gained 0.4 % (50.42 to 50.23 s). `tools/compounds.mjs` now measures every compound
(solo, no stop inside the laps, best flying lap of laps 2 to 4, fuel as the host fills it, same protocol as the baseline).

### Cause: the host's automatic gearbox

The host never lets an AI shift by hand (`race.js`: AI cars get `automatic = true`): it shifts up at 7450 rpm and down only below **3450 rpm**. The speed profile assumed the best gear at every speed (the
acceleration table is measured from a standing start), but a car that leaves a corner just above the down-shift speed stays in the tall gear for the whole exit. On Solenne GTP soft the
car left the last corner at 38.3 m/s in 6th (down-shift speed of 6th: 37.9 m/s) and accelerated at 4.0 m/s² where SPH, 2.5 m/s slower at the apex, dropped to 5th and had 5.4 m/s² from the same speed:
a gear is worth 20 to 35 % of the thrust for 400 to 800 m. (Soft tyres made it show: more grip means a faster apex, which is the wrong side of the threshold.)

What was built (`src/model.js`, `src/line.js`):

- A gearbox model of the host's box (`CarModel.gearAt`, `vDown`, `engine`, `driveG`): speed, gear history and the game's own torque curve give the acceleration in the gear the car will really be in.
  The speed profile that the tracker follows stays optimistic (best gear): a profile below what the car can do would cap it, an optimistic one never does.
- **Notches** (`Line.gearNotches`): where the apex speed is within 3 m/s above a down-shift speed, the exit run is integrated with the real gearbox twice (as it is, and with the apex capped 0.6 m/s under the threshold),
  and the apex is capped (±5 stations) only when the exit gains more than 0.15 s over twice the modelled cost of the slower corner. A notch is also required to be *needed*: the car must have been seen in the
  tall gear at that apex on an earlier lap (`gearSeen`, from the car's own `gear`), because a car that is already slower than its profile has dropped the gear anyway and a notch would only cost time (the first,
  model-only version cost 0.16 to 0.4 s at Harbor Ring and was removed). Decisions persist across profile rebuilds (one profile run per rebuild in steady state).

### Solo pace by compound, APEX against SPH (best flying lap in s, % is APEX vs SPH)

| Track | Class | Soft SPH / APX | Medium SPH / APX | Hard SPH / APX |
|---|---|---|---|---|
| Harbor Ring | GTP | 52.61 / 52.04 (-1.08 %) | 53.83 / 53.12 (-1.32 %) | 55.44 / 54.07 (-2.47 %) |
| Solenne | GTP | 49.56 / 49.72 (+0.32 %) | 51.27 / 50.42 (-1.66 %) | 51.60 / 51.27 (-0.64 %) |
| Alpine | GTP | 61.72 / 61.33 (-0.63 %) | 62.92 / 61.61 (-2.08 %) | 65.25 / 62.57 (-4.11 %) |
| Desert | GTP | 65.98 / 65.11 (-1.32 %) | 67.03 / 65.84 (-1.78 %) | 68.43 / 66.76 (-2.44 %) |
| Harbor Ring | GT3 | 62.20 / 60.88 (-2.12 %) | 63.79 / 62.55 (-1.94 %) | 64.94 / 64.00 (-1.45 %) |
| Solenne | GT3 | 59.23 / 59.32 (+0.15 %) | 61.21 / 59.76 (-2.37 %) | 62.33 / 61.19 (-1.83 %) |
| Alpine | GT3 | 72.97 / 72.58 (-0.53 %) | 74.70 / 73.05 (-2.21 %) | 76.13 / 74.57 (-2.05 %) |
| Desert | GT3 | 79.19 / 77.65 (-1.94 %) | 80.76 / 78.22 (-3.15 %) | 81.79 / 79.87 (-2.35 %) |

mean APEX vs SPH -1.71 %, faster on 22 of 24

Nürburgring (medium, 3 laps) is unchanged by this work (no notch fires): GTP 487.77 / 492.40, GT3 548.08 / 550.47. Cost: profile rebuild max 25 ms on the Nürburgring (19 ms before), 10 ms on Solenne; median per update 2 to 6 µs.

What the table says: APEX is ahead on 22 of 24 rows, mean 1.7 %. The two rows it loses are the Solenne softs (+0.32 % GTP, +0.15 % GT3); a lap trace against SPH puts the remaining
0.16 s on the long fast section at stations 650 to 1000, where SPH carries 2 to 3 m/s more. The gearbox notch is worth 0.51 s on that lap and nothing elsewhere; it exists because Solenne GTP soft
is the most probable default, and it is guarded so that it cannot cost time where the car is already in the low gear.
