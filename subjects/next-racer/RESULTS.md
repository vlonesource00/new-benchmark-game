# SPEARHEAD results and historical investigation

## Current checkpoint (2026-10-03)

The runtime and native worker/host execution are built. Full acceptance remains
open. Do not describe the current driver as a completed maximum-combat racer.
Large raw results and rejected experiments remain in ignored `results/` files.
Every run records the source hashes it actually loaded.

| Check | Result | Qualification |
|---|---|---|
| Contracts | 23 passed | Native private prediction, hybrid, controls-only writes, lifecycle, stamped live feedback, public line history and push-policy forwarding |
| Retained regressions | 10 passed / 5 failed out of 15; zero contacts, off-tracks, wheel excursions or stops | Includes two causally demonstrated adaptive duels, a safety-only crossing case, and five explicit close-defense sector-budget failures |
| Development campaign | 297 trials; 89/89 independently witnessed opportunities converted; zero contacts, off-tracks, wheel excursions or defense-budget failures | Seeds 7, 19, 43; 20/30/60 Hz planning with delayed replies and 75 ms bursts; checkpoint before the subsequent public-history/rounded-corridor changes |
| Independent campaign | 297 trials; 82/82 witnessed opportunities converted; zero contacts/off-tracks; all 54 defenders retain the position | Seeds 509, 887, 1297; five GT3 close-defense cases fail sector/exit-speed budgets. Now retained development failures, not fresh blind data |
| Actual paced seat workers | Four cars, 60 s at real 30 FPS pacing, native 120 Hz feedback; no contacts/incidents in either class | GTP 5,104 replies / GT3 5,173; 58.3 ms delay p95 with injected 75 ms bursts. Node worker load, not browser GPU/FPS acceptance |
| GTP native qualifying | 53.167 s best valid; both timed laps valid, no contacts/incidents | Push forwarding fixed; still above <53 s |
| GT3 native qualifying | Prior clean checkpoint 63.925 s | <64 s achieved at that checkpoint; must repeat after final runtime changes |
| GTP native 20-lap hard start | Both SPEARHEAD cars finish without contacts/incidents; 4 stops/swaps each | First hard stint fades 5.01 s, exceeding 4 s; winner is Gemini v4 by 26.64 s. No claim of endurance acceptance |
| GT3 native 20-lap hard start with public-history response | Zero contacts/incidents/damage/errors; 4 native stops/swaps | Finishes 1500.83 s versus Gemini 1449.30 s. Earlier stop timing changed naturally; this is not proof that the original contact encounter was repaired in isolation |
| Production build | Passed, 191 modules | Existing large-chunk warning remains |

The adaptive duel regressions demonstrate a move, not merely a fast trajectory:
GTP passes and holds at 5.07 s; GT3 at about 6.45 s. Each leaves its nominal line
by over 2.5 m before overlap; its paired nominal-line continuation does not pass.
Equal-resource twins and several closing twins still have no demonstrated held
pass; lack of an independent witness does not establish impossibility.

The five new defense failures lose roughly 47–51% of sector time and 31–32% of
exit speed against free air. Their nominal continuations **with traffic** also
contact the rival and leave the road. Reducing collision margins is therefore
not an accepted correction. Experimental changes to defense-budget ordering,
temporary combat push and extra host braking did not pass and were removed.
The failed cases remain required regressions; no criterion was relaxed.

Reducing the emergency traffic horizon to the normal planner's 1.15 s window
kept the older ten regressions safe but did not improve the five defense cases;
that experiment was reverted. The independent prescribed-route probe now uses
the same rich preview and live feedback as production. Its first 12 alternatives
for seed 509 provide no safe lead-retaining witness within the defense budgets.
Safe alternatives still lose about 44–46% of sector time; this bounded search
does not establish impossibility. All five exact initial fixtures are declared
in the regression tool, rather than surviving only in ignored result dumps.

The simple thermal cap and reduced wear-braking reserve did not solve the long
hard-stint fade; the latter also introduced native incidents. Axle-weighted
corner targets increased heat/fade. None was promoted into production tuning.
The latest rounded side-corridor geometry improves several retained bend passes
and keeps all ten regressions clean; its complete campaign remains to be run.

Next: resolve the independently retained close-defense cases, then rerun a new
unused validation set, native field/endurance/Changeable checks, qualifying and
the actual planned-stint fade measurement. Solo pace tuning stays deferred
while combat acceptance is open. SOLSTICE and native physics/strategy are
preserved. No new PR has been published for this unfinished checkpoint.

## Historical runtime checkpoints

