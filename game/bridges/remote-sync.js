// Plain-data transport for worker-hosted drivers: `plain` strips functions and
// prototypes, `assignDeep` writes a snapshot into an existing object graph in
// place so every reference a driver holds into a replica car stays valid.
export function plain(value) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (ArrayBuffer.isView(value)) return value.slice();
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, plain(v)]));
  const out = {};
  for (const key in value) {
    const v = value[key];
    if (typeof v !== 'function') out[key] = plain(v);
  }
  return out;
}

export function assignDeep(target, source) {
  for (const key in source) {
    const s = source[key], t = target[key];
    if (s && t && typeof s === 'object' && typeof t === 'object' && !ArrayBuffer.isView(s) && !(s instanceof Map)
      && Array.isArray(s) === Array.isArray(t)) {
      if (Array.isArray(s)) {
        t.length = s.length;
        for (let i = 0; i < s.length; i += 1) {
          if (s[i] && t[i] && typeof s[i] === 'object' && typeof t[i] === 'object') assignDeep(t[i], s[i]);
          else t[i] = s[i];
        }
      } else assignDeep(t, s);
    } else target[key] = s;
  }
  return target;
}
