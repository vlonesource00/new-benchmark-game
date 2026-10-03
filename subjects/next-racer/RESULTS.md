# SPEARHEAD results and historical investigation

## Runtime checkpoint

SPEARHEAD is implemented and registered as `next-racer`. This is an experimental
checkpoint, not acceptance of the completed racer. The source, tuning, tyre
physics, strategy and difficulty reference of existing drivers are preserved.

| Check | Observed result | Limit |
|---|---|---|
| Runtime contract checks | 18 passed | Private native plant, hybrid, controls-only writes, duplicate observations, host preview, tyre gate, pit surface, delivery lag, safe recovery, finished seats and native stint metadata |
| Production build | Passed, 183 modules | Existing large-chunk warning remains |
| Actual seat-worker and AsyncSeats probe | 438 replies, 18.03 simulated seconds; zero contacts and incidents | Node adapter executes the real browser-worker module; not a browser frame-rate/load campaign |
| Base encounters, both classes | 33 trials, 24 s each, 30 Hz, one-frame delay plus 75 ms bursts; zero contacts, off-tracks, stopped periods and bridge errors | 12/14 GTP and 11/13 GT3 attacking fixtures give held passes; defense, equal-resource duels and exact-line braking require further work |
| Varied straight smoke campaign | 18 GTP trials across 20/30/60 Hz, seeds 7 and 101; all clean, 12/12 witnessed opportunities converted | Twelve fixed-lane passes were natural trajectory passes; six exact-fast-line passes earned tactical credit; small subset only |
| Varied defense checkpoint | 108 trials, both classes, 20/30/60 Hz, 3 development and 3 held-out seeds; zero contacts, off-tracks, stops, bridge errors or budget failures; all 108 retain the lead | Worst sector loss 2.25%; minimum exit-speed ratio 97.27%; captured before the subsequent evaluated-action correction |
| Retained native regressions | 5 passed; zero contacts, off-tracks or stopped periods | Four previously failing bend passages plus the close GT3 defense case; development regressions, not an independent admission campaign |
| Native 6-lap GTP, clear, hard start, seed 7 | Finished 461.57 s, best valid 62.54 s; zero contacts, incidents, damage and bridge errors; 2 stops / 2 swaps | Gemini v4 finished 419.75 s; no lap-target or fade claim |
| Native 6-lap GT3, Changeable, hard start, seed 19 | Finished 519.23 s, best valid 68.32 s; zero contacts, SPEARHEAD incidents, damage and bridge errors; 2 stops / 2 swaps | Wetness 0–0.79 and all four front phases observed; Gemini v4 finished 494.20 s with 2 incidents |
| Native 6-lap GTP, Changeable, hard start, seed 43 | Finished 490.70 s, best valid 68.41 s; 1 contact, 2 SPEARHEAD incidents, 2 stops / 2 swaps | Wet/dry integration remains an open failure; no weather retune |
| Native GTP qualifying, soft start | Completed, best valid 61.38 s; 0 contacts, 4 SPEARHEAD incidents, 0 stops | Lifecycle works; complete qualifying safety gate remains open |

The longer delayed test originally failed after completing passes: subsequent
corners caused off-tracks. Native prediction through the previously observed
delivery delay fixed the base and straight-smoke cases above. That fix is checked
against independently stepped held native controls. A worker reports its
measured simulation-time delay; it does not know a future latency burst.

The runtime also forwards session/formation/pit metadata, rejects old-epoch
answers after a reset, exports a stamped host-guard preview and owns its pit
surface/wall geometry in a private Track view. Weather, rubber and ambient stay
live without modifying legacy seats. Native pit decisions and driver swaps
were observed in the full-race fixtures above.

The full varied campaign remains under evaluation. The first 594-trial corpus
converted 202/205 independently witnessed opportunities, but had 1,343 native
contact steps. Correcting the curved body/kerb guard reduced the next checkpoint
to 163 contact steps and again 202/205 conversions; it still had off-tracks,
stopped periods and 11 defense-budget failures. Neither checkpoint passed.
A new full run evaluates the further combat corrections described below.
Every failure must remain in the corpus. No solo pace sweep, global physics
change or weather retune has been used to hide that gap. Native pit laps are
excluded from pace/fade evidence; the two clean hard laps before the first stop
are insufficient to certify the planned-stint degradation target.

The first localized held-out failure was GTP, 20 Hz, seed 101, worn tyres on
`defend-corner`. The corner exit itself completed at 2.20 s, but a later solo
hairpin stall let the follower catch it: 395 native contact steps, 10 episodes,
6.37 s stopped. Low-speed velocity direction was incorrectly classified as
slip, and the body corridor rejected usable kerb space. The corrected private
plant measures the curved road at body perimeter points and uses the native
kerb width; native tyre grip/bump physics still applies. Its targeted replay
has zero contacts, off-tracks and stopped time, with 949.81 m progress versus
707.35 m before the correction. This targeted result does not validate the
rest of the campaign; the original failing fixture remains in the corpus.

