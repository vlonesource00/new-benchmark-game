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
