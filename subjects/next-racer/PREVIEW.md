# SPEARHEAD development preview

This branch contains the candidate served for manual testing. Combat validation
is incomplete; this is not the final racer.

The candidate has independent Harbor GT3/GTP line bakes, reduced steering feedback
gains, refreshed passing decisions instead of the short commitment lock, and
native predictions of feedback from the previously delivered route during worker
reply delay. All runtime changes are confined to `subjects/next-racer/`.

Validation at publication:

- Production game build passes.
- `node --import ./scripts/json-loader.mjs subjects/next-racer/tools/check.mjs`
  passes 25 control, prediction, lifecycle and integration checks.
- Matched two-lap Harbor soft-tyre development comparisons demonstrated GTP laps
  of 52.51 and 52.67 seconds, a 3.48-second win against CRV, and zero contacts or
  incidents. A GT3 candidate demonstrated 62.38 and 62.74 seconds and a
  2.63-second win. These are individual comparisons, not an endurance guarantee.
- The latest completed retained stress run before extending the serialized
  course's rear support passed 10 of 16 cases. Failures include contacts in two
  GTP passing fixtures, road/wheel excursions, and a GT3 twin encounter without
  demonstrated tactical advantage. The assertions and fixtures remain in source.
- Current endurance fade, live worker stress and changeable-weather validation
  still need completion before final acceptance.

For manual comparison use AI Duel, Harbor Ring, Alien, soft tyres, and SPEARHEAD
(SPH) versus CLAUDE REV (CRV). Record the class, corner, tyre condition, and whether
the problem is braking, steering reversal, lateral clearance or acceleration
alongside. Ignored scratch options, local race dumps and server logs are not
part of the published candidate.
