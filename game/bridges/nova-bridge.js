import { Session } from '../../subjects/nova/src/sim/session.js';
import { Track as NovaTrack } from '../../subjects/nova/src/sim/track.js';

export const NOVA_CANDIDATE = Object.freeze({
  id: 'nova',
  label: 'DeepSeek NOVA',
  color: '#00e5a3',
  stack: 'Latent Intent Belief → Homotopy Discovery → CVaR Trajectory → Coupled MPCC'
});

export function createNovaBridge({
  candidate = NOVA_CANDIDATE,
  cars,
  hostTrack,
  shadowTrack,
  index,
  options = {}
}) {
  if (!cars || !hostTrack) throw new Error('createNovaBridge needs {cars, hostTrack}');

  const trackName = hostTrack.id ?? 'harbor-ring';
  const novaTrack = new NovaTrack(trackName);
  const novaSession = new Session(novaTrack, { classId: 'gt' });
  novaSession.aiKind = 'nova';
  novaSession.aiOptions = {
    lineVariant: 'measured',
    novaSpeedScale: 1.0,
    strict: false,
    ...options
  };

  const nativeDriver = novaSession.makeDriver(novaSession.cars[0]);
  const novaDriver = nativeDriver.ai;

  const entry = {
    ...candidate,
    candidateId: candidate.id ?? 'nova',
    gridSlot: index,
    carId: cars[index]?.id,
    driver: novaDriver,
    nativeDriver,
    errors: 0,
    lastError: null,
    update(car, allCars, dt, context) {
      try {
        const field = allCars || cars;
        const order = context?.order ?? [...field].sort((a, b) =>
          (a.race?.finishTime ?? Infinity) - (b.race?.finishTime ?? Infinity)
          || (b.race?.progress ?? 0) - (a.race?.progress ?? 0));
        const position = order.findIndex(c => c.id === car.id) + 1;
        nativeDriver.update(car, field, dt, { ...context, position: position || 1 });
      } catch (error) {
        this.errors += 1;
        this.lastError = error;
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset() {
      try {
        nativeDriver.reset();
      } catch (e) {
        // ignore
      }
      this.errors = 0;
      this.lastError = null;
    },
    debug() {
      const s = novaDriver.state || {};
      const topo = novaDriver.topologyResult || {};
      const activeTopology = topo.activeTopology ?? s.intent ?? 'FREE_AIR';
      const racecraftPhase = topo.phase ?? s.racecraftPhase ?? 'FREE';
      return {
        architecture: 'DeepSeek NOVA',
        state: s.mode ?? 'NOVA',
        intent: activeTopology,
        activeTopology,
        racecraftPhase,
        phase: racecraftPhase,
        action: `${activeTopology} · ${racecraftPhase}`,
        reason: s.limitReason ? `Limit: ${s.limitReason}` : undefined,
        planSource: 'NOVA Racecraft (Latent Belief + CVaR + Value Field)',
        controllerCadence: '120 Hz coupled control / 20 Hz topology replanning',
        targetSpeed: s.targetSpeed ?? null,
        targetQ: s.targetQ ?? null,
        topology: activeTopology,
      };
    },
    visualDebug() {
      const plan = novaDriver.trajectoryPlan;
      return {
        selectedTrajectory: plan?.points ? {
          points: plan.points.map((p) => ({ x: p.x, y: p.y ?? 0, z: p.z, speed: p.speed })),
          color: '#00e5a3',
          mode: novaDriver.state?.intent ?? 'FREE_AIR'
        } : null,
        trackingPoint: plan?.trackingPoint ? {
          x: plan.trackingPoint.x,
          y: plan.trackingPoint.y ?? 0,
          z: plan.trackingPoint.z
        } : null
      };
    }
  };

  return entry;
}
