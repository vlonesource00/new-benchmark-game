# SPEARHEAD combat momentum candidate

This continues the pursuit work on `graphics-aaa` at `6ae62cc`. It remains a
development candidate; braking-zone conversion and consistent wins over CRV
are still open. The earlier pursuit measurements are in [PURSUIT.md](PURSUIT.md).

## Changes

- A physically separated pullout retains drive just before front-quarter
  overlap, provided the immediate swept bodies remain clear. A measured cut-in
  and a blocked forward corridor retain braking authority.
- When a new steering command would cross an overlapping car, the guard first
  limits that command toward the existing clear course. It checks nearby cars
  and road room before doing so; this is not permission to push through a body.
- The host feedback loop remembers the steering actually issued by the guard.
  Restoring an older worker reply therefore cannot restart a clipped merge or
  make the steering slew originate from a command that was never applied.
- A defender keeps the fast course when a rear pursuer's changing lateral
  speed predicts a catch beyond the 1.15-second reaction window. Longer
  hypotheses still rank the maneuver, and the complete road continuation
  remains validated. Immediate rear sweeps and attacker merges retain their
  native vetoes. This addresses a GT3 first-corner failure also reproduced
  on the previous `c515813` candidate.
- GTP compares complete candidate maneuvers at 60 Hz, then validates the chosen
  course again at the original 120 Hz over the complete horizon. Rejected
  alternatives cost less CPU without shortening the corner/exit comparison.
  GT3 retains 120 Hz comparisons: a wider trial at 60 Hz caused a defense
  regression and was removed from its configuration.
- Timing diagnostics separate route construction from native admission. The
  paired profiling tool captures every planning event, rather than a sampled
  subset of debug frames. Encounter reports now include rival incidents too.

Live vehicle and tyre physics, independent line geometry, resource policy,
endurance strategy, weather configuration and other drivers were not edited.
The driver continues to write controls only.

## Native verification

The check suite passes 49 checks. Tests cover both pullout sides, front/rear
overlap, actual native body separation, immediate cut-ins, full 120 Hz final
admission and delayed worker feedback. All 16 retained encounters pass at
20/30/60 Hz with delayed replies and bursts: zero contacts, off-tracks or stops.

Eight 16-second warm-soft encounters against the actual CRV bridge retain two
clean straight passes and four defenses without contacts or off-tracks. The
same-rival tactical ablation fails to pass in both straight attacks, so these
passes are attributed to a maneuver. Neither braking-zone attack converts.
Unsafe ablation runs are not used as clean pace comparisons.

| Controlled defense | Final advantage | Position lost | Contacts |
| --- | --- | --- | --- |
| GT3 straight | 10.50 m | No | 0 |
| GT3 braking zone | 25.02 m | No | 0 |
| GTP straight | 19.81 m | No | 0 |
| GTP braking zone | 22.35 m | No | 0 |

The four paired defense ablations also hold their positions cleanly. Their
sector times match the tactical runs; this demonstrates preserved pace and
safe position retention, not a special blocking move that the fast line
could not accomplish.

In the paired GTP planning profile, each ABBA run captured 46 plans. Mean
admission time fell from 63.46 to 47.61 ms (25%); whole-plan time fell from
71.49 to 56.02 ms (22%). All four runs held the CRV pass at 6.308 s, traveled
550.158 m in eight seconds, and had zero contacts or off-tracks for either car.
These are local CPU measurements, not a guarantee about every machine.

## Worker races

Worker race verification uses Harbor Ring, Alien, softs, clear weather, seed 7,
rolling starts and the actual AsyncSeats path with CRV and SOLSTICE. Recorded
lap/sector times come from the native timing lines. Runs have a finite green
window so an unfinished SOLSTICE GTP run does not dominate the test duration.

| Class | SPEARHEAD best lap | CRV best lap | Race result | SPEARHEAD incidents | Fleet contacts |
| --- | --- | --- | --- | --- | --- |
| GT3 | 62.13 s | 63.62 s | SPEARHEAD wins by 2.94 s | 0 | 0 |
| GTP | 53.70 s | 53.44 s | CRV wins by 0.33 s | 0 | 0 |

SPEARHEAD and CRV have zero damage and worker errors in both races. All three
cars are incident-free in GT3. The unchanged SOLSTICE driver has 15 incidents
and damage in GTP, so that run is primarily a SPEARHEAD-versus-CRV comparison.

Before the rear-prediction fix, the same GT3 race produced six SPEARHEAD
incidents and a contact. A separate checkout of `c515813` also reproduced the
first-corner off-track in a 35-second green window. The final candidate keeps
the course through that corner. GTP's opening sector is 14.07 s versus the
earlier 17.83 s; its race gap falls from 4.00 s to 0.33 s. Real-time worker
scheduling varies, so these results establish an improvement in the measured
runs, not a universal win rate or a causal split between individual changes.

The worker tool now accepts `--assert-clean=next-racer`: it returns a failing
exit code for any fleet contact or incidents, errors or damage on the named
seat. Raw race reports remain available even when that check fails.

## Remaining work

- Convert viable braking-zone attacks without a tight, slow apex or a premature
  return across the rival's lane. Faster transfers, forced route retention and
  extra pedal feed-forward did not reliably solve this and were rejected.
- Consistently beat CRV in races, including late-sector traffic. A quicker
  opening or a faster best lap alone does not establish that result.
  The latest GTP worker best lap also remains above the sub-53 s target.
- Recheck endurance fade and wet/other-circuit behavior with the new combat
  policy. Earlier endurance numbers in PREVIEW.md remain historical results.

## Reproduction

```sh
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/check.mjs
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/regressions.mjs --out=subjects/next-racer/results/momentum-regressions.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/pursuit.mjs --opponent=claude-revolution --class=gt,lmdh --filter=pass --seconds=16 --out=subjects/next-racer/results/momentum-attacks.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/pursuit.mjs --opponent=claude-revolution --class=gt,lmdh --filter=defend --seconds=16 --out=subjects/next-racer/results/momentum-defense.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/planning-profile.mjs --out=subjects/next-racer/results/momentum-profile.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/worker-duel.mjs --drivers=next-racer,claude-revolution,solstice --class=lmdh --realtime --seconds=125 --assert-clean=next-racer --out=subjects/next-racer/results/momentum-gtp.json
node --import ./scripts/json-loader.mjs subjects/next-racer/tools/worker-duel.mjs --drivers=next-racer,claude-revolution,solstice --class=gt --realtime --seconds=150 --assert-clean=next-racer --out=subjects/next-racer/results/momentum-gt3.json
npm run game:build
```

Reports and raw traces remain in the ignored results folder with source hashes.
