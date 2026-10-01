# Astra benchmark candidate

The sibling `../benchmark` working tree now registers Astra as the fifth candidate in the live shared-physics and native-physics interfaces. It imports an isolated, detached clone at `subjects/astra`, pinned to `709ed88d4aa0bb5f58b8ec8e655a40d016d23cbb` from `https://github.com/vlonesource00/astra.git`, branch `benchamrk-made`. This restores v1.1 AI behaviour with class and track-width compatibility. The experimental Harbor controller and entry-line tuning were reverted at the user's request. Later documentation commits do not change this source pin.

The adapter converts world position, velocity, tyres and controls at the boundary. Harbor Ring uses the opposite lateral sign in the host. Shared mode applies Astra's actual control outputs to the host vehicle; native mode advances Astra's vehicle at 120 Hz. Native worlds do not share contact resolution, so that mode is a demonstration, not equivalent to a shared-physics race.

From the benchmark folder:

```powershell
node scripts/prepare-subjects.mjs --subject astra
node scripts/install-subject-deps.mjs --subject astra
node scripts/verify-pins.mjs --subject astra
node scripts/astra-integration-smoke.mjs
node scripts/run-benchmark.mjs --subject astra --suite quick
node scripts/tactical-replay.mjs --subject=astra
npm run sandbox:build
```

Validation on 2026-09-09:

- Exact origin, commit and clean clone verified.
- Both adapter modes pass 1,200 driving steps; coordinate conversion and native countdown hold pass.
- Quick suite: Harbor classes, mixed pack and lost-momentum passing all pass (three runs).
- Tactical replay: 80% expected decisions, 100% deterministic, zero errors. This reveals remaining tactical limitations; it is not a perfect result.
- Five-candidate production viewer builds. Browser native mode starts, shows Astra driving, and reports no console errors during the check.

The four pre-existing benchmark clones already contained edited AI files. They were preserved. Full all-subject pin verification therefore cannot be presented as clean, and those runs are not evidence for the architectural ranking in `ARCHITECTURE_COMPARISON.md`.

Integration changes live in the sibling benchmark working tree, whose unrelated pre-existing edits were not committed. The Astra game source is pushed independently. Key integration files are `sandbox/astra-bridge.js`, `scripts/astra-integration-smoke.mjs`, `scripts/astra-tactical-adapter.mjs`, the candidate manifest, controller/native bridges, selected-subject preparation/verification, and tactical replay registration.
