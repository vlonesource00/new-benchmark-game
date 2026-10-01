# Pack racing and trackside upgrade

Implemented 8 September 2026. Refresh the private showcase with Tailscale connected:
http://100.103.254.53:4174/?showcase=1

## AI behaviour

Every candidate now scores the predicted loss to cars ahead and exposure to cars behind together, alongside existing travel time, exit speed, grip and collision costs. This uses observed opponent motion rather than their controls. The primary tactical label still names one manoeuvre; it no longer describes every consideration in its score.

When attacking or defending between nearby cars, the planner can use a narrower committed offset (2.4 m rather than 3.55 m). Both the side and width remain fixed during that commitment. This prevents pressure thresholds from moving the desired lane on successive solves. Physical overlap keeps priority and unsafe paths remain excluded by the existing constraints.

The engineer panel exposes **Front pace cost** and **Rear exposure cost**. These are dimensionless scoring contributions, not seconds or guarantees of a pass.

## Measured comparison

Deterministic three-car scenarios, 30 seconds at 120 Hz. All three drivers use the respective implementation, so this measures the resulting battle, not an isolated driver's causal gain. Positive rear gap means the original rear car is still behind; negative means it has passed.

| Scenario | Before distance | New distance | Before / new front gap | Before / new rear gap |
|---|---:|---:|---:|---:|
| Sandwich | 1038.67 m | 1049.04 m | 8.18 / 5.23 m | 10.39 / 27.41 m |
| Defend in tow | 988.17 m | 1039.43 m | 130.50 / 79.24 m | -53.70 / -16.04 m |
| Attack under pressure | 1013.81 m | 1028.72 m | 30.30 / 16.48 m | -15.23 / -17.29 m |

Progress improves approximately 1.0%, 5.2%, and 1.5%. All scenarios have zero measured off-track time, severe impacts and damage. The attacking case still loses the position to the original rear car, by 2.06 m more than before; simultaneous scoring does not remove every tactical trade-off.

Final eight-car, 240-second race checks:

| Mode | Clean passes | Clean retained passes | Off-track vehicle seconds | Severe contacts | Total damage | Field spread |
|---|---:|---:|---:|---:|---:|---:|
| Normal | 19 | 17 | 0 | 0 | 0.048 | 401.5 m |
| Fierce | 15 | 13 | 0 | 0 | 0.040 | 543.7 m |

Both existing race contracts pass without changed thresholds. Minor contacts remain (3 normal, 15 fierce). These deterministic dry races are regression checks, not evidence covering every grid, weather condition or race duration. Earlier tuning experiments failed long-race checks and were replaced; the final version freezes commitment width.

## Environment

Added spectator terraces and people, tent-like shelters, parked service vans, marshal cabins, olive groves, vineyard rows, shrubs and a distant settlement with roofs and windows. Deterministic placement rejects footprints within 20 m of every circuit section, including neighbouring sections.

The additions use four shared instanced geometry batches, plus applicable shadow rendering. They are procedural static scenery; no additional Blender asset was needed. They do not change track geometry or vehicle physics. Browser checks covered portrait and landscape views with no warning/error logs. A desktop viewport is not a measurement of phone GPU performance.

## Reproduce

```powershell
npm test
npm run test:pack
npm run test:racecraft
npm run test:racecraft:fierce
npm run build
```

All 59 unit/integration tests pass. Evidence: `artifacts/pack-tests.txt`, `artifacts/pack-before.json`, `artifacts/pack-current.json`, `artifacts/pack-normal.json`, `artifacts/pack-fierce.json`. The pre-change simulation is preserved in `artifacts/pack-baseline/src/sim`; set `SIM_ROOT` to that directory to repeat the baseline benchmark.
