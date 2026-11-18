// R39/R40 model profiles. Upstream (lib/profiles-orchestrator.ts, agent-model-resolution.ts, model-routing-authority.ts)
// rewrites the agents' routing config and Pi's global settings. In Claude Code the plugin's agent files live in the
// plugin cache (overwritten on every update), so they are never rewritten: the profile is plugin state mapping each
// odd-claude agent to { model, effort }, and the static frontmatter stays the base. It is applied per spawn, either
// by the orchestrator (the SessionStart context line asks it to pass `model` to the Agent tool) or by the optional
// mod's `agent.spawn` hook (hooks/register.ts reads the same `routing` map). No profile = no routing at all.
import { readPluginState, writePluginState, type StateOptions } from "./state.js";

/** Agents the profile routes, i.e. every agent file shipped in agents/. */
export const PROFILE_ROLES = [
  "odd-explore",
  "odd-verify",
  "odd-worker",
  "odd-jd-fix",
  "odd-jd-judge-a",
  "odd-jd-judge-b",
  "odd-review-readability",
  "odd-review-reliability",
  "odd-review-resilience",
  "odd-review-risk",
] as const;
/** Aliases the Agent tool's `model` parameter and `agent.spawn` accept. */
export const PROFILE_MODELS = ["haiku", "sonnet", "opus"] as const;
export const PROFILE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PRESET_NAMES = ["balanced", "economy", "max"] as const;
export const CUSTOM_PROFILE = "custom";

export interface RoleRoute {
  model: string;
  effort?: string;
}
export type Routing = Record<string, RoleRoute>;
export interface Profile {
  active: string | undefined;
  routing: Routing;
}

const r = (model: string, effort: string): RoleRoute => ({ model, effort });
const reviews = (model: string, effort: string): Routing => ({
  "odd-review-readability": r(model, effort),
  "odd-review-reliability": r(model, effort),
  "odd-review-resilience": r(model, effort),
  "odd-review-risk": r(model, effort),
});

/** Intent carried over from upstream: cheap discovery, strong judges, a mid-tier writer by default. */
export const PRESETS: Readonly<Record<(typeof PRESET_NAMES)[number], Routing>> = {
  balanced: {
    "odd-explore": r("haiku", "low"),
    "odd-worker": r("sonnet", "medium"),
    "odd-verify": r("sonnet", "high"),
    "odd-jd-fix": r("sonnet", "medium"),
    "odd-jd-judge-a": r("opus", "high"),
    "odd-jd-judge-b": r("opus", "high"),
    ...reviews("sonnet", "medium"),
  },
  economy: {
    "odd-explore": r("haiku", "low"),
    "odd-worker": r("sonnet", "low"),
    "odd-verify": r("haiku", "medium"),
    "odd-jd-fix": r("sonnet", "low"),
    "odd-jd-judge-a": r("sonnet", "medium"),
    "odd-jd-judge-b": r("sonnet", "medium"),
    ...reviews("haiku", "medium"),
  },
  max: {
    "odd-explore": r("sonnet", "medium"),
    "odd-worker": r("opus", "high"),
    "odd-verify": r("opus", "high"),
    "odd-jd-fix": r("opus", "high"),
    "odd-jd-judge-a": r("opus", "xhigh"),
    "odd-jd-judge-b": r("opus", "xhigh"),
    ...reviews("opus", "high"),
  },
};

const has = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);
const NONE: Profile = { active: undefined, routing: {} };

/** Plugin state `profiles`; corrupt or tampered content reads as no profile and unknown entries are dropped. */
export function readProfile(opts: StateOptions = {}): Profile {
  try {
    const raw = readPluginState("profiles", opts) as { active?: unknown; routing?: unknown };
    if (!has([...PRESET_NAMES, CUSTOM_PROFILE], raw.active)) return NONE;
    const routing: Routing = {};
    if (typeof raw.routing === "object" && raw.routing !== null) {
      for (const role of PROFILE_ROLES) {
        const e = (raw.routing as Record<string, unknown>)[role] as { model?: unknown; effort?: unknown } | undefined;
        if (typeof e !== "object" || e === null || !has(PROFILE_MODELS, e.model)) continue;
        routing[role] = has(PROFILE_EFFORTS, e.effort) ? { model: e.model, effort: e.effort } : { model: e.model };
      }
    }
    return { active: raw.active, routing };
  } catch {
    return NONE;
  }
}

