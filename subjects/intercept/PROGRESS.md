# INTERCEPT development evidence

Independent racer on `intercept-dev`, based on `graphics-aaa` through 48cb344, including the shared tyre, energy, weather, caution and field changes through d5b86f7. Other drivers are preserved. Development is paused at the user's request; no simulation campaigns are queued.

Engineering readiness is approximately 85% against the gates below, not a winning probability or an ETA. INTERCEPT drives all five circuits in both classes; consistent superiority in every race remains unproven.

## Accepted behavior

The bounded planner chooses connected corridors; the physics-rate executor follows them using fresh poses. Sides are latched, joins are continuous, arrays are private, and display labels never choose a pedal profile. Cached physical forecasts use public rival motion and controls, without reading their plans.

Recent eye testing identified rear-end damage behind early-braking tow targets and an extra stop soon after fitting new tyres. This round addresses those failures:

- Check an actually braking or pit-approach body on the route being executed, including around a bend outside the present body ray. Pit-lane cars remain excluded. Stable measured lateral escape permits acceleration; a proposed route alone grants no exemption.
- Preserve separation for new GTP passes of GT3s. A returning path holds occupied space instead of merging across another front/overlapping body, then compiles one fresh join when space opens.
- Do not yield behind a same-class rival. A broad first merge guard delayed a clean pass and caused contact; the retained-pass regression rejects that behavior.
- Compile smoothing in three bounded linear passes. Solenne GT3's shorter preview and yaw setting improve its clean solo best from 59.58 to 58.82 s.
- Price the actual circuit pit lane, tyre service and driver swap. Use measured tread wear for set age, preserving shared weather/caution decisions, fuel, mandatory stops and swaps.
- Record solver pairs, peak/cumulative damage and separate formation/racing damage. Pit repair cannot erase the safety history.
- Trace actual body-speed deceleration separately from bounded road-tangent acceleration. Strong prototype braking is not clipped in this diagnostic. Replacing the controller's road-progress braking hint with body deceleration worsened a matched race, so that control change is rejected.

## Completion gates

- [x] Independent control, bounded contracts, continuous joins and private buffers.
- [x] A clean retained maneuver around a rival on the fast line, through real seat-worker/controller code, at normal delivery and one extra frame of delay. The following-only control stays behind.
- [x] Three clean retained passes in the controlled GT3 train, including simulated reply spikes.
- [x] Actual Chromium workers survive tested 500/250 ms holds, retain three passes and report no worker/browser errors. The latest repeat is clean; a previous repeat had one light contact (0.33% damage), so this is not an all-cadence guarantee.
- [x] Regression coverage for pits, retired/off-road bodies, swaps, rain, Changeable weather, SC and FCY.
- [x] Clean solo driving on all five circuits; Harbor GTP below 53 s and GT3 below 64 s; measured Harbor stint fade below 4 s.
- [ ] Effective defense and further inside/outside/exit passes across matched grid orders, tracks and seeds.
- [ ] Fast recovery after every hazard; safe clearance alone does not satisfy this gate.
- [ ] Consistent endurance superiority over RAZOR, APEX and SPEARHEAD in large mixed fields and variable browser scheduling.

## Combat and latency

The worker pass fixture starts INTERCEPT 20 m behind RAZOR at Harbor position 250 m, at 60 vs 50 m/s. Both use ordinary physics and controls. One maneuver fully clears RAZOR and retains clearance for an uninterrupted second; the complete 30 s encounter is clean. One extra frame of delay produces another clean maneuver. The matched following-only run makes no pass. These initial conditions prove one executable move, not universal same-class superiority.

The Harbor train starts the GTP at 20 m and three RAZOR GT3s at 100, 180 and 260 m. Their speed is limited through ordinary pedals; cars are not moved or ghosted during the run. The trace continues through the subsequent corners.

Worker train: three clean retained passes, one new maneuver and two carried lanes, at 265.5 / 281.1 / 289.8 km/h. Straight delay is -0.204 s versus matched solo; drafting explains the negative delay. Simulated jitter/spikes preserve all three without damage. An early-braking target is passed at 243.6 km/h without a rear-end or straight damage. A later side rub remains in its 0.50% full-run damage total.

Latest Chromium delay repeat: three clean retained passes (two new moves and one carried lane), +0.460 s straight delay, no damage, contact, incidents or worker/browser errors. A previous repeat retained three passes with +0.434 s delay, 0.33% damage and one contact-assisted outcome. Maximum plan age is 1.28 simulated seconds. Headless cadence differs from laptop play; these validate the tested cases, not every device or delay.

Pinned stopped/spun bodies are cleared without damage or rescue. With two moving GT3s, straight delays are +0.402 / +0.603 s and speed recovery takes about 6.9 / 7.3 s. The 1.5 s gate stays open. An isolated spun body recovers in 0.42 s, demonstrating the need to distinguish isolated evasion from traffic.

## Pace and endurance

Matched worker solo baseline: warm softs, race fuel, seed 7. These are race-profile laps, not light-fuel qualifying; later Solenne GT3 control is noted above.

| Circuit | INTERCEPT GTP | RAZOR GTP | INTERCEPT GT3 | RAZOR GT3 |
| --- | ---: | ---: | ---: | ---: |
| Harbor | 52.01 s | 51.94 s | 61.27 s | 62.18 s |
| Solenne | 49.98 s | 49.85 s | 59.58 s | 59.01 s |
| Alpine | 59.85 s | 59.91 s | 71.32 s | 71.38 s |
| Desert | 64.70 s | 64.77 s | 77.47 s | 77.35 s |
| Nurburgring | 439.84 s | 456.20 s | 511.22 s | 534.18 s |

