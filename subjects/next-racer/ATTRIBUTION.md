# Pass attribution: maneuver or normal trajectory?

This is a prototype checkpoint, not acceptance of the completed racer.

`tools/attribution.mjs` runs each encounter twice. Both runs retain the rival,
native physics, tyres, resources, cadence and forward collision guard. The
ablation disables maneuver search and follows the same nominal racing line.
An adaptive rival retains the same controller but can react differently to the
two runs; this comparison does not freeze its future trajectory.

An intentional move requires a selected combat route, sustained physical
departure from the nominal path before overlap, and lateral departure at
overlap. A clean pass must clear both bodies, stay ahead for one second, reach
the next corner gate, remain held at the end, and have no contacts or off-tracks.
Route names alone are insufficient. Results record runtime source hashes.

## Measured checkpoint: Harbor, warm hards, 30 Hz, 24-second encounters

These paired runs include one frame of control delay and occasional 75 ms
delivery bursts. The figures below were captured after delivery-lag prediction,
before the subsequent body/kerb guard correction. Later source changes retain
the raw source hashes, and require renewed paired results before acceptance.

| Encounter | GTP combat / nominal | GT3 combat / nominal | Interpretation |
|---|---:|---:|---|
| Straight | 4.33 / 7.57 s | 5.06 / 8.52 s | A lateral move speeds up the pass |
| Late straight approach | 4.85 / 8.88 s | 5.61 / 9.90 s | A lateral move speeds up the pass |
| Rival on the exact fast line | 4.34 / no pass | 6.20 / no pass | A move enables the pass |
| Same line on a shallow bend | 5.66 / no pass | 9.09 / no pass | A move enables the pass |
| Independent SPEARHEAD, closing approach | 4.33 / no pass | 5.05 / no pass | A move enables the pass |
| Gap between two cars | 5.34 / 5.41 s | 5.06 / 5.04 s | Normal trajectory; no tactical credit |
| Left bend | 8.35 / 6.50 s | 8.49 / 7.30 s | A move is slower; nominal also passes |

The straight moves depart roughly 2.5–2.7 metres from the usual line at
overlap. The nominal-only cars eventually pass the fixed-lane straight rival
when their usual paths diverge, which explains why a simple pass count can
overstate combat ability. They do not pass the rival following the exact fast
line in these 24-second tests.

An unsafe nominal run is not automatically evidence that a move enabled a
pass. If the nominal car already completed its pass and then failed at a later
corner, report that later failure separately. The attribution tool now gives
clean-pass credit only for a fault occurring during passage; it does not turn
an unrelated post-pass error into claimed tactical necessity.

The braking-zone rival following the exact fast line remains unpassed. Equal
SPEARHEAD cars with an initial 30-metre gap also do not pass in this window.
The closing SPEARHEAD fixture deliberately gives the leader more worn tyres
and lower initial speed, so it tests conversion of an actual approach.

Prescribed controls-only route probes found no clean braking-zone passing
witness among the tested 18 offset/duration combinations. This is a limited
search and does not establish that a pass is physically impossible.

## What remains

The left-bend comparison exposes wasted movement: nominal continuation wins
on time and should receive credit when it already supplies separation.
The later 108-trial defense checkpoint met the sector and exit-speed budgets
with no contacts, off-tracks or stopped periods, and retained all 108 leads.
The full mixed combat corpus still requires acceptance after the body/kerb,
held-lane fallback and evaluated-action corrections. Those corrections do not
turn an ordinary nominal-line pass into tactical credit. The overall combat,
pace and fade gates have not passed.

Reproduce with:

```sh
node subjects/next-racer/tools/attribution.mjs --class=lmdh --seconds=24 --delay-frames=1 --burst-ms=75
node subjects/next-racer/tools/attribution.mjs --class=gt --seconds=24 --delay-frames=1 --burst-ms=75
node subjects/next-racer/tools/opportunity.mjs --class=lmdh --case=hotline-braking
node subjects/next-racer/tools/regressions.mjs
node subjects/next-racer/tools/campaign.mjs
```

Raw traces stay in the ignored `results/` directory. The native trajectory and
counterfactual verdict are recorded separately so future tuning cannot turn
natural passes into claimed tactical successes.
