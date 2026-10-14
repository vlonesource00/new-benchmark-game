// Browser worker for the SLIPSTREAM test seat: the exported actor (policy.mjs), one request in flight at a time.
import { Policy } from './policy.mjs';
let pol = null;
self.onmessage = ({ data }) => {
  if (data.type === 'init') { pol = new Policy(data.exp); self.postMessage({ type: 'ready' }); return; }
  if (data.type === 'step') {
    const t0 = performance.now();
    const [steer, pedal] = pol.act(data.obs, data.first, true);
    self.postMessage({ type: 'controls', seq: data.seq, steer, pedal, computeMs: performance.now() - t0 });
  }
};
