# solinator 6.1

An independent research controller using Cartesian road gates and exact-plant maneuver transfers. See [ARCHITECTURE.md](ARCHITECTURE.md) for the competitor audit, design differences and falsifiable acceptance criteria.

Requires the current `../Phantom/benchmark` checkout and Node. No dependency installation is needed. The six-car Benchmark includes solinator plus Gemini Supreme v4, PHANTOM, VORTEX, DeepSeek NOVA and Astra. Rival controllers, physics, setups and track are unchanged; only registration, presentation and build integration are extended.

```powershell
cd '../solinator-6.1'
npm test
npm run solo
npm run race
npm run campaign
npm run tactical
```

`node scripts/evaluate.mjs --solo --laps 8 --full` returns the exact protocol, lap validity, four-wheel resources and source hashes. `--telemetry` adds samples; `--order gemini-supreme-v4,phantom,vortex,nova,astra,solinator-6.1` selects a rear grid. `--rotations` exercises all six grid positions. `scripts/learn-gates.mjs` optimizes independent world-space gate displacements against a complete physical stint; experimental scout scripts are not promoted automatically.

The Benchmark bridge is exported as `createSolinatorBridge` from `src/driver.js`. The standalone harness binds it after `Session.start()`, using the existing competitor adapters. The new controller imports only the physical vehicle/tyre laws from Benchmark. It does not import a competitor controller, racing line, oracle or ghost.

The target is a **valid 1:13.000** with sustained pace and effective combat. Actual measurements and implementation limitations are recorded separately in `RESULTS.md`; the target must not be presented as achieved without a measured valid lap.

The earlier five-position campaign used Supreme 3.2 and omitted PHANTOM. It does not rank the current field. Current measurements are recorded first in `RESULTS.md`. The faster free-air execution uses the host power curve, a live tyre envelope and independently learned gate geometry. Physical transfer search handles encounters and return maneuvers. The browser runs the native controller in Benchmark's existing worker transport without changing its 120 Hz physics.

Build and launch the current game:

```powershell
cd '../Phantom/benchmark'
npm run sandbox:build
npm run serve
```

Open `http://127.0.0.1:4186/?mode=5-arch` for the six-car cup. The original five rivals retain their grid positions and solinator starts sixth; the camera selects solinator. The legacy mode key is retained for existing links. `--order solinator-6.1,gemini-supreme-v4,phantom,vortex,nova,astra` reproduces the front-grid test, including its reported invalid opening lap.
