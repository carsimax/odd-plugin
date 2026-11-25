import { shallowMerge, deepMerge } from "./merge.js";
import { fromEnv, fromArgv } from "./sources.js";

export function loadConfig(defaults = {}, file = {}) {
  return shallowMerge(defaults, file);
}

export function resolveConfig({ defaults = {}, file = {}, env = {}, argv = [] } = {}) {
  return deepMerge(defaults, file, fromEnv(env), fromArgv(argv));
}
