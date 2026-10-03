# CLAUDE REVOLUTION: results

All runs use the in-repo benches (`tools/`), medium tyres unless noted, through the
real `EnduranceRace` loop with stewards. The sim isn't deterministic, so single runs
vary by a few tenths and the odd position.

## Solo pace (`tools/lap.mjs`)

| Class | Track | Laps | Incidents |
|---|---|---|---|
| GTP | Harbor Ring | 54.9 (soft), 55.2–55.4 (medium) | 0 |
| GTP | Desert | 67.8 | 0 |
| GTP | Alpine | 64.1 | 0 |
| GT3 | Harbor Ring | 64.3–64.9 | 0 |
| GT3 | Desert | 81.0–81.2 | 0 |
| GT3 | Solenne | 63.8 | 0 |

Solstice is still 2.4 s/lap faster on GT3 Solenne (61.5). That gap is line pace, not racecraft.

## Duels vs Solstice (`tools/bench-duel.mjs`, rolling start)

The two cars start side by side, two-wide from the formation.

| Track | Class | CRV on the right of the front row (2 laps) | CRV on the left (3 laps) |
|---|---|---|---|
| Harbor Ring | GTP | CRV +162 m | CRV +158 m (passes into T1) |
| Desert | GTP | CRV +284 m | CRV +390 m |
| Alpine | GTP | SLC +26 m | CRV +495 m |
| Harbor Ring | GT3 | CRV +149 m | CRV +582 m |
| Desert | GT3 | CRV +218 m | CRV +338 m |
| Alpine | GT3 | SLC +35 m | CRV +383 m |

- CRV wins 10 of 12 duels and is clean in all 12.
- Solstice's only incidents were its own: off track and loss of control on GT3 Harbor.
- Against Gemini v4: GTP Harbor is clean, with CRV ahead by more than 1 km after 3 laps. GT3 Desert is split, at about 50–100 m either way, also clean.
- Multiclass `bench-race.mjs harbor-ring 4` (GTP and GT3, three AIs each): 0 incidents for every entry.

## Racecraft fixes in this round

- **Side-guard edge clamp.** The nudge was clamped to keep the car inside B, but the clamp also forced the nudge inward whenever the car ran wide of B. That is where the racing line hugs the edge. With any car near, this pulled CRV up to 2.5 m off its lane: a weave on every straight beside a rival. Zero nudge is now always allowed.
- **Alongside is not "ahead" or "behind".** A car within ±3 m of us lengthwise used to flip between being the lead (ATTACK) and the car to cover (COVER) on every plan, which made the steering swing. Now it is neither.
- **Rolling-start handover.** While the formation pilot still drives, CRV plans from where the car really is. Lanes leave in the car's current direction (a start-slope term in the shift profile), so the green flag no longer kicks the yaw and cuts the throttle.
- **Follow unless it gains the place.** CRV leaves the line behind a car only when the move is predicted to gain the position. A lane that merely gains metres is allowed only on a straight longer than the 4 s horizon. This stopped aimless outside lanes into braking zones.
- **Guard for a car moving onto our path.** A slower car that is beside our path now, but whose line (learnt, else ours) meets it before we reach it, is guarded early. This fixed a GT3 Desert hairpin rear-end. A car overlapping us and clear beside us is never followed, so the guard no longer hands over the place on a straight.

## Open

- **Alpine from the right of the front row.** Solstice takes the inside of T1, and CRV (up to 2 s/lap faster) can't find a pass on the twisty lap. The dive check rarely finds both room on the inside and an overlap at the apex from the following distance that dirty air allows.
- **Stretching dead tyres** needs a host TeamStrategist change, which is not made without approval.
- **Hybrid deploy intent** (`car.intent = { deploy }`) is still only a proposal.
