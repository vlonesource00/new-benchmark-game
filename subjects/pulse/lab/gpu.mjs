import * as ort from 'onnxruntime-web/webgpu';
import { observationProfile } from '../src/observations.mjs';
import { timing } from '../src/runtime.mjs';
ort.env.wasm.wasmPaths = '/ort/'; ort.env.wasm.numThreads = 1;
const status = document.getElementById('status'), output = document.getElementById('result');
const selectedModel = new URLSearchParams(location.search).get('model') ?? 'artifacts/model';
if (!/^artifacts\/(?:model|models\/[a-z0-9-]+(?:\/epoch-[1-9][0-9]{0,2})?)$/i.test(selectedModel)) throw Error('Invalid model path');
const json = async path => { const r = await fetch(path); if (!r.ok) throw Error(`Missing ${path}: record/train first`); return r.json(); };
const zero = (batch, schema) => new ort.Tensor('float32', new Float32Array(batch * schema.hidden), [batch, schema.hidden]);

async function measure(backend, batch, parity, SCHEMA, expectedHash) {
  const start = performance.now(), response = await fetch(`/${selectedModel}/policy-${batch}.onnx`);
  if (!response.ok) throw Error('Missing model graph');
  const bytes = await response.arrayBuffer();
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
  if (sha !== expectedHash) throw Error('Browser model integrity mismatch');
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend], ...(backend === 'webgpu' ? { preferredOutputLocation: { nextHidden: 'gpu-buffer', action: 'cpu' } } : {}) });
  const setupMs = performance.now() - start;
  let hidden = zero(batch, SCHEMA), actionError = 0, hiddenError = 0, samples = [];
  const step = async observation => {
    const previous = hidden, r = await session.run({ observation, hidden });
    try {
      const action = await r.action.getData(); hidden = r.nextHidden;
      if (previous !== hidden) previous.dispose(); return Array.from(action);
    } catch (error) { if (r.nextHidden !== hidden) r.nextHidden.dispose(); throw error; }
    finally { r.action.dispose(); }
  };
  try {
  for (const sample of parity) {
    const observation = new ort.Tensor('float32', Float32Array.from(Array.from({ length: batch }, () => sample.observation).flat()), [batch, SCHEMA.size]);
    try {
    const action = await step(observation), data = await hidden.getData();
    for (let b = 0; b < batch; b++) {
      for (let i = 0; i < 2; i++) actionError = Math.max(actionError, Math.abs(action[b * 2 + i] - sample.action[i]));
      for (let i = 0; i < SCHEMA.hidden; i++) hiddenError = Math.max(hiddenError, Math.abs(data[b * SCHEMA.hidden + i] - sample.hidden[i]));
    }
    } finally { observation.dispose(); }
  }
  if (actionError > 2e-4 || hiddenError > 2e-4) throw Error(`${backend} recurrent parity failed: ${actionError}/${hiddenError}`);
  // Actual upload of a fresh observation + dispatch + action readback. Hidden stays on GPU.
  const makeObservation = () => new ort.Tensor('float32', Float32Array.from(Array.from({ length: batch }, () => parity[0].observation).flat()), [batch, SCHEMA.size]);
  for (let i = 0; i < 30; i++) { const x = makeObservation(); try { await step(x); } finally { x.dispose(); } }
  for (let i = 0; i < 150; i++) { const t = performance.now(), x = makeObservation(); try { await step(x); } finally { x.dispose(); } samples.push(performance.now() - t); }
  const result = { backend, batch, setupMs, actionError, hiddenError, endToEndMs: timing(samples),
    recurrentStateLocation: hidden.location, over16ms: samples.filter(x => x > 16.667).length };
  return result;
  } finally { hidden.dispose(); await session.release(); }
}
async function run() {
  document.getElementById('run').disabled = true; window.pulseResult = undefined;
  try {
    const [parity, metadata] = await Promise.all([json(`/${selectedModel}/parity.json`), json(`/${selectedModel}/metadata.json`)]);
    const { schema: SCHEMA } = observationProfile(metadata.schemaVersion);
    if (JSON.stringify(metadata.schema) !== JSON.stringify(SCHEMA)) throw Error('Browser schema mismatch');
    if (!parity.length || parity.some(p => p.observation.length !== SCHEMA.size || p.action.length !== 2 || p.hidden.length !== SCHEMA.hidden)) throw Error('Invalid browser parity contract');
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    const info = adapter?.info, result = { model: selectedModel, modelSha256: metadata.modelSha256, schemaVersion: SCHEMA.version,
      actuationUsesRecurrentMemory: metadata.actuationUsesRecurrentMemory !== false, stage: metadata.stage, webgpu: !!adapter,
      adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null, measurements: [] };
    for (const backend of adapter ? ['wasm', 'webgpu'] : ['wasm']) for (const batch of [1, 16]) {
      status.textContent = `Measuring ${backend} · batch ${batch}…`;
      try { result.measurements.push(await measure(backend, batch, parity, SCHEMA, metadata.modelSha256[String(batch)])); }
      catch (e) { result.measurements.push({ backend, batch, error: String(e.stack ?? e) }); }
      output.textContent = JSON.stringify(result, null, 2);
    }
    window.pulseResult = result; status.textContent = 'Finished. Microbenchmarks exclude physics/render load; they do not certify real worker deadlines.';
  } catch (e) { window.pulseResult = { error: String(e.stack ?? e) }; output.textContent = JSON.stringify(window.pulseResult, null, 2); status.textContent = 'Check failed.'; }
  finally { document.getElementById('run').disabled = false; }
}
document.getElementById('run').onclick = run;
if (new URLSearchParams(location.search).has('auto')) run();
