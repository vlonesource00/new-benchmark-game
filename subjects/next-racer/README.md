# Next racer: architecture investigation

This is the design for a **separate driver**, with GTP as its primary class and
GT3 as a second class. `next-racer` is a working directory name, not a registered
driver. SOLSTICE's source, tuning and baked lines remain unchanged.

The user's targets apply to Harbor Ring: **GTP below 53 seconds**, **GT3 below
64 seconds**, and **no more than four seconds of fade before the planned pit
window**. Combat comes first. This investigation does not implement a controller
or claim to have achieved those targets.

- [GAME-AUDIT.md](GAME-AUDIT.md): the current game's control order, physics,
  hybrid, endurance, race-control and worker contracts, with concrete gaps.
- [ARCHITECTURE.md](ARCHITECTURE.md): a maneuver planner that chooses complete
  passing and defending routes, followed by native physics validation.
- [ACCEPTANCE.md](ACCEPTANCE.md): the combat gates that must pass before pace
  tuning, and the later pace, resource and full-race gates.
- [RESULTS.md](RESULTS.md): completed investigation checks and explicitly pending
  performance gates for the future driver.
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
architecture's combat ability. There is no new runtime to benchmark yet.

Continue on `origin/graphics-aaa`, fetching and rebasing before implementation
and before publishing. PR #1 was already merged into that branch. The latest
game used here also appears on `origin/main`; the user's instruction to use
`graphics-aaa` remains the working-base rule.
