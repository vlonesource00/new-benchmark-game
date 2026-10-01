import { createShadowTrack } from './shadow.js';
import { createAstraBridge, ASTRA_CANDIDATE } from './astra-bridge.js';
import { createGeminiBridge, GEMINI_SUPREME } from './gemini-bridge.js';
import { createNovaBridge, NOVA_CANDIDATE } from './nova-bridge.js';
import { createVortexBridge, VORTEX_CANDIDATE } from './vortex-bridge.js';
import { createPhantomBridge, PHANTOM_CANDIDATE } from './phantom-bridge.js';
import { createPhantomV2Bridge, PHANTOM_V2_CANDIDATE } from './phantom-v2-bridge.js';
import { createGeminiV4Bridge, GEMINI_V4_CANDIDATE } from './gemini-v4-bridge.js';
import { NextGenAIController as SupremeController } from '../../subjects/gemini-supreme/src/ai/v2/NextGenAIController.js';

/**
 * ACTIVE / CURRENT GENERATION.
 *
 * The benchmark field. These are the architectures under active development
 * and the ones the benchmark game and the test manifest carry.
 */
export const ACTIVE_CANDIDATES = Object.freeze([
  VORTEX_CANDIDATE,
  NOVA_CANDIDATE,
  ASTRA_CANDIDATE,
  GEMINI_SUPREME
]);

export const CANDIDATES_5ARCH = ACTIVE_CANDIDATES;

export const SUPREME_CANDIDATES = Object.freeze([
  {
    id: 'gemini-supreme-1',
    label: 'Supreme Gemini #1',
    color: '#00d2ff',
    stack: 'NextGenAIController → coupled MPCC · Apex Cyan'
  },
  {
    id: 'gemini-supreme-2',
    label: 'Supreme Gemini #2',
    color: '#ff9900',
    stack: 'NextGenAIController → coupled MPCC · Blaze Amber'
  },
  {
    id: 'gemini-supreme-3',
    label: 'Supreme Gemini #3',
    color: '#ff2255',
    stack: 'NextGenAIController → coupled MPCC · Crimson Streak'
  },
  {
    id: 'gemini-supreme-4',
    label: 'Supreme Gemini #4',
    color: '#d4ff00',
    stack: 'NextGenAIController → coupled MPCC · Acid Phantom'
  },
  {
    id: 'gemini-supreme-5',
    label: 'Supreme Gemini #5',
    color: '#a855f7',
    stack: 'NextGenAIController → coupled MPCC · Ultra Violet'
  }
]);

export const PLAYER_CANDIDATE = Object.freeze({
  id: 'player-gt',
  label: 'Player (You)',
  color: '#ffffff',
  stack: 'Human Pilot · 120 Hz Manual Controls (WASD / Arrows)'
});

export const SUPREME_WITH_PLAYER = Object.freeze([
  PLAYER_CANDIDATE,
  ...SUPREME_CANDIDATES
]);

export const TRIAD_CANDIDATES = Object.freeze([
  VORTEX_CANDIDATE,
  NOVA_CANDIDATE,
  GEMINI_SUPREME,
  ASTRA_CANDIDATE
]);
export const TRIAD_IDS = Object.freeze(['vortex', 'nova', 'gemini-supreme', 'astra']);
export const VORTEX_QUAD_CANDIDATES = Object.freeze([
  VORTEX_CANDIDATE,
  ASTRA_CANDIDATE,
  GEMINI_SUPREME,
  NOVA_CANDIDATE
]);
export const VORTEX_QUAD_IDS = Object.freeze(VORTEX_QUAD_CANDIDATES.map((candidate) => candidate.id));

export const ALL_KNOWN_CANDIDATES = Object.freeze([
  ...ACTIVE_CANDIDATES,
  PHANTOM_CANDIDATE,
  PHANTOM_V2_CANDIDATE,
  GEMINI_V4_CANDIDATE,
  ...SUPREME_CANDIDATES,
  PLAYER_CANDIDATE
]);

export { GEMINI_V4_CANDIDATE };

export const CANDIDATES = CANDIDATES_5ARCH;
export const CANDIDATE_IDS = Object.freeze(CANDIDATES.map((candidate) => candidate.id));

/**
 * Builds one source-preserving controller bridge per architecture, in grid-slot
 * order. Pass a rotated `order` to remove grid-position bias across races.
 *
 * The host supplies the canonical race state; each bridge translates only at its
 * own boundary. No controller source, pace profile or behavioural tuning changes.
 */
