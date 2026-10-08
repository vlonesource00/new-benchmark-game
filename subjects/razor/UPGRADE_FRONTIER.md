# RAZOR upgrade frontier

RAZOR has not reached a demonstrated architecture limit. A successful short
encounter or a strategy win does not establish universal combat or endurance
superiority. Preserve paired attacks-disabled controls and count executed moves
separately from faster-line passes.

## Current 963e019 checkpoint

The latest shared tyre recalibration is included. The native suite passes 69
checks and 33 encounters, with no hard contact, off-road time or controller
error. GTP executes paired worker passes at 20/30/60 Hz and during cadence
changes; the corresponding following controls do not pass. Small side contact
remains, below 0.7% damage in the staged runs.

The final unchanged 30 Hz worker suite passes only one of four matchups. GTP
passes RAZOR but has 15 light-contact steps; GTP fails to pass APEX while the
following control passes at 9.62 s; GT3 fails to pass RAZOR. Only GTP through
APEX GT3 satisfies the existing clean causal-pass check. None of the four
attack runs goes off-road or has a severe contact. Restore the missed GTP/APEX
conversion and improve GT3 tactics before calling the worker combat complete.

GT3's slower worker pass remains clean. A roadside-gap check removes the
30 Hz self-fight road departure, but matched GT3 30/60 Hz still follows rather
than converting. Supplemental native GT3 self-fights remain on-road at all
three cadences without converting. This is an unresolved tactical gap, not a
completed architecture. Mid-corner conversion, moving multi-row routing and
human defense also need stronger evidence.

RAZOR now has its own clear-Harbor stint priors for the current tyre model.
Twenty-lap native GTP/GT3 probes finish with two/one stops and maximum valid-lap
stint spreads of 1.36/2.98 seconds. Fuel, compulsory swaps and caution calls
work in the checked native scenarios. Other tracks and weather retain the
inherited policy; rain is not retuned. Two completed native ten-car Harbor
runs both finish RAZOR first and second but disagree on incidents: the first
has one field-wide severe contact and 12.7% damage on both RAZOR cars, while
the repeat has no severe contact and 1% damage. This discrepancy still needs
a reproducible collision trace. Timeout is not a passing result.

Next priority: convert reachable GT3 gaps without committing to an outside
lane that closes in the braking zone. Keep the actual worker and the paired
following control in every acceptance test. Do not replace a failed conversion
assertion with an intent label or an incident-assisted position gain.

## Historical cc5aead control-cadence checkpoint

The current base is `cc5aead`, including the shared tyre/energy/strategy update.
Held-control physics prediction restores GT3 straight acceleration at 20/30 Hz
without reducing its calibrated feedback gains. A matched 20 Hz GT3 worker
fight converts a clean causal pass; 30 Hz still does not convert. Normal 60 Hz
straight behaviour is unchanged. See `PROGRESS.md` and `tools/cadence.mjs`.

The completed-pass return now fixes the native matched GTP 30 Hz hard contact:
the strict suite passes all 67 checks, with no hard contacts or off-tracks over
33 encounters. It finishes the pass before the next braking zone instead of
retaining a costly side lane. This does not solve matched 30/60 Hz GT3 tactics.
Changing-rate worker combat still rubs repeatedly and fails to secure a pass;
forecast transitions need more validation. The architecture still needs stronger
matched-cadence combat, multi-car routing and new stint priors. Do not treat
the old endurance figures below as results for the new shared tyre model.

## Forecast and departure evidence

The fast-line scoring origin now matches the observed-pose origin of passing
corridors. The strict suite passes 67 checks and 33 encounters, with no hard
contacts or off-tracks and 83 light-contact steps. Clean worker passes against
RAZOR at 20 Hz and APEX at 30 Hz remain; matched 30 Hz GT3 still does not pass.

The reproducible forecast audit finds several metres of position uncertainty
by one second in the corner-entry tail, and about 16.6 m p95 by 3.4 seconds.
The Cartesian forecast lowers some median errors without improving that tail.
Treating these long-range body forecasts as firm occupancy loses existing
passes. The revision remains a diagnostic tool, outside the live driver.

A short delayed departure retains tow before forming the passing lane and
reduces the fixed-30-Hz GT3 missed-pass deficit. It converts the variable-rate
fight, but repeats side contact and costs about 4% damage in 24 seconds. Wider
clearance retention and time-aligned body guards cause off-track regressions
in some combinations. They are reproducible opt-in tools, not production
options. Lane ownership, reachable separation and changing-rate control
response must be resolved together before accepting that departure policy.

## Earlier checkpoint before the shared tyre update

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
