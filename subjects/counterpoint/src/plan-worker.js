// COUNTERPOINT's planning worker: the rollouts run here, off the render thread; the driver keeps steering meanwhile.
import { PlanHost } from './plan-host.js';

const host = new PlanHost();
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') host.init(data);
    else if (data.type === 'reset') host.reset();
    else if (data.type === 'warm') host.warm(data);
    else if (data.type === 'plan') self.postMessage(host.plan(data));
  } catch (e) { self.postMessage({ type: 'error', seq: data.seq, message: String(e?.stack ?? e) }); }
};