The next failure was an emergency return crossing an already occupied side
corridor. The fallback now evaluates held-lane refuges and a road-carried rival
response. Attack validation reserves that response through the native prefix;
defense retains the full observed-motion veto and re-observes a pursuer's
hypothetical lane response after its immediate reaction window.

Defense previously exempted a yield route from the pace budget and only
applied the budget before commitment. Applying it throughout defense changed
the seed-217 GTP close-defense sector from 9.79 s to 5.89 s, cleanly. The
108-trial checkpoint above then met the sector and exit-speed budgets.

An additional defect added 85% braking after the escape search had evaluated
and selected a different action. That changed the trajectory being executed,
collapsed alongside separation and caused contacts. Execution now uses the
actual evaluated feedback policy; hard braking remains a candidate that must
earn its result in the private native plant. The GTP seed-43, 30 Hz bend replay
changed from ten contact steps and a 10.75 s pass to zero contacts and a held
6.58 s pass. This passage is not credited as a deliberate tactical move: its
nominal continuation supplied the separation.

The subsequent native qualifying check recorded a valid 54.17 s GTP lap,
but the second timed lap was invalid with two incidents and a fully worn rear
right soft tyre. This is safety/resource evidence, not acceptance of either
the lap target or the fade target. Combat fixes have not included a pace sweep
or wet tuning.

Reproduce integration checks:

```sh
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/next-racer/tools/race.mjs --laps=6 --class=lmdh --compound=hard
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/next-racer/tools/race.mjs --laps=6 --class=gt --compound=hard --weather=changeable --seed=19
```

## Historical design audit

Game baseline: `ea7b402ad02b0558e5c1d2e06627a1992e2d1971`.
The sections below record the earlier **architecture investigation**, before
runtime registration. These observations are historical source contracts;
the new additive integration addresses the transport and registration gaps.

## Completed verification

| Check | Result | Meaning |
|---|---|---|
| Latest `game:build` | Passed, 167 modules | Current game builds after rebase |
| Existing SOLSTICE `check.mjs` | 33 passed, 0 failed | Existing driver regression suite remains passing |
| Native audit probe | Completed | Isolated current-game contexts, class mapping, formation and hybrid transition |
| Source fingerprints | 29 raw-byte SHA-256 hashes | Reproducible game/controller/tool snapshot |
| Markdown links / probe syntax | Checked | Architecture artifacts are usable locally |

Commands from the repository root:

```sh
npm run game:build
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/solstice/tools/check.mjs
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/next-racer/tools/game-audit.mjs
node --check subjects/next-racer/tools/game-audit.mjs
```

The build/checks were repeated after the latest rolling-start update arrived.
The existing suite is not a complete new rolling-field or new-driver campaign.

## Directly observed integration findings

| Observation | Value |
|---|---|
| Harbor native centerline / road width | 2704.619 m / 16.4 m |
| Race and qualifying bridge mode | Both `race`; no explicit session field |
| Prototype capability allowlist | SOLSTICE and Gemini v4 only |
| Unregistered new driver after GTP assignment | Replaced by SOLSTICE in the deterministic fixture |
| Worker race shim has team lookup/calibration | Neither |
| Native rain ambient / default worker-track ambient | 14.3°C / 24°C |
| Formation status forwarded to team worker | No |
| Rolling smoke initial state | Phase `racing`, 24 m/s, progress −340 m |
| First rolling preview / green | 10.825 s / 11.783 s |
| Rolling smoke repeated update timestamps | One, on green transfer |
| Rolling smoke contacts | Zero; one car only |
| BALANCED thrust before lift at 45 m/s | +1329.293 N |
| Native force after lift / frozen observed-force forecast | −1777.778 N / +1329.293 N |
| Isolated one-step velocity discrepancy | 0.003068 m/s |

See [the audit](GAME-AUDIT.md) for the exact contracts and limits, and
[game-audit.json](analysis/game-audit.json) for fixture metadata/source hashes.
Transport findings are source-based observations, not measured browser latency.
The hybrid transition is not a measured cause of a particular lap-time gap.

## Gates still pending

Complete acceptance in [ACCEPTANCE.md](ACCEPTANCE.md) remains pending:
adaptive combat conversion, defense budgets, browser load/latency campaigns,
all native lifecycle/resource cases, planned-stint fade, GTP <53 s and GT3 <64 s.
The earlier SOLSTICE race reports and the other new architecture's printed solo
baselines do not establish any of those results for this design.

The historical investigation changed only this new subject's documents/tools.
The runtime now adds a new bridge, registration and driver-specific worker
hooks. SOLSTICE's runtime/config/data and native physics/rules remain untouched.
