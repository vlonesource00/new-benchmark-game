// A synchronous evaluation of the same trained dense motor, with no route rule.
export function createFastMotor(payload) {
  if (payload.format !== 'pulse-fast-motor-v1' || payload.ownSize !== 220 || payload.observationSize !== 364)
    throw Error('Unsupported local motor contract');
  const ownSize = payload.ownSize, mask = Float32Array.from(payload.mask ?? []);
  if (mask.length !== ownSize || !Array.from(mask).every(x => x === 0 || x === 1)) throw Error('Invalid motor input mask');
  const expected = { 'context.0': [128, ownSize], 'context.2': [64, 128], 'head.0': [64, 128],
    'head.2': [2, 64], 'pedals.0': [64, ownSize + 128], 'pedals.2': [1, 64] };
  const layers = Object.fromEntries(Object.entries(expected).map(([name, shape]) => {
    const layer = payload.layers?.[name];
    if (!layer || layer.shape?.[0] !== shape[0] || layer.shape?.[1] !== shape[1]
      || layer.weight?.length !== shape[0] * shape[1] || layer.bias?.length !== shape[0]) throw Error('Invalid motor layer: ' + name);
    const weight = Float32Array.from(layer.weight), bias = Float32Array.from(layer.bias);
    if (!Array.from(weight).every(Number.isFinite) || !Array.from(bias).every(Number.isFinite)) throw Error('Non-finite motor layer');
    return [name, { shape, weight, bias, output: new Float32Array(shape[0]) }];
  }));
  const input = new Float32Array(ownSize), motor = new Float32Array(128), pedalInput = new Float32Array(ownSize + 128);
  function dense(name, values) {
    const { shape: [height, width], weight, bias, output } = layers[name];
    for (let row = 0; row < height; row++) {
      let sum = bias[row];
      for (let col = 0, at = row * width; col < width; col++) sum += weight[at + col] * values[col];
      output[row] = Math.tanh(Math.fround(sum));
    }
    return output;
  }
  return { metadata: payload,
    step(observation) {
      if (observation.length !== payload.observationSize) throw Error('Local motor input size mismatch');
      for (let i = 0; i < ownSize; i++) {
        if (!Number.isFinite(observation[i])) throw Error('Non-finite local motor input');
        input[i] = Math.fround(observation[i]) * mask[i];
      }
      const own = dense('context.2', dense('context.0', input));
      motor.set(own); // Rival feature columns remain zero, exactly as in the preserved motor.
      pedalInput.set(motor); pedalInput.set(input, 128);
      const steer = dense('head.2', dense('head.0', motor))[0];
      const pedal = dense('pedals.2', dense('pedals.0', pedalInput))[0];
      return [steer, pedal];
    }
  };
}
