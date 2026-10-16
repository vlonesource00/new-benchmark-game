import assert from 'node:assert/strict';
import { Battle } from '../src/battle.js';
import { Outcomes } from '../src/outcomes.js';

const battle = new Battle({ track: { length: 3000 } }, {}, new Outcomes());
const rear = { id: 2, eligible: true, hazard: false, ds: -10, v: 43, referenceSpeed: 43, along: 2.28 };
const observer = { car: { speed: 40 }, me: { v: 40 }, list: [rear] };
battle.state = 'DEFEND'; battle.target = 2; battle.side = 1; battle.since = 8;
battle.progress(observer, 10);
assert.equal(battle.state, 'DEFEND', 'a closing rival already behind us is not an overtake we have completed');
battle.progress(observer, 11.5);
assert.equal(battle.state, 'DEFEND', 'do not abandon a defensive line after the ordinary passing clear timer');
assert.equal(battle.clearAt, null);
rear.v = rear.referenceSpeed = 35; rear.ds = -40;
battle.progress(observer, 12);
assert.equal(battle.state, 'CLEAR', 'release the defensive line when the threat falls away');
battle.progress(observer, 13.2);
assert.equal(battle.state, 'RETURN');

battle.reset(); battle.state = 'ATTACK'; battle.target = 2; battle.side = 1;
rear.ds = -10; rear.v = rear.referenceSpeed = 43;
battle.progress(observer, 15);
assert.equal(battle.state, 'CLEAR', 'an attacking pass still uses the normal clearance and retention rules');

console.log('VANGUARD defensive state checks passed.');