Every INTERCEPT baseline is clean. SPEARHEAD's cold Nurburgring setup exceeded the short probe's preparation timeout; its subsequent completed endurance race means this is not evidence that it cannot drive the circuit. INTERCEPT is not fastest in every class/circuit.

Twelve-lap Harbor worker races, seed 11, INTERCEPT starting last, after restricting the return guard:

| Class | INTERCEPT finish | RAZOR finish | Peak/cumulative damage | Own severe contacts | Stops/swaps |
| --- | ---: | ---: | ---: | ---: | ---: |
| GTP | 687.47 s | 688.31 s | 3.17% / 3.17% | 1 | 1 / 1 |
| GT3 | 807.44 s | 807.92 s | 2.06% / 2.06% | 0 | 1 / 1 |

Both win this seed, but GTP rear-ends SPEARHEAD in T1 and records one contact-assisted pass; it is not a clean-win claim. GTP also records one clean retained maneuver; GT3 records a retained pace pass. The preceding configuration's soft/medium fade was about 0.95/0.93 s in GTP and 2.42/2.23 s in GT3. Solenne GT3's pit-entry encounter improves from third with 7.50% peak damage and two severe contacts to first with 2.43% peak damage and no severe contacts after the route-front check.

Six-lap Nurburgring GTP worker race, starting behind SPEARHEAD and RAZOR: first in 2747.93 s, one stop/swap, zero damage/incidents, two retained passes (one maneuver). Its rivals collide with each other, so the winning margin is not a clean raw-pace comparison. A matched solo strategy A/B removes the unnecessary second stop and saves 38.71 s with the same driving code.

The completed 14-car Harbor run, seed 7, finishes with INTERCEPT GTPs second/third and GT3s second/fifth. The first GTP retains 14 passes: five new moves, two carried lanes and seven pace passes, with 1.86% damage. Its fastest lap is 51.83 s, but it finishes 3.01 s behind the pole-starting RAZOR. This is not a universal-win result.

| INTERCEPT car | Class place | Peak damage | Cumulative formation / racing damage | Own severe frames |
| --- | ---: | ---: | ---: | ---: |
| 10, GTP | 2 | 1.86% | 0.00% / 1.86% | 0 |
| 11, GTP | 3 | 9.44% | 7.38% / 2.99% | 1 |
| 12, GT3 | 2 | 5.76% | 0.08% / 5.68% | 1 |
| 13, GT3 | 5 | 9.48% | 7.47% / 6.55% | 0 |

Formation damage needs investigation in shared game code and remains included in totals. Cumulative damage exceeds 10% on cars 11/13 despite repairs keeping peak damage below 10%. RAZOR GTP rear-ends car 12 on a straight while INTERCEPT is accelerating; that contact also remains counted.

The eight-car Changeable run, seed 23, has INTERCEPT GTP first and GT3 second, both with zero damage/severe contact. GTP has one early off-track incident point. Both renew intermediates on lap 3 and switch to softs on lap 6 as the surface dries. GT3 makes no retained pass in this case. The final body-deceleration diagnostic does not change the accepted pedals.

## Paused experimental braking checkpoint

The saved production configuration is unchanged. `brakingTube` is an opt-in experiment, absent from `config.json` and disabled by default. It supplements the existing nose guard only when a rival is actually braking harder than the road-progress prediction can represent. A short 0.2 s public-body forecast checks the executed route; pit-lane cars, mild braking and formation are excluded. Longer or less selective variants were rejected.

The new natural-start braking regression covers both classes at normal worker delivery and one extra frame of lag. GTP is clean in both; GT3 has 1.14% / 1.90% light-contact damage, with no severe contact. The check permits light rubbing within the user's 10% cumulative damage budget; it does not call these GT3 runs clean.

With this option enabled in the matched dry Harbor 12-lap race, seed 11, GTP wins by 2.44 s with zero damage/severe contacts, and retains one maneuver pass and one pace pass. Its own finish improves from 687.475 to 687.142 s. GT3 wins by 0.525 s with 1.14% damage and no severe contacts; its retained pass is a pace pass. These are single-seed results, not a universal advantage.

The eight-car Changeable test, seed 23, prevents enabling the option: GT3 falls from second to third, finishes 4.27 s later and gains 6.76% cumulative damage with one severe contact. The severe impact involves a following TEMPEST while INTERCEPT is ahead; it remains counted and has not been assigned a definitive cause. GTP remains damage-free but finishes third rather than first amid changed field interactions. No weather or strategy retuning has been made for this experiment.

Additional trace fields preserve yaw rate, body velocities and fixture settings. `braking-check.mjs` makes the corner-entry reproduction reviewable without changing any production default. See `PAUSED.md` for the save-point handoff.

## Remaining work

1. Reduce rapid-braking-zone rear-end risk and recover speed through multiple hazards without giving away the fast line.
2. Establish defense and further retained maneuvers with both grid orders, multiple seeds and real browser scheduling.
3. Validate large mixed-field/weather endurance, formation incidents and post-repair cumulative damage.
4. Close the small GTP Harbor/Solenne and GT3 Desert solo gaps while retaining tracking and stint reserves.

The build and 42 system checks pass at the save point. Worker maneuver and controlled traffic regressions passed in this round; they have not been broadened into universal claims. JSON/CSV/HTML outputs stay local and excluded from Git. `TOOLS.md` documents reproduction and visual review.
