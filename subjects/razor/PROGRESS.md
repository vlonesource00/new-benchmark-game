# RAZOR first development build

Base: `origin/graphics-aaa` at `c0fb713`. Separate `razor` driver; SOLSTICE,
SPEARHEAD, APEX and the shared physics are preserved.

## Implemented

- APEX's identified model and baked geometry, with independent line metadata,
  combat, traffic observations, slip expenditure and strategy installation.
- Constant-size corridor search, pooled geometry buffers and local retiming.
  Measured position/tangent joins, bounded steering jerk and persistent sides.
  Road narrowing uses smooth anticipatory tapers instead of sharp offset clipping.
- Moving wake pursuit, inside/outside separation, full-throttle use of owned
  space, one defensive cover and smooth returns. A failed move must return
  before starting a new move in the opposite direction.
- Static/spun/retired road obstacles remain physical. A completely blocked
  road gets a stopping constraint; viable escapes keep their acceleration.
  The shared side guard is translated into smooth-line coordinates; overlap
  itself supplies no longitudinal speed or acceleration cap.
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
| GTP against slightly slower APEX | 6.41 s | 10.10 s |
| GTP through APEX GT3 | 3.70 s | 10.02 s |
| GT3 against slightly slower APEX | 7.72 s | 13.35 s |
| GTP against near-pace APEX | 6.02 s | 18.77 s |

A conversion needs sustained clearance, executed lateral departure and overlap,
and earlier completion than its paired baseline. Live "passes after moves" are
associations, not causal proof. Ordinary race order changes and pit advantages
are not awarded as demonstrated tactical passes.

The 24 encounter runs had zero hard contacts, zero off-track time and zero
controller errors. There were 63 light contact steps across the matrix; the tests do not
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
| GTP | 720.25 s | 721.56 s | 1 / 1 |
| GT3 | 823.88 s | 826.98 s | 1 / 1 |

Both RAZOR entries finished without incidents or controller errors. GTP recorded
two light contact steps and zero hard contacts; GT3 recorded zero contacts.
Those small wins validate the race integration; they do not prove combat
superiority. The initial pit windows use measured RAZOR stint limits instead of
waiting for the steep late-hard fade in the inherited planner's fuel window.

The two-lap RAZOR/APEX seat-worker smoke completed without errors, contacts or
incidents. Its combined delay percentiles are invalid because the legacy harness
includes APEX replies without timestamps. A dedicated RAZOR/RAZOR one-lap worker
check completed without controller errors or recorded incidents, with 3 contact
steps and finite simulated reply ages of 25 ms. It does not establish a zero-contact
worker result or a hardware-independent transport guarantee.

Changeable checks on the latest base traversed wetness 0.00–0.93. The dry stint
maximum is restricted to Clear; applying it between showers had forced a poor
fresh-soft stop and caused a GTP regression. With normal weather planning restored,
GTP completed without incidents or controller errors but lost by 23.40 s with
two stops. GT3 completed without controller errors but lost control, went off
track, hit the wall and required recovery; it lost by 41.33 s with two stops.
Weather strategy and GT3 wet stability remain explicit limitations.

## Still to solve

1. Equal-car self-fight conversion and mid-corner equal-class attacks. The
   canonical cases do not yet demonstrate a pass; report them as unresolved.
   In the corner case, attacks disabled completes a pass at 16.15 s while
   the current attack policy fails to convert within 24 s and loses time.
2. Warm GTP hard stint fade: one final stint still rose about five seconds.
   The four-second target is not universally met.
3. Defense against a varied field, dense moving traffic, more circuits, more
   seeds and the full worker combat matrix. Current evidence is chiefly Harbor.
4. GT3 wet stability and weather decisions. Current rain evidence is not clean
   across both classes. Fit RAZOR's own stint priors instead of
   treating APEX's priors as final RAZOR calibration.

## Reproduce

```sh
node --import ./scripts/json-loader.mjs subjects/razor/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/razor/tools/encounters.mjs all 60
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs apex,razor lmdh 12 clear 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs apex,razor gt 12 clear 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs razor gt 12 changeable 7
node --import ./scripts/json-loader.mjs subjects/razor/tools/race.mjs razor lmdh 6 clear 7 soft
npm run game:build
```
