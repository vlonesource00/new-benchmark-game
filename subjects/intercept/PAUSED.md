# INTERCEPT save-point handoff

Development is paused at the user's request on 2026-10-11. No simulation campaigns are running or queued. Resume only when the user asks.

## Saved state

- Feature branch: `intercept-dev`; integration base: `graphics-aaa`, through 48cb344 at this checkpoint.
- Keep existing drivers intact. The independent INTERCEPT driver and its laboratory tools are the development scope.
- Production settings remain unchanged. The new `brakingTube` forecast is experimental and OFF by default.
- Local result dumps, replays and the private root design document are excluded from public commits.
- Public commit identity: `vlonesource00 <vlonesource00@users.noreply.github.com>`.
- Before resuming or pushing, fetch and rebase onto `origin/graphics-aaa` unless the user changes the integration base.

## Established evidence

- Clean solo driving on five circuits in GTP and GT3; Harbor targets are met. INTERCEPT is not the fastest in every class/circuit.
- A clean retained maneuver around RAZOR through the real worker/controller path, including one extra frame of delay; the matched following-only control makes no pass.
- Three retained passes of the controlled GT3 train. The latest real Chromium worker repeat with 500/250 ms reply holds is clean; a previous repeat had a light contact. This is bounded test evidence, not an arbitrary-latency guarantee.
- The tyre-age/pit-loss strategy correction removes an unnecessary fresh-set stop and saves 38.71 s in the matched six-lap Nurburgring strategy comparison.
- Pits, swaps, rain, Changeable weather, SC and FCY have regression coverage.
- The large 14-car Harbor race does not satisfy the consistent-win gate. RAZOR wins both classes, and two INTERCEPT cars exceed 10% cumulative damage when formation damage and repairs are correctly counted.

## Latest experiment

The nose guard can release during very strong prototype braking because the road-progress predictor caps deceleration at 18 m/s² and follows an assumed path. Diagnostic body deceleration shows 20–28 m/s² during the reproduced first-corner incident.

The opt-in fallback checks a 0.2 s public-body braking pose only when that road predictor saturates. It retains the existing road hint, excludes pit-lane cars and formation, and does not relax the established collision gates.

| Test, option enabled | Outcome |
| --- | --- |
| Natural Harbor first corner, GTP, normal / one lag frame | Zero damage and severe contact |
| Natural Harbor first corner, GT3, normal / one lag frame | 1.14% / 1.90% light-contact damage; zero severe contacts |
| Harbor dry, GTP, 12 laps, seed 11 | Wins by 2.44 s; zero damage; one retained maneuver and one pace pass |
| Harbor dry, GT3, 12 laps, seed 11 | Wins by 0.525 s; 1.14% damage; retained pace pass |
| Changeable mixed field, 8 laps, seed 23 | GT3 worsens by 4.27 s and gains 6.76% damage with one severe contact; GTP is damage-free but third |

The Changeable regression blocks enabling the option. Do not discard the safety result or assign the following-car impact a definitive cause without tracing it. Longer and broader forecast variants also regressed and are not retained.

## Resume priorities

1. Investigate whether checking only the executed route misses the car's actual body momentum during lane transitions. No replacement control law has been implemented.
2. Reproduce the Changeable GT3 regression before changing any weather or strategy behavior.
3. Compare candidate changes across both grid orders, multiple seeds and real browser delivery. Track retained maneuver passes, traffic delay, all contacts and cumulative damage.
4. Establish defense and faster recovery through combinations of hazards and traffic; safe clearance alone is insufficient.
5. Close the remaining small solo gaps while preserving stint fade below four seconds, then establish consistent mixed-field endurance wins.

Use `PROGRESS.md` for full evidence and limitations and `TOOLS.md` for portable reproduction commands. Synthetic and field replays remain available locally through the review index; none is a substitute for the open completion gates.
