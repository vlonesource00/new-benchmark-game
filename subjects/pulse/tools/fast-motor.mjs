import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createFastMotor } from '../src/fast-motor.mjs';

export function loadFastMotor(directory, metadata) {
  const envelope = JSON.parse(readFileSync(resolve(directory, 'fast-motor.json'), 'utf8'));
  if (typeof envelope.payloadJson !== 'string' || createHash('sha256').update(envelope.payloadJson).digest('hex') !== envelope.sha256)
    throw Error('Local motor integrity mismatch');
  const payload = JSON.parse(envelope.payloadJson);
  if (payload.schemaDigest !== metadata.schemaDigest || payload.schemaVersion !== metadata.schemaVersion
    || ['1', '16'].some(n => payload.modelSha256[n] !== metadata.modelSha256[n])) throw Error('Local motor belongs to a different actor');
  return createFastMotor(payload);
}
