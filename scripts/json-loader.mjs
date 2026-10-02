// Lets the headless sims import the bridges' JSON configs without import attributes
// (Vite handles them in the browser build). Usage: node --import ./scripts/json-loader.mjs …
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { ...context.importAttributes, type: 'json' } });
  return next(url, context);
}`));
