import { Battle, corridorFits, evaluate } from '../../vanguard-v2/src/battle.js';
import { clamp, gap, angle } from '../../vanguard-v2/src/math.js';
import { CounterpointReactions, extendObserver } from './reactions.js';

const MAX_CANDIDATES = 12;
const MAX_BRANCHES = 3;
const MAX_HORIZON = 6;
const emptyStats = () => ({ decisions: 0, workCount: 0, branchCount: 0, candidates: [], chosen: null,
  admission: null, gain: 0, rejectedCommitment: null, commitHeld: false });

function finiteOutcome(outcome) {
  return outcome && [
    outcome.progress, outcome.exit, outcome.risk, outcome.blocked,
    outcome.relativeGain, outcome.rubbingDamage, outcome.routeTax,
    outcome.finalGap, outcome.exitAdvantage
  ].every(Number.isFinite);
}

export function attackAdmission(target, outcome, followingBaseline, stagedAttacks = false, setupAttacks = false,
  measuredClosing = Infinity, minSetupClosing = 0) {
  if (outcome?.finalGap < -5.6 && outcome?.exitAdvantage > 0.4) return 'completed';
  if ((!stagedAttacks && !setupAttacks) || target?.eligible !== true || target.hazard || target.pit ||
    !Number.isFinite(target.ds) || Math.abs(target.ds) > 40 ||
    !finiteOutcome(outcome) || outcome.hardImpact ||
    !Number.isFinite(followingBaseline?.progress) || !Number.isFinite(followingBaseline?.exit)) return null;
  if (stagedAttacks && outcome.risk < 0.15 && outcome.finalGap < 2.53 && outcome.relativeGain >= 2 &&
    outcome.progress >= followingBaseline.progress + 0.5 &&
    outcome.exit >= followingBaseline.exit - 0.3 && outcome.exitAdvantage >= -0.2) return 'staged';
  // Preparing a distant move needs measured momentum too. A short forecast
  // can promise an exit advantage before seeing the corner that squeezes the
  // selected lane. Actual overlap/completed-pass admissions remain separate.
  return setupAttacks && measuredClosing >= minSetupClosing && outcome.risk < .12 && outcome.relativeGain >= 3 &&
    outcome.progress >= followingBaseline.progress + .8 && outcome.exit >= followingBaseline.exit - .1 &&
    outcome.exitAdvantage >= .8 ? 'setup' : null;
}

function utility(outcome) {
  const retained = outcome.retained ? 1.5 : outcome.cleared ? 0.75 : 0;
  return outcome.progress + 0.8 * outcome.exit + 0.2 * clamp(outcome.relativeGain, -5, 5) + retained -
    1.15 * outcome.blocked - 4 * outcome.risk - 2.5 * outcome.rubbingDamage -
    0.3 * Math.max(0, outcome.routeTax) * Math.max(15, outcome.exit);
}

function targetFor(observer, id) {
  return observer.list.find(r => r.id === id) ?? null;
}

export function alignedReturn(car, base) {
  const c = base.closest(car.x, car.z), heading = base.heading(c.i, c.f),
    speed = Math.hypot(car.vx, car.vz), direction = speed > 2 ? Math.atan2(car.vx, car.vz) : heading,
    error = angle(direction - heading);
  return Math.abs(c.e) < .35 && (speed <= 2 || (Math.abs(error) < .04 && Math.abs(Math.sin(error) * speed) < .75));
}

/** The shared compiler bounds raw offsets before smoothing and the C2 join.
 * Validate the resulting future geometry too. Keeping the planned centre
 * inside the kerb leaves about half a car of tracking reserve before all four
 * wheels leave it. Do not reject usable kerb width or already-traversed nodes. */
