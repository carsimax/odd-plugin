export function coerce(text) {
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function setPath(target, path, value) {
  let node = target;
  for (const part of path.slice(0, -1)) {
    if (node[part] === null || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  node[path[path.length - 1]] = value;
}

export function fromEnv(env = {}) {
  const out = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("APP_") || name.length === 4) continue;
    setPath(out, name.slice(4).toLowerCase().split("__"), coerce(String(raw)));
  }
  return out;
}

export function fromArgv(argv = []) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--") || arg.length === 2) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) setPath(out, arg.slice(2).split("."), true);
    else setPath(out, arg.slice(2, eq).split("."), coerce(arg.slice(eq + 1)));
  }
  return out;
}
