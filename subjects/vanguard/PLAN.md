# VANGUARD continuation

Keep Argon's design: a physics-rate local force controller, asynchronous worker planning, spatial C2 route contracts, connected traffic corridors, inertial hazard forecasts, and live resource/strategy planning. Continue the existing implementation; do not replace it with an RL policy or a different controller architecture.

Argon's 24 source/integration files were preserved before editing in the workspace's `vanguard-audit-2026-10-16/argon-baseline/` directory.

## Work order

- [x] Reproduce the mixed-grid race failure and preserve the baseline.
- [x] Fix returning alongside a rival: forecast the closing body gap, retain the axle brake allocator, and back out until longitudinal clearance exists. Avoid braking in front of a car already passed.
- [x] Strengthen the original mixed-grid smoke test to require zero contact/damage. All six existing encounter cases still pass.
- [x] Run a reproducible pace/reliability matrix across all five tracks, both classes, rain and worn tyres. Correct the benchmark's post-start tyre setup and preserve failures in the reports.
- [x] Complete measured-delay route handoffs using the existing C2 contract design. Exact short held-control prediction, injected delays and stale-contract checks pass.
- [x] Complete clean-air slip adaptation, per-station surface ceilings and staged wet-line selection with a paired pace gate.
- [x] Add the defended-corner switchback candidate to the existing corridor/rollout machinery; keep it inside the original candidate budget.
- [x] Verify real browser workers and the production build. Keep generated traces out of the source commit.
- [x] Correct the reduced-grip GT braking forecast. The final dry/rain/worn sweep passes all 30 cases, three valid laps per case and no damage.
- [x] Complete GTP team-seat integration and add actual race-length/classification support to the benchmark.
- [x] Trace conservative combat, test earlier commitment and tighter spacing, reject the regressing variants, and fix admissible-candidate ranking without increasing the collision budget.

## Performance work still open

- Establish a same-pace combat gain across fresh seeds and proper race finishes. Current five-car spot checks show competitive lap pace but poor conversion of attacks into retained passes.
- Keep the wet Nürburgring GT3 and heavily worn Harbor GT3 cases in the acceptance matrix; both now pass after the braking correction.
- Treat rolling-start formation failures separately from VANGUARD's own control. The shared formation controller owns applied commands until release.
- Validate the switchback candidate in a retained-pass scenario before claiming that the manoeuvre improves race results.

Tests and benchmarks must keep clean/dirty passes separate, preserve game lap legality, and report limitations. The proposal's timing budgets and claims of dominance are targets, not established facts.