export function corridorRoadFits(path, course, car = null) {
  const base = course.line;
  if (path === base) return true;
  if (!path?.lat || path.lat.length !== base.lat.length) return false;
  const bound = course.track.halfWidth + (course.track.curbWidth ?? 0) - .12,
    start = car ? path.closest(car.x, car.z).i : 0,
    count = car ? Math.min(path.N - 1, Math.ceil(Math.max(500, car.speed * 10) / path.ds)) : path.N;
  for (let j = 0; j < count; j++) {
    const i = path.idx(start + j), next = path.idx(i + 1);
    // A corridor rejoins the unchanged pace geometry. Keep that proven part
    // under its existing controller limits rather than penalizing it as a
    // newly generated tactical excursion on tracks with wide legal kerbs.
    if (path.px[i] === base.px[i] && path.pz[i] === base.pz[i] &&
        path.px[next] === base.px[next] && path.pz[next] === base.pz[next]) continue;
    if (!Number.isFinite(path.lat[i]) || !Number.isFinite(path.lat[next]) ||
        Math.abs(path.lat[i]) > bound || Math.abs(path.lat[next]) > bound) return false;
    // Road projection is nonlinear at tight bends. Node metadata alone can
    // miss a chord excursion, so check the actual midpoint near either edge.
    if (Math.max(Math.abs(path.lat[i]), Math.abs(path.lat[next])) > bound - .75) {
      const q = course.track.nearest((path.px[i] + path.px[next]) * .5, (path.pz[i] + path.pz[next]) * .5);
      if (Math.abs(q.lateral) > bound) return false;
    }
  }
  return true;
}

function proactiveTarget(observer, car) {
  return observer.list
    .filter(r => r.eligible && r.physical && !r.pit && !r.hazard && r.ds > 8 && r.ds < Math.max(110, car.speed * 2.5) &&
      (r.referenceSpeed ?? r.v) <= car.speed + 0.6)
    .sort((a, b) => a.ds - b.ds)[0] ?? null;
}

/** Counterfactual tactical layer over VANGUARD's existing Battle state machine. */
export class CounterpointBattle extends Battle {
  constructor(course, options, outcomes) {
    super(course, options, outcomes);
    this.reactions = new CounterpointReactions(course.track);
    this.lastInteractiveAt = -Infinity;
    this.abortPending = null;
    this.stagedAdmissions = 0;
    this.setupAdmissions = 0;
    this.roadRejections = 0;
    this.interactiveStats = emptyStats();
  }

  reset() {
    super.reset();
    this.abortPending = null;
    // Battle invokes reset when a normal merge finishes. Keep race-level
    // observations, work cadence and cumulative diagnostics across maneuvers.
    this.lastInteractiveAt ??= -Infinity;
    this.stagedAdmissions ??= 0;
    this.setupAdmissions ??= 0;
    this.roadRejections ??= 0;
    this.interactiveStats = { ...emptyStats(), decisions: this.interactiveStats?.decisions ?? 0 };
  }

  resetEpisode() {
    this.reset();
    this.reactions?.reset();
    this.lastInteractiveAt = -Infinity;
    this.stagedAdmissions = this.setupAdmissions = 0;
    this.roadRejections = 0;
    this.interactiveStats = emptyStats();
  }

  update(car, observer, now, options = {}) {
    if (this.options.interactive === false || this.options.executor === true)
      return this.planUpdate(car, observer, now, options);
    const previous = { path: this.path, target: this.target, side: this.side,
        targetWasHazard: this.targetWasHazard, since: this.since },
      outcomes = this.outcomes, declarations = [];
    const savedFallback = this.fallbackPath;
    this.fallbackPath = previous.path;
    this.outcomes = { declare: (...args) => declarations.push(args) };
    let selected;
    try { selected = this.planUpdate(car, observer, now, options); }
    finally { this.outcomes = outcomes; this.fallbackPath = savedFallback; }
    if (corridorRoadFits(selected, this.course, car)) {
      for (const args of declarations) outcomes.declare(...args);
      return selected;
    }

    this.roadRejections++;
    // Never publish an edge-violating route or snap from a live maneuver to
    // the ideal line. The previous corridor remains reserved during planning;
    // continue it and let RETURN construct a fresh C2 merge on the next cycle.
    const retained = previous.path && corridorRoadFits(previous.path, this.course, car)
      ? previous.path : this.course.line;
    Object.assign(this, previous, { path: retained, state: 'RETURN',
      clearAt: now, returnReason: 'road-margin', returnPath: null, returnGuard: null,
      returnTarget: null, building: false });
    this.interactiveStats.chosen = 'road-margin-return';
    this.interactiveStats.admission = null;
    return retained;
  }

