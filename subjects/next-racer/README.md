# SPEARHEAD: separate GTP / GT3 racer

SPEARHEAD is an experimental **separate driver**, registered as `next-racer`,
with GTP as its primary class and GT3 as a second class. SOLSTICE's source,
tuning and baked lines remain unchanged. SPEARHEAD owns an independent copy of
the baked geometry as a warm start; its runtime does not import SOLSTICE.

The user's targets apply to Harbor Ring: **GTP below 53 seconds**, **GT3 below
64 seconds**, and **no more than four seconds of fade before the planned pit
window**. Combat comes first. The runtime is implemented; the complete combat,
pace and planned-stint gates have not passed.

- [GAME-AUDIT.md](GAME-AUDIT.md): the current game's control order, physics,
  hybrid, endurance, race-control and worker contracts, with concrete gaps.
- [ARCHITECTURE.md](ARCHITECTURE.md): a maneuver planner that chooses complete
  passing and defending routes, followed by native physics validation.
- [ACCEPTANCE.md](ACCEPTANCE.md): the combat gates that must pass before pace
  tuning, and the later pace, resource and full-race gates.
- [RESULTS.md](RESULTS.md): runtime checks, integration results and pending gates.
- [ATTRIBUTION.md](ATTRIBUTION.md): paired tests separating actual passing moves
  from passes that the normal trajectory already supplies.
- [analysis/game-audit.json](analysis/game-audit.json): reproducible observations
  and source hashes, captured at game commit `ea7b402ad02b0558e5c1d2e06627a1992e2d1971`.

Run the read-only contract investigation from the repository root:

```sh
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/next-racer/tools/game-audit.mjs
```

The probe constructs isolated native race, qualifying and rolling-start
observations plus a hybrid transition. It outputs
JSON to stdout and does not write game state, tune a driver or measure a lap.
Its transport observations inspect source; they are not a browser-worker test.

The latest game build and SOLSTICE's 33 existing checks passed during this audit.
Those checks protect the existing driver; they do not establish this new
architecture's combat ability.

Run the new runtime checks and encounters from the repository root:

```sh
node subjects/next-racer/tools/check.mjs
node subjects/next-racer/tools/attribution.mjs --class=lmdh --seconds=24 --delay-frames=1 --burst-ms=75
node subjects/next-racer/tools/campaign.mjs
node --no-warnings --loader ./subjects/solstice/tools/json-loader.mjs subjects/next-racer/tools/worker-probe.mjs
```

The campaign varies public poses, gaps, speeds and rival lanes, uses 20/30/60 Hz
held controls with one frame of delay and occasional 75 ms bursts, and checks
declared native trajectory witnesses before the candidate. A witness can prove
an opportunity exists; failure to find one does not prove impossibility.
Raw traces stay in the ignored `results/` directory.

The controller owns observations, episodes, independent tyre/force envelopes,
world and road passing routes, native prefix validation, feedback escapes and
delivery-lag prediction. Native host strategy, hybrid operation, pit service,
swaps, qualifying and formation remain in charge. The additive registration
uses the existing Alien-only governor bypass; lower difficulties retain their
native cap. Worker state and the short stamped route preview are specific to
this driver. Its private pit surface view leaves the shared worker track alone.

Continue on `origin/graphics-aaa`, fetching and rebasing before implementation
and before publishing. PR #1 was already merged into that branch. The latest
game used here also appears on `origin/main`; the user's instruction to use
`graphics-aaa` remains the working-base rule.
