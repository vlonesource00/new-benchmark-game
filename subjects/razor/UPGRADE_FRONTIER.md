# RAZOR upgrade frontier

RAZOR has not reached a demonstrated architecture limit. A successful short
encounter or a strategy win does not establish universal combat or endurance
superiority. Preserve paired attacks-disabled controls and count executed moves
separately from faster-line passes.

## Current verified checkpoint

- Pooled paths restore their previous window before reuse. The old implementation
  retained 75 displaced stations in the direct reproduction; the new check also
  covers a wrapped window and preservation of the active path.
- 66 checks, 33 native encounters at 20/30/60 Hz: no errors, hard contacts or
  off-track time. There are still 60 light-contact steps across those encounters.
- Four real-worker 30 Hz matchups convert causal passes cleanly: GTP against RAZOR
  and APEX, GTP through GT3, and GT3 against RAZOR. These are staged warm-soft
  Harbor encounters, not a guarantee over arbitrary traffic.
- A separate 60 Hz GTP worker self-fight passes at 4.43 s; its control never
  passes. Both have zero contacts and off-track time. The previous broad GTP
  bounded-yaw experiment was rejected; the shipped GTP predictor is retained.
- The 60 Hz GT3 worker self-fight still fails: attack ends 17.1 m behind versus
  9.7 m for its control. Both remain on track without contacts.
- Seed-7 Clear endurance remains unchanged: GT3 wins the 12-lap hard start and
  normal 20-lap runs; GTP loses the normal 20-lap run by 10.61 s with an extra stop.

## Measured limits to address

1. Opponent movement during a committed corridor can invalidate its separation.
   Ordinary rivals do not trigger refitting until the existing rebuild time.
   Increasing that rate without preserving the measured motion introduces
   transient instability; staying committed and staying geometrically current
   must be handled together.
2. Candidate integration measures the ego distance along its displaced path but
   compares it directly with rival distance along the base line. Outer and inner
   paths have different arc lengths. Forecast coordinates, occupancy and scoring
   need a coherent definition; adjusting one score alone is insufficient.
3. GT3 at 60 Hz commits to an outside lane that narrows approaching the corner.
   The recorded trace remains stable and uses full throttle on the available
   straight, then brakes for the corner and returns without converting the pass.
   This is a tactical conversion failure, not evidence of a collision pedal cap.
4. Mid-corner equal-class attacks and native matched-60-Hz GTP conversion remain
   unresolved. Broad defense, dense traffic, track and seed coverage remain limited.
5. The GTP hard-stint fade has exceeded four seconds, and the normal GTP endurance
   planner spends an extra stop. Own tyre/stint priors need calibration before
   claiming both the fade target and the best race time.
6. GT3 Changeable stability and weather decisions remain unresolved. No rain
   retuning is authorized by this checkpoint.

## Rejected experiments

These were evaluated through isolated in-memory overrides and are not shipped.

- Refitting when rival deviation changed by 0.45 m: self-fight conversions regressed,
  with hard contacts/off-tracks in the native cadence matrix. One dummy-return
  metadata access also needed guarding. Do not copy the variant into production.
- Ideal Frenet incoming curvature with the existing bounds: no hard contacts or
  off-tracks, but light-contact steps rose from 60 to 273 and several self-fights
  stopped converting. The vehicle's public force-based acceleration is filtered;
  it is not an instantaneous curvature measurement during a transient.
- Converting candidate distance to base-line arc distance directly: the native
  matched-60-Hz GTP pass became clean, but GT3 passes failed at all three rates,
  one GT3 case went off track, and contact counts rose substantially elsewhere.
  Coordinate consistency remains necessary, but this isolated change is not an
  acceptable integrated solution.

## Next evidence required

Measure predicted versus actual longitudinal position, lateral separation and
exit speed through a corner for both cars, using the same world/road coordinates.
Then revise the fitted-path and opponent forecasting interface together, preserving
ownership through overlap and bounded control response. Re-run the passing worker
matrix, the failing GT3 60 Hz case, all native cadences and endurance after any
accepted change. Only call the current architecture a bottleneck when repeated
measurements show a limit that cannot be removed by correcting its present model
or policy; there is no evidence of an absolute maximum here yet.