  planUpdate(car, observer, now, options = {}) {
    this.returnAlignmentHeld = false;
    if (this.options.interactive === false || this.options.executor === true) return super.update(car, observer, now, options);

    const oldSequence = this.sequence, realOutcomes = this.outcomes, declarations = [],
      before = { state: this.state, target: this.target, side: this.side, since: this.since, path: this.path },
      returning = before.state === 'RETURN' ? {
        ...before, targetWasHazard: this.targetWasHazard, clearAt: this.clearAt, returnReason: this.returnReason,
        returnPath: this.returnPath, returnGuard: this.returnGuard, returnTarget: this.returnTarget,
        moveKind: this.moveKind, building: this.building
      } : null;
    // Delay tentative declarations until the Counterpoint choice is known.
    this.outcomes = { declare: (...args) => declarations.push(args) };
    let path;
    try {
      path = super.update(car, observer, now, options);
    } finally {
      this.outcomes = realOutcomes;
    }
    // Keep following the existing C2 merge until the actual velocity is aligned
    // with the pace route. Being momentarily within 35cm while still crossing
    // it is not a completed handoff. Never create a new snap-to-line geometry.
    if (this.options.smoothReturns !== false && returning && this.state === 'PACE' &&
        path === this.course.line && returning.path && returning.path !== path &&
        !alignedReturn(car, path)) {
      Object.assign(this, returning, { at: now, sequence: oldSequence + 1 });
      this.returnAlignmentHeld = true;
      this.interactiveStats.chosen = 'aligning-return';
      for (const args of declarations) realOutcomes.declare(...args);
      return returning.path;
    }
    const baseChoice = { state: this.state, target: this.target, side: this.side, since: this.since, path };

    const replayDeclarations = () => {
      for (const args of declarations) realOutcomes.declare(...args);
    };
    if (this.sequence === oldSequence || options.enabled === false) {
      replayDeclarations();
      return path;
    }

    // Distinguish a momentary forecast setback from a dangerous corridor.
    // A short commitment window never delays hazard or body-impact rejection.
    this.interactiveStats.commitHeld = false;
    const window = clamp(this.options.commitWindow ?? 0, 0, .5),
      previousTarget = targetFor(observer, before.target);
    if (window > 0 && before.state === 'ATTACK' && before.side && before.path?.attackSide &&
        baseChoice.state === 'RETURN' && this.returnReason === 'abort' && this.target === before.target &&
        previousTarget?.eligible && !previousTarget.hazard && !previousTarget.pit &&
        previousTarget.ds > 4 && previousTarget.ds < 40 && now - before.since < 8 &&
        !observer.list.some(r => r.physical && !r.pit && r.hazard && Math.abs(r.ds) < Math.max(76, car.speed * 1.45)) &&
        gap(before.path.holdEndS ?? observer.me.s, observer.me.s, this.course.track.length) > car.speed * window + 25) {
      const held = evaluate(before.path, car, this.course, observer, previousTarget, 1.4 - 1e-7);
      if (!held.hardImpact && held.trackable !== false && finiteOutcome(held) && held.risk < .12) {
        if (this.abortPending?.target !== before.target || this.abortPending.side !== before.side)
          this.abortPending = { target: before.target, side: before.side, since: now };
        if (now - this.abortPending.since < window) {
          Object.assign(this, before, { state: 'ATTACK', clearAt: null, returnReason: null,
            returnPath: null, returnGuard: null, returnTarget: null });
          this.interactiveStats.commitHeld = true;
          this.interactiveStats.chosen = 'held-setback';
          this.interactiveStats.admission = 'committed';
          this.interactiveStats.workCount = 1;
          this.interactiveStats.branchCount = 1;
          return before.path;
        }
      } else this.abortPending = null;
    } else this.abortPending = null;

    const period = clamp(this.options.interactivePeriod ?? 0.15, 0.05, 1.0);
    if (now - this.lastInteractiveAt < period) {
      replayDeclarations();
      return path;
    }

    const eligibleTarget = targetFor(observer, this.target),
      tactical = ['ATTACK', 'TOW', 'FOLLOW', 'PACE'].includes(this.state) &&
        !this.targetWasHazard && !eligibleTarget?.hazard && !eligibleTarget?.pit &&
        !['RETURN', 'PIT', 'EVADE', 'ALONGSIDE', 'DEFEND'].includes(this.state),
      nearbyHazard = observer.list.some(r => r.physical && !r.pit && r.hazard && Math.abs(r.ds) < Math.max(76, car.speed * 1.45));
    if (!tactical || nearbyHazard || this.options.executor === true) {
      replayDeclarations();
      return path;
    }

    let target = eligibleTarget?.eligible && eligibleTarget.physical ? eligibleTarget : null;
    if (!target && ['TOW', 'FOLLOW', 'PACE'].includes(this.state)) target = proactiveTarget(observer, car);
    if (!target || !target.eligible || target.pit || target.hazard) {
      replayDeclarations();
      return path;
    }

    // Keep an admitted, safe baseline attack intact. Search for missed
    // opportunities while following instead of repeatedly undoing a live move.
    if (baseChoice.state === 'ATTACK' && baseChoice.side) {
      this.interactiveStats.chosen = 'baseline-commitment';
      this.interactiveStats.admission = 'committed';
      replayDeclarations();
      return path;
    }

    this.lastInteractiveAt = now;
    this.reactions.observe(observer);
    this.interactiveStats.decisions++;
    this.interactiveStats.workCount = 0;
    this.interactiveStats.branchCount = 0;
    this.interactiveStats.chosen = null;
    this.interactiveStats.admission = null;
    this.interactiveStats.gain = 0;
    this.interactiveStats.rejectedCommitment = null;

    const base = this.course.line,
      // The shared nominal evaluator advances fixed 0.1s steps. A tiny epsilon
      // prevents floating-point 4.999999... from executing a spurious 51st step
      // against a rival forecast already clamped at five seconds.
      horizon = Math.max(0.1, Math.floor(clamp(this.options.interactiveHorizon ?? 5, 0.1,
        clamp(this.options.interactiveMaxHorizon ?? MAX_HORIZON, 0.1, MAX_HORIZON)) * 10) / 10) - 1e-7,
      branchLimit = clamp(Math.trunc(this.options.interactiveBranches ?? MAX_BRANCHES), 1, MAX_BRANCHES),
      candidateLimit = clamp(Math.trunc(this.options.interactiveCandidates ?? MAX_CANDIDATES), 1, MAX_CANDIDATES),
      neutralObserver = extendObserver(observer, this.course.track, horizon);
    this.candidates ??= [];
    let baseline = this.candidates.find(c => c.kind === 'course' && c.path === base);
    if (!baseline) {
      baseline = { ...evaluate(base, car, this.course, neutralObserver, target, horizon), path: base, kind: 'course', side: 0, fits: true };
    } else {
      this.candidates.splice(this.candidates.indexOf(baseline), 1);
    }
    // The same-horizon baseline is always scored inside the bounded candidate
    // loop, even when Vanguard's current state produced many held alternatives.
    this.candidates.unshift(baseline);

    const canFan = ['TOW', 'FOLLOW', 'PACE'].includes(this.state) && !nearbyHazard && target.ds > 8 &&
      (target.referenceSpeed ?? target.v) <= car.speed + 0.6;
    if (canFan) this.addProactiveFan(car, neutralObserver, target, candidateLimit, horizon);

    const bounded = this.candidates.slice(0, candidateLimit), scored = [];
    let courseBaselineScore = null, followingBaseline = null;
    for (const candidate of bounded) {
      if (!candidate.path || (candidate.kind !== 'course' && candidate.fits === false) || candidate.trackable === false ||
          !corridorRoadFits(candidate.path, this.course, car)) continue;
      const branches = this.reactions.branches(candidate.path, car, this.course, neutralObserver, target, {
        maxBranches: branchLimit, horizon
      });
      this.interactiveStats.branchCount = Math.max(this.interactiveStats.branchCount, branches.length);
      const outcomes = [];
      let unsafe = false;
      for (let i = 0; i < branches.length; i++) {
        const outcome = evaluate(candidate.path, car, this.course, branches[i].observer, target, horizon);
        this.interactiveStats.workCount++;
        if (!finiteOutcome(outcome) || outcome.hardImpact) unsafe = true;
        outcomes.push({ kind: branches[i].kind, utility: finiteOutcome(outcome) ? utility(outcome) : null, outcome });
      }
      if (candidate.kind === 'course' && Number.isFinite(outcomes[0]?.utility)) {
        courseBaselineScore = outcomes[0].utility;
        followingBaseline = outcomes[0].outcome;
      }
      if (unsafe || !outcomes.length || outcomes.some(x => !Number.isFinite(x.utility)) || outcomes[0].outcome.risk > 0.9) continue;

      const neutral = outcomes[0].utility,
        responses = outcomes.slice(1).map(x => x.utility),
        responseMean = responses.length ? responses.reduce((a, b) => a + b, 0) / responses.length : neutral,
        worst = Math.min(...outcomes.map(x => x.utility)),
        cpScore = 0.65 * neutral + 0.35 * responseMean - 0.1 * Math.max(0, neutral - worst),
        move = candidate.kind !== 'course' && Boolean(candidate.side) && candidate.path.attackSide;
      candidate.counterpointScore = cpScore;
      candidate.branchScores = outcomes.map(x => ({
        kind: x.kind, score: x.utility, progress: x.outcome.progress, exit: x.outcome.exit,
        relativeGain: x.outcome.relativeGain, retained: Boolean(x.outcome.retained || x.outcome.cleared),
        blocked: x.outcome.blocked, risk: x.outcome.risk, damage: x.outcome.rubbingDamage
      }));
      scored.push({ candidate, score: cpScore, move, outcomes });
    }

    this.interactiveStats.candidates = scored.map(({ candidate, score, outcomes }) => ({
      kind: candidate.kind, side: candidate.side ?? 0, score,
      neutral: outcomes[0]?.utility ?? null,
      responses: outcomes.slice(1).map(x => ({ kind: x.kind, score: x.utility })),
      risk: outcomes[0]?.outcome.risk, blocked: outcomes[0]?.outcome.blocked,
      relativeGain: outcomes[0]?.outcome.relativeGain,
      damage: outcomes[0]?.outcome.rubbingDamage,
      fits: candidate.fits !== false
    }));

    const preexistingCommitment = before.target === target.id && before.side &&
        ['ATTACK', 'ALONGSIDE', 'DEFEND'].includes(before.state),
      courseScore = scored.find(x => x.candidate.kind === 'course')?.score ?? courseBaselineScore,
      locked = preexistingCommitment && now - before.since < 1.1,
      moves = Number.isFinite(courseScore)
        ? scored.flatMap(x => {
          if (!x.move || (locked && x.candidate.side !== before.side)) return [];
          // Existing admission still requires a completed pass. The opt-in
          // staged gate admits safe, useful overlap without changing pass records.
          const admission = preexistingCommitment ? 'committed' :
            attackAdmission(target, x.outcomes[0].outcome, followingBaseline, this.options.stagedAttacks === true,
              this.options.setupAttacks === true, car.speed - (target.referenceSpeed ?? target.v),
              this.options.setupMinClosing ?? 0);
          if (admission === 'setup' && x.outcomes.some(b => b.outcome.risk >= .15 ||
              b.outcome.relativeGain < 1 || b.outcome.exitAdvantage < .2)) return [];
          return admission ? [{ ...x, admission }] : [];
        })
        : [];
    for (const item of moves) {
      if (preexistingCommitment && before.side === item.candidate.side) item.score += 0.55;
    }
    moves.sort((a, b) => b.score - a.score);
    const chosen = moves[0], requiredGain = this.options.interactiveMinGain ?? 0.3;
    this.interactiveStats.gain = chosen ? chosen.score - courseScore : 0;

    if (!chosen || chosen.score < courseScore + requiredGain) {
      // A safe established manoeuvre is an investment, not a new pass proposal.
      // Comparing it to an instantaneous return to the ideal line repeatedly
      // abandons attacks just before the grip/exit advantage can materialise.
      const established = preexistingCommitment && scored.find(x => x.candidate.path === baseChoice.path &&
        x.candidate.side === before.side && x.outcomes[0].outcome.risk < 0.45 &&
        !x.outcomes[0].outcome.hardImpact);
      if (established && ['ATTACK', 'ALONGSIDE'].includes(baseChoice.state)) {
        this.interactiveStats.chosen = 'committed';
        this.interactiveStats.admission = 'committed';
        replayDeclarations();
        return this.path ?? path;
      }
      const wasAttack = ['ATTACK', 'ALONGSIDE'].includes(baseChoice.state) && baseChoice.side && baseChoice.path !== base;
      if (wasAttack) {
        // Keep this frame's selected corridor; RETURN will merge it smoothly.
        this.path = baseChoice.path;
        this.state = 'RETURN';
        this.returnReason = 'counterpoint-reject';
        this.clearAt = now;
        this.returnPath = null;
        this.returnGuard = null;
        this.returnTarget = null;
        this.interactiveStats.rejectedCommitment = preexistingCommitment ? 'existing' : 'new';
      }
      this.interactiveStats.chosen = wasAttack ? 'RETURN' : 'course';
      if (!wasAttack) replayDeclarations();
      return this.path ?? path;
    }

    const selected = chosen.candidate;
    this.interactiveStats.chosen = selected.kind;
    this.interactiveStats.admission = chosen.admission;
    if (selected.path !== baseChoice.path || selected.side !== baseChoice.side || this.target !== target.id) {
      if (chosen.admission === 'staged') this.stagedAdmissions++;
      if (chosen.admission === 'setup') this.setupAdmissions++;
      this.path = selected.path;
      this.target = target.id;
      this.targetWasHazard = false;
      this.side = selected.side;
      this.since = preexistingCommitment && before.side === selected.side ? before.since : now;
      this.state = 'ATTACK';
      // Useful overlap is a developing move too. Its earlier admission must
      // retain the shared measured-progress extension, rather than expiring
      // before a later conventional attack reaches the same passing point.
      this.building = chosen.admission === 'setup' || chosen.admission === 'staged';
      if (this.building) this.progressMark = { id: target.id, gap: target.ds, time: now };
      this.moveKind = selected.kind;
      this.flankEdge = target.offset ?? target.d ?? 0;
      this.flankTime = now;
      this.clearAt = null;
      this.returnReason = null;
      this.returnPath = null;
      this.returnGuard = null;
      this.returnTarget = null;
      realOutcomes.declare(target, observer, now, this.side);
    } else {
      replayDeclarations();
    }
    return this.path ?? path;
  }

