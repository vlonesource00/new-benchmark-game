# Assertive racecraft update — 8 September 2026

The default phone showcase is built and served at http://100.103.254.53:4174/?showcase=1. Reload an existing phone tab to load the new simulation.

## Changes

- Traffic pace blend increases from 0.35 to 0.45. This increases the planner's braking and cornering allowance while retaining tyre-temperature protection. It is an interpolation between driving envelopes, not a throttle percentage or a power increase.
- Following-speed allowance responds more strongly to an opening gap, and close-following cost is lower. Both front and rear exit costs remain active together.
- Shallow parallel rubbing is feasible up to 0.22 m of predicted overlap, 2.5 m/s relative longitudinal speed and 1 m/s lateral speed. It receives a lower planning cost. The independent supervisor no longer treats that specific case as an emergency rear-end impact. Deeper overlap and energetic closing still trigger avoidance. Collision physics and damage remain real.
- Nominal maximum path offset increases from 5.3 to 5.4 m. Larger width increases failed sustained-race checks and were rejected. A tracking margin is deliberately retained; the AI is not instructed to ride the legal boundary continuously.
- Grip estimation accounts for both wheel tracks plus a 0.2 m tracking allowance, instead of assuming all tyres have the surface beneath the car centre.
- Lap validity now requires the car centre to remain inside the 6.5 m track half-width. This represents half the symmetric car footprint remaining inside the local road cross-section; it is not exact curved-boundary polygon clipping. Previously the centre could travel to 7.5 m without invalidation.
- The on-track debugger shows all candidate/rejected paths by default again. Cyan attack and orange defence alternatives, rival forecasts and the orange forecast gate remain visible together. Floating defensive text labels were removed. Closing the engineer panel retains paths in showcase mode.

## Measured results

Same deterministic fresh-track default showcase, six cars, three laps, red driver skill unchanged:

| Result | Previous verified build | Accepted update |
| --- | ---: | ---: |
| Best red lap | 1:22.408 | 1:21.667 |
| Red race time | 4:13.108 | 4:12.833 |
| Red finish position | P3 | P5 |
| Red damage | 0 | 0 |
| Whole-field half-car-limit excursions | Not measured in that original record | 0 |

The lap improves by 0.741 seconds, but the overall race improves by only 0.275 seconds and finishing position worsens because opponents also benefit. This is not evidence that the red car now consistently beats the field. The rejected 1:20.875 candidate caused excessive excursions elsewhere and was not shipped.

Normal eight-car, 240-second test: 20 clean passes, 479.4 m field spread, zero excursions, zero severe impacts, aggregate damage 0.026. This passes the existing field-quality contract.

Three 30-second battle fixtures pass, including the stricter half-car limit. Defence-in-tow progress rises from 1034.49 to 1053.81 m; the rear car changes from 12.84 m ahead to 15.35 m behind. Attack-under-pressure is less successful than that defence case and produces aggregate light-contact damage of 0.0159. The pack contract explicitly permits less than 0.03 aggregate damage, replacing the previous zero-rubbing contract to match the requested driving style. Pace, gap, excursion and severe-impact requirements were retained.

## Remaining limitation

Maximum aggression (0.95), eight cars, 240 seconds **fails the track-limit quality check**: O. Reed accumulates 6.53 seconds outside the half-car boundary. No severe impacts occur, and field spread is 354 m. The archived build, independently measured with the same half-car rule, accumulates 3.39 seconds outside (its old permissive counter reports only 0.42 seconds). Thus maximum-aggression track keeping regresses in this deterministic case. This is unresolved and should not be presented as validated or fixed.

## Verification and evidence

- 72 unit/integration tests pass; production build passes with the existing bundle-size warning.
- Default showcase and normal-field checks pass. Maximum-aggression check fails as disclosed above.
- Three-car pack checks pass with explicitly bounded rubbing damage.
- Browser inspection confirms on-track paths remain when the engineer closes, with no browser warnings/errors observed.
- Accepted simulation records: `artifacts/assertive-v10-showcase.json`, `artifacts/assertive-v10-normal.json`, `artifacts/assertive-v10-fierce.json`, `artifacts/assertive-final-pack.json`, `artifacts/assertive-v10-tests.txt`, `artifacts/assertive-final-build.txt`.
- Fair old-build limit comparison: `artifacts/assertive-baseline-fierce-limits.json`. Baseline simulation source is preserved in `artifacts/assertive-baseline/src/sim/`.
- Diagnostics: `tests/edge-diagnostics.mjs`, `tests/pack-benchmark.mjs --trace`, and field benchmark independent half-car/braking-duration counters.

No engine, tyre-force, contact-resolution, driver-skill or opponent-power changes are included.
