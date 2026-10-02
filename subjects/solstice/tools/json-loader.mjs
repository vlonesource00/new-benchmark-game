import { readFile } from 'node:fs/promises';

// Vite accepts the repository's existing JSON default imports without attributes.
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && new URL(url).pathname.endsWith('.json')) {
    const value = JSON.parse(await readFile(new URL(url), 'utf8'));
    return { format: 'module', source: `export default ${JSON.stringify(value)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
