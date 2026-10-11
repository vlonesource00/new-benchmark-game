import { SCHEMA as v1, observe as observeV1 } from './schema.mjs';
import { SCHEMA as v2, observe as observeV2 } from './schema-v2.mjs';
export function observationProfile(version = v1.version) {
  if (version === v1.version) return { schema: v1, observe: observeV1 };
  if (version === v2.version) return { schema: v2, observe: observeV2 };
  throw Error('Unknown observation version: ' + version);
}