SPEARHEAD is implemented and registered as `next-racer`. This is an experimental
checkpoint, not acceptance of the completed racer. The source, tuning, tyre
physics, strategy and difficulty reference of existing drivers are preserved.

| Check | Observed result | Limit |
|---|---|---|
| Runtime contract checks | 21 passed | Adds repeated delayed-reply parity, measured joining course and live read-only host feedback with expiry |
| Production build | Passed, 191 modules | Existing large-chunk warning remains |
| Actual seat-worker and AsyncSeats probe | 438 replies, 18.03 simulated seconds; zero contacts and incidents | Node adapter executes the real browser-worker module; not a browser frame-rate/load campaign |
| Base encounters, both classes | 33 trials, 24 s each, 30 Hz, one-frame delay plus 75 ms bursts; zero contacts, off-tracks, stopped periods and bridge errors | 12/14 GTP and 11/13 GT3 attacking fixtures give held passes; defense, equal-resource duels and exact-line braking require further work |
| Varied straight smoke campaign | 18 GTP trials across 20/30/60 Hz, seeds 7 and 101; all clean, 12/12 witnessed opportunities converted | Twelve fixed-lane passes were natural trajectory passes; six exact-fast-line passes earned tactical credit; small subset only |
| Varied defense checkpoint | 108 trials, both classes, 20/30/60 Hz, 3 development and 3 held-out seeds; zero contacts, off-tracks, stops, bridge errors or budget failures; all 108 retain the lead | Worst sector loss 2.25%; minimum exit-speed ratio 97.27%; captured before the subsequent evaluated-action correction |
| Retained native regressions | 6 passed; zero contacts, off-tracks, wheel departures or stopped periods | GT3 close-defense exit 7.13 s versus 7.03 s in free air; development regressions, not an independent admission campaign |
| Replays of 21 previous road/wheel failures | All clean after the worker/host split | Captured before the subsequent rival-forecast refinement; the full mixed rerun remains required |
| Native 6-lap GTP, clear, hard start, seed 7 | Finished 434.38 s, best valid 57.50 s; zero contacts, incidents, damage and bridge errors; 2 stops / 2 swaps | Gemini v4 finished 419.43 s; no lap-target or fade claim |
| Native 6-lap GT3, Changeable, hard start, seed 19 | Finished 519.23 s, best valid 68.32 s; zero contacts, SPEARHEAD incidents, damage and bridge errors; 2 stops / 2 swaps | Wetness 0–0.79 and all four front phases observed; Gemini v4 finished 494.20 s with 2 incidents |
| Native 6-lap GTP, Changeable, hard start, seed 43 | Finished 479.57 s, best valid 67.97 s; zero contacts, incidents, damage and bridge errors; 2 stops / 2 swaps | Improved from the earlier one-contact/two-incident run through generic feedback changes; no weather retune |
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

The historical varied campaign remained under evaluation. The first 594-trial corpus
converted 202/205 independently witnessed opportunities, but had 1,343 native
contact steps. Correcting the curved body/kerb guard reduced the next checkpoint
to 163 contact steps and again 202/205 conversions; it still had off-tracks,
stopped periods and 11 defense-budget failures. Neither checkpoint passed.
The evaluated-action checkpoint then converted 205/205 witnessed opportunities
with zero contacts, stops, bridge errors and defense-budget failures, but still
had 11.93 seconds of native off-track running in nine trials. It did not pass.
A new 594-trial run evaluates the subsequent worker/host feedback split, longer
road/escape continuation and rival forecast corrections. Checkpoints persist
every 24 trials; a partial file is explicitly marked incomplete.
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

The immediate executor now follows serialized geometry using the live car at
the native physics rate, while the worker owns maneuver selection. A retained
GTP delay-burst corner that previously went off-track after completing its pass
now remains clean. The closing GTP duel completes at 4.44 s with a 2.65 m
departure before overlap; its matched nominal-line run does not pass. That is
deliberate-maneuver evidence, not a faster solo trajectory.

Defense also exposed an over-conservative spacing rejection. Its matched
nominal run kept the lead at full pace without contact, while the planner
braked through a physically clear rear-side passage. A smaller extra margin
for an established line with a steady observed rival behind reduced that
GT3 sector from 10.33 s to 7.13 s, versus 7.03 s in free air. Native body
separation remains required; the full defense rerun must verify generality.

The seeds 101, 217 and 331 were initially held out, then inspected and used
to repair failures. They are now retained regression data, not fresh blind
validation. A new unused seed set is required before an independent acceptance
claim. Wheel departures beyond 0.08 m of the native road/kerb now also reject
clean-pass credit, and their timing prevents later faults from being mislabelled
as tactical necessity.

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
