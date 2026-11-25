import { shallowMerge } from "./merge.js";

export function loadConfig(defaults = {}, file = {}) {
  return shallowMerge(defaults, file);
}
