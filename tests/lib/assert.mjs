// Small helpers for asserting response-body shape in test cases.

// Navigate a dotted path (e.g. "basic_info.first_name"). Returns {present, value}.
export function field(obj, path) {
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return { present: false };
  }
  return { present: true, value: cur };
}

// Unwrap the standard { success, data, toast } envelope.
export const dataOf = (json) => (json && json.data !== undefined ? json.data : json) ?? {};

// Every dotted path must be present (key exists). Returns an error string or null.
export function requirePresent(obj, paths) {
  const missing = paths.filter((p) => !field(obj, p).present);
  return missing.length ? `missing app-critical fields: ${missing.join(', ')}` : null;
}

// Every dotted path must be ABSENT. Returns an error string or null.
export function requireAbsent(obj, paths) {
  const leaked = paths.filter((p) => field(obj, p).present);
  return leaked.length ? `fields must not be exposed: ${leaked.join(', ')}` : null;
}
