// Replay accepted memory ancestry without rerunning physics or changing controls.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
import { createPolicy } from './policy.mjs';

const args = process.argv.slice(2), arg = key => {
  const at = args.indexOf('--' + key); return at < 0 ? null : args[at + 1];
};
const name = arg('name'), trace = arg('trace'), replay = arg('replay'), model = arg('model');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !trace || !replay || !model)
  throw Error('Unique --name, full --trace, companion --replay and original --model required');
const out = resolve(HOME, 'artifacts/recurrent-traces', name);
if (existsSync(out)) throw Error('Preserve completed diagnostics');
const recorded = JSON.parse(readFileSync(resolve(HOME, replay), 'utf8'));
const events = recorded.events.filter(e => ['reply-accepted', 'reply-rejected'].includes(e.type));
const policy = await createPolicy(resolve(HOME, model));
const zero = () => new Array(policy.schema.hidden).fill(0);
const difference = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
};
let live = zero(), naive = zero(), acceptedSequence = 0, eventIndex = 0, sequence = 0;
let manifest, steps = 0, stalls = 0, accepted = 0, rejected = 0, baseConflicts = 0;
const requests = new Map(), actionErrors = [], normErrors = [], naiveErrors = [], naiveNormErrors = [], examples = [];

function deliverUntil(time) {
  while (eventIndex < events.length && events[eventIndex].time <= time + 1e-9) {
    const event = events[eventIndex++], request = requests.get(event.seq);
    if (!request) throw Error('Reply event has no prior recorded request: ' + event.seq);
    if (event.type === 'reply-accepted') {
      if (request.base !== acceptedSequence || event.seq <= acceptedSequence)
        throw Error('Recorded acceptance does not match memory ancestry: ' + event.seq);
      live = request.hidden; acceptedSequence = event.seq; accepted++;
    } else {
      rejected++;
      if (request.base !== acceptedSequence) baseConflicts++;
    }
  }
}

try {
  for await (const line of createInterface({ input: createReadStream(resolve(HOME, trace)), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type === 'manifest') {
      manifest = row;
      if (row.settings.mode !== 'policy' || row.policy.modelSha256['1'] !== policy.metadata.modelSha256['1'])
        throw Error('Trace must come from this exact unassisted policy');
      continue;
    }
    if (row.type !== 'step') continue;
    if (!manifest) throw Error('Missing trace manifest');
    deliverUntil(row.time);
    steps++;
    normErrors.push(Math.abs(Math.hypot(...live) - row.hiddenNorm));
    if (!row.policyProposal) { stalls++; continue; }
    const actual = await policy.step(row.observation.normalized, live);
    const serial = await policy.step(row.observation.normalized, naive);
    sequence++;
    if (row.request && (row.request.seq !== sequence || row.request.base !== acceptedSequence))
      throw Error('Explicit request ancestry does not match replay events: ' + sequence);
    requests.set(sequence, { hidden: actual.hidden, base: acceptedSequence, time: row.time });
    const actionError = difference(actual.action, row.policyProposal);
    const naiveError = difference(serial.action, row.policyProposal);
    actionErrors.push(actionError); naiveErrors.push(naiveError);
    naiveNormErrors.push(difference(naive, live));
    naive = serial.hidden;
    if (naiveError > .01 && examples.length < 16)
      examples.push({ time: row.time, request: sequence, acceptedParent: acceptedSequence,
                      recorded: row.policyProposal, reconstructed: actual.action, naive: serial.action });
  }
  deliverUntil(Infinity);
  const maxAction = Math.max(...actionErrors), maxNorm = Math.max(...normErrors);
  if (!steps || !sequence || maxAction > 1e-6 || maxNorm > 1e-5)
    throw Error(`Memory reconstruction does not match the trace: action ${maxAction}, norm ${maxNorm}`);
  const report = { name, trace, replay, model, modelSha256: policy.metadata.modelSha256,
    scope: 'Offline memory ancestry on identical recorded observations. This does not establish a physical driving cause.',
    steps, requests: sequence, stalledRows: stalls, accepted, rejected, inferredBaseConflicts: baseConflicts,
    reconstruction: { maxActionError: maxAction, maxHiddenNormError: maxNorm, verified: true },
    naiveRequestUnroll: { maxActionError: Math.max(...naiveErrors), p50ActionError: quantile(naiveErrors, .5),
      p95ActionError: quantile(naiveErrors, .95), maxHiddenDifference: Math.max(...naiveNormErrors),
      requestsOverOnePercent: naiveErrors.filter(v => v > .01).length },
    examples, warning: 'Delayed episodes require the accepted-state graph; a GRU updated on every request can fit a different memory trajectory.' };
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ name, requests: sequence, accepted, rejected, inferredBaseConflicts: baseConflicts,
    reconstruction: report.reconstruction, naiveRequestUnroll: report.naiveRequestUnroll }));
} finally {
  await policy.dispose();
}