  addProactiveFan(car, observer, target, candidateLimit = MAX_CANDIDATES, horizon = this.options.interactiveHorizon ?? 5) {
    const course = this.course, existing = [this.path, this.fallbackPath, this.returnPath, this.returnGuard?.path,
      ...this.candidates.map(c => c.path)].filter(Boolean);
    // Preserve every live or scored corridor before asking Course for pool slots.
    course.beginRoutes(...existing);
    const free = () => course.pool.filter(slot => !course.reserved?.has(slot.path)).length,
      entry = Math.max(28, car.speed * 0.65), hold = Math.max(180, car.speed * 4.5),
      returnLength = Math.max(100, car.speed * 1.4), standard = this.separation(),
      wide = Math.max(standard + 0.45, course.racecraft?.wideClearance(this.options.separation) ?? 2.8),
      fan = [[-1, standard], [1, standard], [-1, wide], [1, wide]];
    for (const [side, clearance] of fan) {
      if (this.candidates.length >= candidateLimit || free() <= 0) break;
      let path;
      try {
        path = course.corridor(car, target, side, this.candidates.length + 1, {
          entry, hold, returnLength, clearance
        });
      } catch {
        break;
      }
      const fits = corridorFits(path, course.line, car, target, side);
      const candidate = { ...evaluate(path, car, course, observer, target, horizon), path,
        kind: `proactive-${clearance === standard ? 'standard' : 'wide'}`, side, fits };
      this.candidates.push(candidate);
    }
  }

  debugStats() {
    return {
      enabled: this.options.interactive !== false,
      stagedEnabled: this.options.stagedAttacks === true,
      stagedAdmissions: this.stagedAdmissions,
      setupEnabled: this.options.setupAttacks === true,
      setupAdmissions: this.setupAdmissions,
      roadRejections: this.roadRejections,
      commitWindow: this.options.commitWindow ?? 0,
      decisions: this.interactiveStats.decisions,
      workCount: this.interactiveStats.workCount,
      branchCount: this.interactiveStats.branchCount,
      chosen: this.interactiveStats.chosen,
      admission: this.interactiveStats.admission,
      gain: this.interactiveStats.gain,
      rejectedCommitment: this.interactiveStats.rejectedCommitment,
      commitHeld: this.interactiveStats.commitHeld ?? false,
      returnAlignmentHeld: this.returnAlignmentHeld ?? false,
      evidence: {
        kind: 'bounded-observation-counts', usedForScoring: false,
        ...this.reactions.evidence
      },
      candidates: this.interactiveStats.candidates.map(c => ({ ...c, responses: c.responses.map(r => ({ ...r })) }))
    };
  }
}