/** Activates a preset. Throws on any other name without touching the stored profile. */
export function useProfile(name: string, opts: StateOptions = {}): Profile {
  if (!has(PRESET_NAMES, name)) throw new Error(`invalid profile ${JSON.stringify(name)}; available profiles: ${PRESET_NAMES.join(", ")}`);
  const routing = structuredClone(PRESETS[name as (typeof PRESET_NAMES)[number]]) as Routing;
  writePluginState("profiles", { active: name, routing }, opts);
  return { active: name, routing };
}

/** Changes one role (starting from the active profile) and marks the result `custom`. Validates before writing. */
export function setRole(role: string, model: string, effort: string | undefined, opts: StateOptions = {}): Profile {
  if (!has(PROFILE_ROLES, role)) throw new Error(`invalid role ${JSON.stringify(role)}; available roles: ${PROFILE_ROLES.join(", ")}`);
  if (!has(PROFILE_MODELS, model)) throw new Error(`invalid model ${JSON.stringify(model)}; available models: ${PROFILE_MODELS.join(", ")}`);
  if (effort !== undefined && !has(PROFILE_EFFORTS, effort)) throw new Error(`invalid effort ${JSON.stringify(effort)}; available efforts: ${PROFILE_EFFORTS.join(", ")}`);
  const routing: Routing = { ...readProfile(opts).routing, [role]: effort === undefined ? { model } : { model, effort } };
  writePluginState("profiles", { active: CUSTOM_PROFILE, routing }, opts);
  return { active: CUSTOM_PROFILE, routing };
}

/** Back to the agents' own frontmatter models. */
export function clearProfile(opts: StateOptions = {}): void {
  writePluginState("profiles", {}, opts);
}

/** SessionStart context line (non-mod routing); undefined without an active profile. Never throws. */
export function profileContextLine(opts: StateOptions = {}): string | undefined {
  const p = readProfile(opts);
  const entries = PROFILE_ROLES.filter((role) => p.routing[role] !== undefined).map((role) => `odd-claude:${role}=${p.routing[role]!.model}`);
  if (p.active === undefined || entries.length === 0) return undefined;
  return `Model profile: ${p.active}. When you call the Agent tool for one of these odd-claude agents, pass the \`model\` parameter shown (the agent's own frontmatter model is only the default): ${entries.join(", ")}. \`/odd-claude:profiles\` shows or changes it.`;
}

export function renderProfiles(p: Profile): string {
  if (p.active === undefined) return `no active profile (agents use their own frontmatter models)\npresets: ${PRESET_NAMES.join(", ")}`;
  const width = Math.max(...PROFILE_ROLES.map((x) => x.length)) + 2;
  const rows = PROFILE_ROLES.filter((role) => p.routing[role] !== undefined).map((role) => `${role.padEnd(width)}${p.routing[role]!.model.padEnd(8)}${p.routing[role]!.effort ?? "-"}`);
  return [`active: ${p.active}`, `${"ROLE".padEnd(width)}${"MODEL".padEnd(8)}EFFORT`, ...rows].join("\n");
}

export function renderPresetList(active: string | undefined): string {
  return PRESET_NAMES.map((n) => {
    const t = PRESETS[n];
    return `${n === active ? "*" : " "} ${n.padEnd(9)} explore=${t["odd-explore"]!.model} worker=${t["odd-worker"]!.model} verify=${t["odd-verify"]!.model} judges=${t["odd-jd-judge-a"]!.model}`;
  }).join("\n") + (active === CUSTOM_PROFILE ? "\n* custom" : "");
}
