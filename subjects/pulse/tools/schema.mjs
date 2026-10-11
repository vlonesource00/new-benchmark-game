import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEMA } from '../src/schema.mjs';
import { HOME, versions } from './versions.mjs';
const out = resolve(HOME, 'artifacts');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'schema.json'), JSON.stringify(SCHEMA, null, 2));
writeFileSync(resolve(out, 'versions.json'), JSON.stringify(versions(), null, 2));
console.log(JSON.stringify({ size: SCHEMA.size, groups: SCHEMA.groups, versions: versions() }));
