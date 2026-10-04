# SPEARHEAD development preview

Based on `graphics-aaa` at `26f4880`. This is a tested development candidate;
consistent GT3 endurance wins and very tight corner overlaps remain unfinished.

The independent Harbor GT3/GTP lines now use the same linked front/rear brake
pressure constraint as the executor. The observer preserves a physically
overlapping rival's measured lane. A clear 0.24-second body sweep retains drive
during overlap; a measured front-quarter crossing in a bend extends the check
to 0.4 seconds. Escape ranking compares actual body separation and the complete
road excursion. The driver still writes only controls.

Pit guidance continues its lookahead into the actual pit lane and blends from
its own line before entry. Additional GTP rear rotation ramps with heat and wear;
GT3 hards bound that additional request to 0.06 in clear Harbor conditions.
The native strategist's SPEARHEAD subclass models measured wear, physical stop
and swap cost, and an initial GT3 fuel estimate learned from native laps.
Fuel reserve, mandatory stops, driver swaps, service and manual requests use
the native rules. The planner applies to homogeneous SPEARHEAD AI teams in
clear Harbor Alien endurance races. Human/mixed teams, qualifying, AI Duel,
other weather and other circuits use the native planner.

Runtime changes are in `subjects/next-racer/` plus three integration hooks:
`field.js` and `async-seats.js` install its planner before starting tyre fit,
and `next-racer-state.js` supplies the weather preset. No other AI sources,
vehicle physics, tyre physics or difficulty reference were edited.

Validation uses Harbor Ring, Alien, rolling starts and current CRV. Endurance
runs use native cold starts, classic rules, actual distance/fuel calibration,
pit service and two AI seats. The actual AsyncSeats workers produced:

| Test (seed 7) | SPEARHEAD finish | CRV finish | Result | SPH stops/swaps | Maximum clean hard-stint fade |
|---|---:|---:|---|---:|---:|
| GTP, 12 laps | 734.50 s | 762.10 s | SPH wins by 27.60 s | 1 / 1 | 3.62 s |
| GT3, 20 laps | 1403.12 s | 1401.28 s | CRV wins by 1.84 s | 2 / 2 | 2.34 s |

Both complete with zero contacts, incidents, damage or bridge errors and fuel
remaining. GTP starts on hards. GT3 runs hard/medium/hard. These workers wait
for each reply at a fixed cadence; this table is not a real-time latency claim.

Fixed-cadence native GT3 20-lap checks at seeds 7 and 19 also complete cleanly
with two stops, approximately 1402.2 seconds total and less than 2.1 seconds
of clean hard-stint fade. CRV wins those races by approximately 3.6 seconds.
The retained model improves absolute time and consistency; it does not establish
universal victory. A 12-lap GT3 native check is clean, with CRV ahead by 1.35 s.

Soft-tyre pace checks use the game's separate 12-lap Duel fuel calibration:

- Isolated fixed-cadence GTP laps: 52.54 / 52.30 s.
- Isolated fixed-cadence GT3 laps: 62.075 / 62.408 s.
- Actual real-time GTP worker duel, CRV on pole: SPH 55.37 / 51.99 s;
  CRV 52.47 / 53.23 s. CRV wins overall by 1.89 s. Zero contacts or incidents.
  The run overlaps a native simulation, so its reply-latency numbers are not
  an isolated performance benchmark. SPH's second-lap sectors are
  13.77 / 17.28 / 20.94 s; CRV's are 13.37 / 17.69 / 22.18 s.

`check.mjs` passes 39 control, prediction, lifecycle and integration checks.
`regressions.mjs` passes all 16 retained encounters at 20/30/60 Hz, including
delayed replies and 75 ms bursts, with zero contacts, road departures or stops.
The five retained defense cases preserve their free-running gate time and
speed. Paired twin encounters attribute the pass to a maneuver: it is 2.14 s
earlier in GTP and 16.87 s earlier in GT3 than the nominal-line continuation.
These are fixture results, not a claim that every ordinary-line pass is tactical.

A tight GT3 right-hand corner-overlap probe still records one contact. A
secondary-seed rear-quarter conflict under the earlier soft-start strategy is
also retained in ignored diagnostic records. Host steering corrections and
longer rival-motion reservations were rejected because they harmed other passes
or increased full-race incidents. The improved strategy does not resolve every
close-overlap case.

Changeable-weather validation remains below acceptance: a GT3 12-lap seed-7
run has one off-track, while a GTP seed-19 run has contacts and incidents during
wet/dry swings. Both exercise the random fronts and native tyre/pit calls.
Wet policy was not retuned. Mirage's previously reported excursion has not
been qualified as fixed by this Harbor-focused candidate.

Reproduce with the current Node runtime:

```sh
npm run game:build
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/regressions.mjs
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/worker-duel.mjs --endurance --class=lmdh --drivers=claude-revolution,next-racer --laps=12
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/worker-duel.mjs --endurance --class=gt --drivers=claude-revolution,next-racer --laps=20
```

For visual testing use AI Duel, Harbor Ring, Alien, soft tyres, SPEARHEAD (SPH)
against CLAUDE REV (CRV). Race dumps, local options and server logs are ignored;
they are not public source. Tools stamp both racer and rival sources. The
recorded-state incident tool is a diagnostic approximation: it restores a
time-zero fixture but does not replay prior planner or rubber history.
