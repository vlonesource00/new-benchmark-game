import { createAstraBridge } from '../bridges/astra-bridge.js';
import { createPhantomBridge } from '../bridges/phantom-bridge.js';
import { createPhantomV2Bridge } from '../bridges/phantom-v2-bridge.js';
import { createGeminiV4Bridge } from '../bridges/gemini-v4-bridge.js';
import { createBenchmarkSolinatorBridge } from '../bridges/solinator-bridge.js';
import { createSolsticeBridge } from '../bridges/solstice-bridge.js';
import { createRevolutionBridge } from '../bridges/revolution-bridge.js';
import { createNextRacerBridge } from '../bridges/next-racer-bridge.js';
import { nextRacerState } from '../bridges/next-racer-state.js';
import { installNativeStrategy } from '../../subjects/next-racer/src/strategy.js';
import { HumanFilter } from './human.js';

/**
 * Builds the controller for one (team, driver) seat. Teammates share a car,
 * so both bridges are bound to the same car slot; only the active one is
 * stepped by the race. Human seats read live input and fall back to an Astra
 * co-driver when their input goes stale (disconnect, alt-tab).
 */
export function createSeatBridge(driver, index, race) {
  const hostTrack = race.track, line = race.lineFor(race.cars[index]);
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
    case 'phantom': return createPhantomBridge({ hostTrack, index });
    case 'phantom-v2': return createPhantomV2Bridge({ hostTrack, index });
    case 'gemini-supreme-v4': return createGeminiV4Bridge({ hostTrack, index });
    case 'solinator-6.1': return createBenchmarkSolinatorBridge({ hostTrack, index });
    case 'solstice': return createSolsticeBridge({ hostTrack, index, teamState: car => {
      const e = race.entryOf?.(car);
      if (!e || !race.cal) return null;
      return { fuelPerLap: e.strategist.fuelPerLap, fuelLaps: race.cal.fuelLaps,
        stintLaps: e.strategist.stintLaps, pitPlan: e.pitPlan };
    } });
    case 'claude-revolution': return createRevolutionBridge({ hostTrack, index, teamState: car => {
      const e = race.entryOf?.(car);
      return e ? { pitPlan: e.pitPlan } : null;
    } });
    case 'next-racer':
      installNativeStrategy(race,race.cars[index]);
      return createNextRacerBridge({hostTrack,index,state:car=>nextRacerState(race,car)});
    default: throw new Error(`Unknown driver architecture: ${driver.id}`);
  }
}
