# SPEARHEAD development preview

This branch contains the candidate served for manual testing. Combat validation
is incomplete; this is not the final racer.

The candidate retains its independent Harbor GT3/GTP line bakes and smooth live
steering feedback. A physically clear overlap now keeps the requested drive
command instead of applying lead-car following speed because the planned course
eventually returns toward the racing line. The host checks both bodies over the
next 0.24 seconds, including our requested steering change. Cut-ins and commands
that cross the rival still have braking authority.

Attack corridors offer a closer margin during overlap, measured from both rotated
bodies. The full native trajectory checks still admit each candidate. The four
separating-axis body checks share orientation terms to reduce prediction cost.
All runtime changes are confined to `subjects/next-racer/`. This preview is based
on `graphics-aaa` at `6a64e5b`, including the upgraded CLAUDE REV.

Validation at publication:

- Production game build passes.
- `node --import ./scripts/json-loader.mjs subjects/next-racer/tools/check.mjs`
  passes 29 control, prediction, lifecycle and integration checks, including
  drive during clear overlap, real cut-ins, crossing steering commands and 600
  rotated native collision-hull comparisons.
- Native worker tests use Harbor Ring, soft tyres, Alien, seed 7, two laps,
  rolling starts and the game's 12-lap duel fuel calibration:
  - GTP alone at a fixed worker cadence: 52.43 / 52.73 seconds, no incidents.
  - GTP against current CRV with real-time replies and CRV on pole: SPEARHEAD
    53.66 / 53.83, CRV 52.42 / 52.81. CRV wins by 2.56 seconds. No contacts,
    incidents or damage. SPEARHEAD's second-lap first sector is 13.93 seconds
    against CRV's 13.35; T1 braking and exit speed remain an optimization target.
  - GT3 against current CRV at a fixed worker cadence with CRV on pole:
    SPEARHEAD 62.62 / 62.66, CRV 63.86 / 62.80. SPEARHEAD wins by 1.65 seconds,
    with no contacts, incidents or damage.
  These are individual comparisons. Real-time reply delay and traffic still
  affect GTP pace; they are not an endurance or consistent-win guarantee.
- The retained stress suite passes 12 of 16 cases, with zero contacts and stops.
  Remaining failures are GT3 wheel excursions at 20/60 Hz, a late GTP 20 Hz road
  excursion (0.383 seconds), and a GT3 twin encounter that does not hold its pass.
  Additional tight corner-overlap probes also expose unresolved contact cases.
  The assertions and fixtures remain in source.
- Current endurance fade, live worker stress and changeable-weather validation
  still need completion before final acceptance.

For manual comparison use AI Duel, Harbor Ring, Alien, soft tyres, and SPEARHEAD
(SPH) versus CLAUDE REV (CRV). Record the class, corner, tyre condition, and whether
the problem is braking, steering reversal, lateral clearance or acceleration
alongside. Ignored scratch options, local race dumps and server logs are not
part of the published candidate. `tools/alongside.mjs` records the selected drive
command and live guard reason; `tools/worker-duel.mjs` runs the actual AsyncSeats
path and records native sector times. Source stamps include the rival's code so
comparisons against different CRV revisions remain distinguishable.
