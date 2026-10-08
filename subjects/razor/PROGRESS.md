# RAZOR first development build

Base: `origin/graphics-aaa` at `86d3005`. Separate `razor` driver; SOLSTICE,
SPEARHEAD, APEX and the shared physics are preserved.

## Implemented

- APEX's identified model and baked geometry, with independent line metadata,
  combat, traffic observations, slip expenditure and strategy installation.
- Constant-size corridor search, pooled geometry buffers and local retiming.
  Measured position/tangent joins, bounded steering jerk and persistent sides.
- Moving wake pursuit, inside/outside separation, full-throttle use of owned
  space, one defensive cover and smooth returns. A failed move must return
  before starting a new move in the opposite direction.
- Static/spun/retired road obstacles remain physical. A completely blocked
  road gets a stopping constraint; viable escapes keep their acceleration.
- Pit calls and approaches are excluded from pursuit but remain physical
  obstacles. Lane/service cars are excluded; releases re-enter occupancy when
  their body reaches the road. The debugger also suppresses phantom pit targets.
- Native/worker seat selection, countdown priming, actual reply-age reporting,
  weather envelope, per-team pit planner, swaps and the architecture lens.
- Public flags, pit penalties and hybrid deployment remain enforced by the
  authoritative race. Below Alien the normal difficulty governor still applies.

## Evidence, not a final supremacy claim

`tools/check.mjs` runs native physics encounters at 20/30/60 Hz, pit/ghost/retired
occupancy checks, a fresh-driver takeover, a fully blocked road and paired pass
counterfactuals. Pit filtering is also checked in the architecture lens.
All 42 assertions pass; the production build also passes.

At 60 Hz, these deliberately staged Harbor soft-tyre encounters produced:

| Encounter | RAZOR clear-ahead time | Same traffic-aware driver, attacks disabled |
| --- | ---: | ---: |
| GTP against slightly slower APEX | 6.36 s | 8.82 s |
| GTP through APEX GT3 | 3.71 s | 7.42 s |
| GT3 against slightly slower APEX | 7.64 s | 9.19 s |
| GTP against near-pace APEX | 5.81 s | 7.24 s |

A conversion needs sustained clearance, executed lateral departure and overlap,
and earlier completion than its paired baseline. Live "passes after moves" are
associations, not causal proof. Ordinary race order changes and pit advantages
are not awarded as demonstrated tactical passes.

The 24 encounter runs had zero hard contacts, zero off-track time and zero
controller errors. There were light rubbing contacts at 20 Hz; the tests do not
claim zero touches. Measured update p95 was below 1 ms on this machine,
excluding preparation. This is not a hardware-independent latency guarantee.

After the grip-refresh fix, solo Harbor rolling-start soft stints recorded
GTP laps 51.71 / 53.63 / 57.42 s and GT3 laps 60.70 / 62.61 / 65.73 s.
These use a 30-lap calibration with stops disabled and include the first
rolling-start lap, not a qualifying comparison or a shorter-race wear model.
The third soft lap exceeded the four-second fade target, so the initial soft
maximum window is two laps. Medium stints recorded GTP 53.06 / 53.75 / 56.31 / 58.67 s
and GT3 61.87 / 62.59 / 64.64 / 66.38 s; the initial medium window is three laps.
An earlier cold GT3 hard check over seven laps faded 2.48 s.
Separate six-lap soft-start races completed with no contacts or incidents;
the resource planner called earlier stops under that race's faster wear rate.
The maximum windows do not force a car to stay out when fuel or wear requires a stop.

Native 12-lap Harbor clear, seed 7, two AI teammates per car:

| Class | RAZOR finish | APEX finish | RAZOR stops / swaps |
| --- | ---: | ---: | --- |
| GTP | 719.40 s | 721.51 s | 1 / 1 |
| GT3 | 822.28 s | 825.57 s | 1 / 1 |

Both RAZOR entries finished without incidents, contacts or controller errors.
Those small wins validate the race integration; they do not prove combat
superiority. The initial pit windows use measured RAZOR stint limits instead of
waiting for the steep late-hard fade in the inherited planner's fuel window.

The two-lap RAZOR/APEX seat-worker smoke completed without errors, contacts or
incidents. Its combined delay percentiles are invalid because the legacy harness
includes APEX replies without timestamps. A dedicated RAZOR/RAZOR one-lap worker
check completed without controller errors or recorded incidents, with 15 contact
steps and finite simulated reply ages of 25 ms. It does not establish a zero-contact
worker result or a hardware-independent transport guarantee.

Changeable GTP vs APEX and Changeable GT3 solo completed through wetness
0.00–0.93 with no RAZOR incidents or controller errors. GTP lost to APEX by
about 15 s and made two stops. Wet-weather strategy remains a limitation.

## Still to solve

1. Equal-car self-fight conversion and mid-corner equal-class attacks. The
   canonical cases do not yet demonstrate a pass; report them as unresolved.
   In the corner case, attacks disabled completes a pass at 14.01 s while
   the current attack policy fails to convert within 24 s and loses time.
2. Warm GTP hard stint fade: one final stint still rose about five seconds.
   The four-second target is not universally met.
3. Defense against a varied field, dense moving traffic, more circuits, more
   seeds and the full worker combat matrix. Current evidence is chiefly Harbor.
4. Fit RAZOR's own stint priors and evaluate weather decisions, instead of
   treating APEX's priors as final RAZOR calibration.

## Reproduce

```sh
node --import ./scripts/json-loader.mjs subjects/razor/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/encounters.mjs all 60
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs apex,razor lmdh 12 clear 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs apex,razor gt 12 clear 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs razor gt 12 changeable 7
npm run game:build
```