export function createField({
  session,
  hostTrack,
  order = CANDIDATE_IDS,
  onStatus = () => {},
  candidatesList = ALL_KNOWN_CANDIDATES,
  playerInput = null
}) {
  const cars = session.cars;
  const field = order.slice(0, cars.length);
  // One shared shadow track: Gemini's global solver caches per track identity,
  // and sharing is also what makes the solved line identical for both branches.
  const shadowTrack = createShadowTrack(hostTrack, { id: 'harbor-ring' });
  const bridges = new Array(field.length);

  field.forEach((id, index) => {
    const car = cars[index];
    const candidate = candidatesList.find((entry) => entry.id === id)
      ?? ALL_KNOWN_CANDIDATES.find((entry) => entry.id === id)
      ?? { id, label: `CAR #${index + 1}`, color: '#00d2ff', stack: 'Gemini Supreme Controller' };
    car.name = candidate.label.toUpperCase();
    car.color = candidate.color;

    if (id === 'player-gt') {
      onStatus('Binding Human Player driver controls…');
      const fallbackAIAstra = createAstraBridge({ line: session.lineFor(car), index, aggression: session.aggression });
      bridges[index] = {
        candidateId: id,
        gridSlot: index,
        carId: car.id,
        isPlayer: true,
        errors: 0,
        update(c, cars, dt, context) {
          if (session.autopilot) {
            fallbackAIAstra.update(c, cars, dt, context);
          } else if (playerInput) {
            c.controls = playerInput.update(c, dt, true);
          }
        },
        reset(state) {
          playerInput?.clear?.();
          fallbackAIAstra.reset?.(state);
          this.errors = 0;
        },
        debug() {
          if (session.autopilot) {
            return {
              architecture: 'Human Car (AI Assist)',
              planSource: 'Astra Co-Driver Assist',
              controllerCadence: '120 Hz Autonomous Copilot',
              intent: 'AUTOPILOT PACING',
              reason: 'Autonomous Co-Driver Active (Press P to Drive)',
              action: 'COPILOT'
            };
          }
          return {
            architecture: 'Human Pilot',
            planSource: 'Manual Keyboard Controls',
            controllerCadence: '120 Hz Dynamic Human Control',
            intent: 'PLAYER RACING',
            reason: 'WASD / Arrow Keys Steering & Throttle',
            action: 'PILOT'
          };
        },
        visualDebug() {
          return null;
        }
      };
    } else if (id === GEMINI_V4_CANDIDATE.id) {
      onStatus('Binding Gemini Supreme v4 controller…');
      bridges[index] = createGeminiV4Bridge({ hostTrack, index });
    } else if (id.startsWith('gemini-supreme')) {
      onStatus(`Binding Gemini Supreme controller for ${candidate.label}…`);
      const isMultiGemini = id.startsWith('gemini-supreme-');
      bridges[index] = createGeminiBridge({
        candidate,
        cars,
        hostTrack,
        shadowTrack,
        index,
        Controller: SupremeController,
        options: {
          aggression: isMultiGemini ? 0.88 + (index % 5) * 0.02 : 0.90,
          skill: isMultiGemini ? 0.94 + (index % 5) * 0.01 : 0.95,
          controllerId: isMultiGemini ? index : 0
        }
      });
    } else if (id === 'vortex') {
      bridges[index] = createVortexBridge({ line: session.lineFor(car), index, aggression: session.aggression });
    } else if (id === 'phantom-v2') {
      onStatus('Binding PHANTOM v2 controller…');
      bridges[index] = createPhantomV2Bridge({ hostTrack, index });
    } else if (id === 'phantom') {
      onStatus('Binding PHANTOM controller…');
      bridges[index] = createPhantomBridge({ hostTrack, index });
    } else if (id === 'astra') {
      bridges[index] = createAstraBridge({ line: session.lineFor(car), index, aggression: session.aggression });
    } else if (id === 'nova') {
      onStatus('Binding DeepSeek NOVA controller…');
      bridges[index] = createNovaBridge({ candidate: candidatesList.find((entry) => entry.id === id) ?? NOVA_CANDIDATE, cars, hostTrack, shadowTrack, index });
    } else {
      throw new Error(`Unknown benchmark candidate: ${id}`);
    }
    bridges[index].candidateId = id;
    bridges[index].gridSlot = index;
    bridges[index].carId = car.id;
  });

  return {
    order: field,
    bridges,
    /** Installs the bridges as the session's driver stack. */
    attach(autopilot = true) {
      session.autopilot = autopilot;
      for (let i = 0; i < session.drivers.length; i += 1) {
        session.drivers[i] = bridges[i] ?? session.drivers[i];
      }
    },
    step() {
      for (const bridge of bridges) bridge.errors += 0;
    },
    reset() {
      for (const bridge of bridges) bridge.reset?.({ cars, track: hostTrack });
    },
    byId(id) {
      return bridges.find((bridge) => bridge.candidateId === id);
    },
    byCarId(carId) {
      return bridges.find((bridge) => bridge.carId === carId);
    }
  };
}

/** Deterministic round-robin rotations so every car starts in every slot. */
export function rotations(ids = CANDIDATE_IDS) {
  return ids.map((_, offset) => ids.map((_, i) => ids[(i + offset) % ids.length]));
}
