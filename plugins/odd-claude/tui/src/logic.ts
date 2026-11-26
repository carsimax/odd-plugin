// Pure state helpers for the screens (no Ink), so they are tested without a terminal.
import { CUSTOM_PROFILE, PRESET_NAMES, PROFILE_MODELS, PROFILE_ROLES } from "../../src/lib/profiles.js";
import type { BuiltinPlugin, BuiltinSelection } from "../../src/installer/builtin-plugins.js";
import { defaultSelection, type ModelSelection, type ProfileChoice } from "../../src/installer/models.js";

export const PROFILES: readonly ProfileChoice[] = [...PRESET_NAMES, CUSTOM_PROFILE];

/** The profile whose preset has exactly these roles, else custom. */
export function profileOf(roles: Record<string, string>): ProfileChoice {
  for (const p of PRESET_NAMES) {
    const preset = defaultSelection(p).roles;
    if (PROFILE_ROLES.every((r) => preset[r] === roles[r])) return p;
  }
  return CUSTOM_PROFILE;
}

/** Choosing a preset replaces every role; choosing custom keeps the current roles. */
export function pickProfile(profile: ProfileChoice, current: ModelSelection): ModelSelection {
  return profile === CUSTOM_PROFILE ? { profile, roles: { ...current.roles } } : defaultSelection(profile);
}

/** Cycles one role through haiku -> sonnet -> opus; the profile follows (a preset again when the roles match one). */
export function cycleRole(selection: ModelSelection, role: string, dir: 1 | -1): ModelSelection {
  const models = PROFILE_MODELS as readonly string[];
  const i = models.indexOf(selection.roles[role] ?? "");
  const next = models[(i + dir + models.length * 2) % models.length]!;
  const roles = { ...selection.roles, [role]: next };
  return { profile: profileOf(roles), roles };
}

/** Short role name for display: `odd-review-risk` -> `review-risk`. */
export const roleLabel = (role: string): string => role.replace(/^odd-/, "");

/** "haiku x1, sonnet x6, opus x3" for the profile list. */
export function profileSummary(selection: ModelSelection): string {
  const counts = new Map<string, number>();
  for (const m of Object.values(selection.roles)) counts.set(m, (counts.get(m) ?? 0) + 1);
  return (PROFILE_MODELS as readonly string[]).filter((m) => counts.has(m)).map((m) => `${m} x${counts.get(m)}`).join(", ");
}

/** The ids the user left checked, as the extras builtin selection: all, none (keep) or a subset. Protected ones never count. */
export function builtinSelection(builtins: readonly BuiltinPlugin[], disabled: ReadonlySet<string>): BuiltinSelection {
  const free = builtins.filter((b) => !b.protected);
  const ids = free.filter((b) => disabled.has(b.id)).map((b) => b.id);
  if (ids.length === 0) return { mode: "keep" };
  return ids.length === free.length ? { mode: "all" } : { mode: "subset", ids };
}
