# Investigation results

Game baseline: `ea7b402ad02b0558e5c1d2e06627a1992e2d1971`.
This records the **architecture investigation**, not a new driver's performance.
There is no implemented or registered `next-racer` controller.

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

## Still unmeasured

Every proposed gate in [ACCEPTANCE.md](ACCEPTANCE.md) remains pending for the new
driver: adaptive combat conversion, defense budgets, actual worker performance,
native integration, planned-stint fade, GTP <53 s, GT3 <64 s and full-race results.
The earlier SOLSTICE race reports and the other new architecture's printed solo
baselines do not establish any of those results for this design.

The work changed only this new subject's investigation files. SOLSTICE's runtime,
config/data and the game's behavior were not modified by the investigation.
