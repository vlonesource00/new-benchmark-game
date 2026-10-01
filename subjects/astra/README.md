# ASTRA Motorsport

A browser racing simulation with autonomous wheel-to-wheel racing, tyre and chassis physics, live race-engineer telemetry, and attack/defence path visualisation.

## Run locally

Requires Node.js and npm.

```sh
npm ci
npm run dev
```

Open the Vite address with `?showcase=1` for the autonomous six-car showcase.

```sh
npm test
npm run test:pack
npm run test:showcase
npm run test:racecraft
npm run test:racecraft:fierce
npm run build
npm run preview
```

`main` preserves the initial imported game. New race-flow and close-racing work lives on `v1.1`; see [v1.1 results](V1_1_RACE_FLOW.md). The historical `ASSERTIVE_RACECRAFT.md` describes the imported baseline, including its maximum-aggression limitation.

Simulation: `src/sim/`. Three.js rendering and debugger: `src/render/`. Blender source wheel asset: `art/blender/`, with its build script in `scripts/build-wheel.py`.

Phone access can use the PC's private Tailscale address and a Vite preview bound to that address. Keep the PC awake and Tailscale connected on both devices. Local attachments, dependency caches, builds and scratch benchmark output are excluded from Git.

The `benchamrk-made` branch adds GT, FWD Touring and Prototype, exact Harbor Ring geometry, waterfront scenery and class-aware pace/exit planning. Select the circuit/class in DRIVE, or open `?showcase=1&track=harbor-ring&class=prototype&camera=chase`. Use `grid=mixed` for a mixed-class field. Solenne remains available.

Read [the architectural comparison and upgrade scope](ARCHITECTURE_COMPARISON.md). Validate with `node tests/harbor-quality.mjs --check` and `node tests/harbor-quality.mjs --mixed --check`; set `ASTRA_LAPS=3` for multi-lap runs. Hybrid energy recovery and pit service are not part of these class presets.
