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
\`margin 0.8\` (see below); every other circuit runs the default \`margin 0.97\`.

### Robustness (fitness tool \`tools/score.mjs\`, 4 circuits × 2 classes, 4 laps, SPH best from M0 = 1.000)

| Condition | best / SPH | mean / SPH | incident points | dirty runs |
|---|---|---|---|---|
| nominal tyres | 0.9850 | 0.9531 | 0 | 0 / 8 |
| rear tyres 8 % weaker (stint wear and heat make the rear the weak axle) | 1.0180 | 0.9860 | 0 | 0 / 8 |

Real-time seat-worker conditions (\`tools/worker.mjs --realtime --burst-ms=75\`: the game's \`AsyncSeats\` and \`seat-worker.js\` in
worker threads, 30 fps frames, replies one frame late, 75 ms delivery bursts): Harbor GTP standing start 52.41 / 53.45 / 55.31 s,
Alpine GT3 rolling start 71.77 / 72.32 / 77.81 s, both with zero contacts and zero incident points.

### What moved the numbers (each change measured with \`tools/score.mjs\`)

| Change | Effect |
|---|---|
| Friction-circle cap on brake and throttle (share = √(1 − use³)) | removed the mid-corner brake stamp that began most spins; solo 5-lap mean 66.7 → 64.3 s on Harbor GT3 |
| Curvature preview 0.08 s → 0.24 s | nominal incidents 10 → 0, rear-weak incidents 33 → 0 |
| Countersteer gain 2.2 → 5, dead band 0.04 → 0.02 | allowed the corner usage margin 0.90 → 0.97: best / SPH 1.0018 → 0.9850 with 0 incidents |
| Margin 1.0, countersteer 8 | 11 incidents: the limit of this tracker is near 0.97–0.98 |

### What did not pay (kept out, tools kept)

- **Per-corner trims from the on-simulator tuner** (\`tools/tune.mjs\`: lateral and braking trim per corner, clean lap time as objective,
  stress cases with weak grip and weak rear). Pinned-tyre laps improved by 1–2 % but real stints got worse (12 incident points over 8 runs
  versus 0): the trims sit on the edge of the tracker's stability and wear and heat move that edge. Default is \`useTrim: false\`.
- **Thermal throttling of the push level** (\`thermalK\`): 6-lap Harbor mean got worse (59.7 → 62.8 s at lap 6) because the tyre core has a
  4-minute time constant and the loss from slowing is immediate. The push level is a planning decision, not a reflex: M3.
- **Kerb use** (line bound from −0.9 to +0.3 m of the asphalt edge): all within ±0.1 %, so the kerb is not a lever for lap time with this
  tyre model (kerb grip 0.88 plus bump). Default −0.5.
- **Traction slip limit** (\`tractionSlip\`): lap time and wear per lap move together (1.2 → +2.6 % lap, −26 % wear), no free lunch: planner input.

### Findings that feed M2 and M3

- **Tyre heat is the stint.** At full push the Harbor medium core reaches 125 °C in five laps (optimum 90 °C) and the lap fades 6 s. The hard
  compound (optimum 99 °C, heat 0.9, wear 0.58) is flat: 7-lap GTP 55.9 → 58.3 s against medium 53.8 → 61.0 s; the 6-lap stint totals are within 1 s.
  Compound and push are decided together by the planner.
- **The Nürburgring is thermal.** Lap time against margin (GTP, lap 2): 0.9 → 518 s with 14 incident points, 0.85 → 493 s, 0.8 → 491 s, 0.75 → 495 s.
- **Wear is lopsided:** after two Harbor laps the rear-right tyre has 0.35 wear against 0.06 on the front-left (slip work 2.0 MJ against 0.6 MJ),
  and driven-axle exits carry 62 % of the slip work. The strategist stops on the worst wheel.
- **Axle limits:** the identified cars are front-limited by 1.7× against the rear in steady state, but in corners the outside rear tyre runs at
  0.85–0.9 utilisation against 0.8 for the front, so the weak-rear case matters in stints.
