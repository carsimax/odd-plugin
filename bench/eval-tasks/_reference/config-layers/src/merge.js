export function shallowMerge(...objects) {
  return Object.assign({}, ...objects);
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function deepMerge(...objects) {
  const out = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (isPlain(value)) {
        out[key] = deepMerge(isPlain(out[key]) ? out[key] : {}, value);
      } else if (Array.isArray(value)) {
        out[key] = [...value];
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}
