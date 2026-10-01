import { createShadowTrack } from '../bridges/shadow.js';
import { createAstraBridge } from '../bridges/astra-bridge.js';
import { createGeminiBridge, GEMINI_SUPREME } from '../bridges/gemini-bridge.js';
import { createNovaBridge, NOVA_CANDIDATE } from '../bridges/nova-bridge.js';
import { createVortexBridge } from '../bridges/vortex-bridge.js';
import { createPhantomBridge } from '../bridges/phantom-bridge.js';
import { createPhantomV2Bridge } from '../bridges/phantom-v2-bridge.js';
import { createGeminiV4Bridge } from '../bridges/gemini-v4-bridge.js';
import { HumanFilter } from './human.js';
import { NextGenAIController as SupremeController } from '../../subjects/gemini-supreme/src/ai/v2/NextGenAIController.js';

/**
 * Builds the controller for one (team, driver) seat. Teammates share a car,
 * so both bridges are bound to the same car slot; only the active one is
 * stepped by the race. Human seats read live input and fall back to an Astra
 * co-driver when their input goes stale (disconnect, alt-tab).
 */
export function createSeatBridge(driver, index, race) {
  const car = race.cars[index], cars = race.cars, hostTrack = race.track;
  race.shadowTrack ??= createShadowTrack(hostTrack, { id: hostTrack.id });
  const shadowTrack = race.shadowTrack;
  const line = race.lineFor(car);
  switch (driver.kind === 'human' ? 'human' : driver.id) {
    case 'human': {
      const assist = createAstraBridge({ line, index, aggression: 0.7 });
      const filter = new HumanFilter();
      let consumed = null, pending = 0;
      return {
        human: true, driverId: driver.id, errors: 0, assisted: false,
        update(c, all, dt, ctx) {
          // Raw axes from the player's client; stale input hands the car to Astra.
          const input = race.inputFor(driver.id);
          this.assisted = !input;
          if (input) {
            c.controls = filter.update(c, input, dt, input.assist !== false);
            c.automatic = !input.manual;
            // Presses made mid-shift wait for the gearbox rather than vanishing.
            const shifts = input.shifts ?? 0;
            pending = Math.max(-2, Math.min(2, pending + shifts - (consumed ?? shifts)));
            consumed = shifts;
            if (!c.automatic && pending && !(c.shiftTimer > 0)) { c.shift(Math.sign(pending)); pending -= Math.sign(pending); }
          } else { filter.reset(); c.automatic = true; pending = 0; assist.update(c, all, dt, ctx); }
        },
        reset(state) { filter.reset(); pending = 0; assist.reset?.(state); },
        debug() { return { architecture: this.assisted ? 'Astra co-driver (input lost)' : 'Human' }; },
        visualDebug() { return null; }
      };
    }
    case 'astra': return createAstraBridge({ line, index, aggression: 0.72 });
    case 'vortex': return createVortexBridge({ line, index, aggression: 0.72 });
    case 'phantom': return createPhantomBridge({ hostTrack, index });
    case 'phantom-v2': return createPhantomV2Bridge({ hostTrack, index });
    case 'gemini-supreme-v4': return createGeminiV4Bridge({ hostTrack, index });
    case 'nova': return createNovaBridge({ candidate: NOVA_CANDIDATE, cars, hostTrack, shadowTrack, index });
    case 'gemini-supreme': return createGeminiBridge({
      candidate: GEMINI_SUPREME, cars, hostTrack, shadowTrack, index, Controller: SupremeController,
      options: { aggression: 0.9, skill: 0.95, controllerId: index }
    });
    default: throw new Error(`Unknown driver architecture: ${driver.id}`);
  }
}
