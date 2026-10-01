# Pedal control and close racing — 2026-09-13

Parent: `956ffe4517bf31ea2bbb6c45f63e4b76aefa2aad`.
This development checkpoint is **not promoted to the benchmark pin**. The
refined-arc parent remains the stronger fully validated pack-pace checkpoint.

## Changes

- Harbor plans price forecast padding separately from physical body overlap.
  Controlled shallow rubbing has a lower finite cost; deep overlap, large
  closing speed and fast lateral contact remain hard conflicts. Response-branch
  uncertainty receives a smaller graded cost rather than being treated as bodywork.
- Defense considers the first upcoming turn's physical inside and the actual
  closing rear threat. It holds its chosen side against that pursuer instead of
  choosing again at every commitment timeout. The defensive offset is bounded
  to 1.8 m beyond the racing line to leave tracking room.
- Parallel encroachment without longitudinal closure matches speed instead of
  triggering a false rear-end emergency. Physical closing conflicts still use
  the independent supervisor's immediate braking override.
- A 60 ms brake-intent filter applies in clear Harbor running, consistently in
  rollouts and execution. Explicit lifts and decisive exit throttle release the
  brake immediately. Close traffic retains immediate pedal response.
- Clear-air lift tolerance uses the predicted speed loss to drag over 0.35 s,
  bounded to 0.4–1.2 m/s and faded with the clear-air performance reserve.

No tyre forces, engine power, brake hardware, collision physics, track geometry
or opponent implementations changed. The prior final-kink driving arc remains.

## Verified results

Shared two-lap solo is 79.258/79.000 s, with zero spins, off-track time and damage.
The arc parent was 79.067/78.775 s: this is a small fresh-lap pace tradeoff.
At 30 Hz trace resolution, the first-lap comparison is:

| Metric | Arc parent | Current controls |
| --- | ---: | ---: |
| Brake applications above 10% | 136 | 106 |
| Total absolute brake-command variation | 195.036 | 113.799 |
| Time above 95% throttle | 25.900 s | 26.967 s |
| Time above 10% brake | 16.333 s | 17.800 s |

Brake variation falls about 42%, but total braking time increases. Therefore
this does **not** establish the requested compact, later braking windows.

Three 12-second probes use the unchanged benchmark plant and rival Astra pin
`956ffe4517bf31ea2bbb6c45f63e4b76aefa2aad`. They test initial shallow parallel
rubbing, an unannounced rival cut-in, and an inside-defense approach. All have
zero emergency-stop time, zero off-track time and zero severe contacts. The
parallel rub causes 0.0000116 damage; the other probes cause none. The defender
retains its position with 28.59 m separation and no side changes. These bounded
probes do not prove general overtaking or defense superiority.

The eight-Astra, two-lap field finishes with no severe contacts. The subject
has zero off-track time and 0.00824 damage; one other car records 0.0917 s outside
the limits. Subject laps are 85.775/83.708 s versus the arc parent's
83.725/80.542 s. Native mixed-class Harbor GT finishes a valid 86.258-second lap
with zero damage/off-track time. The pack pace regression prevents promotion.

110 unit tests, close-racing checks, build, lost-momentum passing and the
three-car pressure regression pass. Raw local diagnostics are under `artifacts/`
with the `contact-controls-` prefix. Commands:

```
node --test tests/*.test.js
node tests/close-racing.mjs --check --output=artifacts/contact-controls-close.json
node tests/shared-pace.mjs --trace --output=artifacts/contact-controls-trace.json
node tests/shared-pace.mjs --field=8 --output=artifacts/contact-controls-pack.json
node tests/harbor-quality.mjs --mixed --check
node tests/pack-benchmark.mjs --check
node tests/flow-benchmark.mjs --check
node node_modules/vite/bin/vite.js build
```

## Remaining work

Shorter braking windows, stronger retained attacks under pressure and matching
the human 73.200-second reference remain unresolved. Broad curvature averaging
and whole-line cubic interpolation were tested and removed after excursions;
they must not be described as shipped fixes. Further work should distinguish
the speed-plan discontinuities from actuator response without hiding corner
limits, and evaluate pack position as well as tolerance for proximity.
