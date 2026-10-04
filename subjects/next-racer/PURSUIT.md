# SPEARHEAD pursuit and defense candidate

This follow-up to `d86e9d1` addresses racecraft that sacrifices approach pace
without a reachable pass or a closing threat. Combat is still under development;
the candidate has not established consistent race wins over CRV.

## Behavior

- Attack acquisition uses measured closure or a reachable braking opportunity
  within three seconds. Equal-paced or receding rivals do not justify moving
  away from the fast line merely because they fall within the observer's range.
- A stale attack or defense releases after half a second outside the wider
  reachability window. Physical overlap retains corridor ownership.
- A rear threat uses bumper closing time; physical overlap also counts when
  the pursuer's instantaneous speed drops during a corner.
- Before overlap, alternatives must preserve at least 97% of the guarded free
  route's native prefix progress plus exit momentum, when that route is safe.
  The budget does not exclude a needed escape when the free route is unsafe.
- Distant possible collision branches have declining scoring weight for
  defense as they already did for attack. Immediate native body vetoes and
  the live guard remain authoritative.

Physics, the independent lines, tyre management, the endurance planner, host
integration and the other drivers are unchanged by this candidate.

## Evidence before the upstream CRV update

All controlled encounters below used Harbor Ring, warm softs, native physics,
30 Hz observation and a 16-second window. They are not cold race-start tests.
The actual rival bridge receives its own controls without SPEARHEAD's guard.

| Encounter | Candidate | Tactical-route ablation |
| --- | --- | --- |
| GT3, closing on CRV on the straight | Clean held pass at 6.18 s | No held pass |
| GTP, closing on CRV on the straight | Clean held pass at 6.31 s | No held pass |
| GT3, defending against CRV on the straight | Position held, 9.57 m ahead at the end | Off-track; unsuitable as a clean pace comparison |
| GT3, defending against CRV at the braking zone | Position held, 25.05 m ahead | Position lost |
| GTP, defending against CRV on the straight | 16.48 m ahead at the end | Old tactical behavior ended 31.08 m behind |
| GTP, defending against CRV at the braking zone | 11.98 m ahead at the end | Old tactical behavior ended 12.66 m ahead |

Each listed candidate encounter had zero contacts and zero off-tracks. The
straight attack verdict requires a pass that is held and a paired run against
the same rival with tactical routes disabled; fast-line progress alone does
not count as an attributed maneuver. Defense holding is reported separately.
The GTP braking-zone defense traveled 10.30 m less than the old tactical run:
the improvement is not universal.

Equal-paced twins kept the same time and speed at the initial straight exit as
the paired guarded fast-line run. Closing twins retained the earlier clean
passes. The retained suite passed 16/16 encounters, including 20/30/60 Hz and
delivery delays, with zero contacts, off-tracks or stops. The check suite passed
46 checks.

## Remaining failures

- Neither class converted the tested CRV braking-zone attack. In GT3 the
  candidate initially separated and accelerated, then returned to the free
  line before overlap. Forced corridor retention and faster lane transfers
  both worsened native progress and were removed.
- A real-time three-car GTP worker race on `d86e9d1`, softs, clear weather,
  rolling start, seed 7, gave SPEARHEAD a 52.07 s best versus CRV's 52.89 s,
  but SPEARHEAD finished 5.31 s behind. Its first sector on lap one lost
  3.78 s to CRV. There was one light contact; SPEARHEAD had no off-tracks.
  SOLSTICE incurred seven incidents and did not provide a useful GTP pace
  comparison. SPEARHEAD's 95th percentile worker latency was 23.44 ms.
- Earlier tight-overlap, other-circuit and Changeable-weather limitations
  remain open. This candidate does not retune them or establish endurance
  results for the new combat rules.

## Reproduction

```sh
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/regressions.mjs --out=subjects/next-racer/results/pursuit-regressions.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/pursuit.mjs --opponent=claude-revolution --class=gt,lmdh --filter=pass --seconds=16 --out=subjects/next-racer/results/pursuit-crv-attacks.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/pursuit.mjs --opponent=claude-revolution --class=gt,lmdh --filter=defend --seconds=16 --out=subjects/next-racer/results/pursuit-crv-defense.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/worker-duel.mjs --drivers=next-racer,claude-revolution,solstice --class=lmdh --realtime --seconds=125 --out=subjects/next-racer/results/pursuit-three-car.json
npm run game:build
```

`pursuit.mjs` also supports `--opponent=solstice`, equal-paced adaptive twins,
`--filter=close-twin`, `--hz`, and an options file for controlled ablations.
Results include source hashes and full traces in the ignored results folder.
