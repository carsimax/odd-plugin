// Opt-in profile of permission rules that `/odd-setup deny-profile install` merges into the user's
// settings file. Never part of the installer or any default path (decision D1): the plugin ships
// no deny, only this user-run command adds it. Pure logic; the write path is in setup-fs.ts.
import { NO_CHANGES, detectIndent, isObject, parseSettings, unifiedDiff, type Plan } from "./setup.js";

const SECRET_PATHS = ["**/.env*", "~/.ssh/**", "~/.aws/credentials", "**/*.pem", "**/*.key"];

/** The rules this profile owns, in install order. */
export const DENY_PROFILE_RULES: readonly string[] = [
  ...SECRET_PATHS.map((p) => `Read(${p})`),
  ...SECRET_PATHS.map((p) => `Edit(${p})`),
  "Bash(git push *)",
  "Bash(git push)",
  "Bash(gh pr merge *)",
  "Bash(gh pr merge)",
];

export const DENY_ACTIONS = ["install", "remove"] as const;
export type DenyAction = (typeof DENY_ACTIONS)[number];

export function isDenyAction(v: unknown): v is DenyAction {
  return typeof v === "string" && (DENY_ACTIONS as readonly string[]).includes(v);
}

/** Deny rules (strings) present in a settings text; empty when absent or unparsable. */
export function denyRulesIn(text: string): string[] {
  const p = parseSettings(text, false);
  if (!p.ok || !isObject(p.root.permissions)) return [];
  const list = p.root.permissions.deny;
  return Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : [];
}

export type DenyPlan = (Plan & { ok: true; owned: string[] }) | { ok: false; error: string };

/**
 * `owned` are the rules a previous install recorded as added by this profile. Install adds only the
 * missing rules and owns just those; remove deletes only owned rules, so a rule the user already had
 * (never recorded) survives.
 */
export function planDenyProfile(text: string | null, action: string, owned: readonly string[], label = "settings.json"): DenyPlan {
  if (!isDenyAction(action)) return { ok: false, error: `invalid deny-profile action "${action}"; valid: ${DENY_ACTIONS.join(", ")}` };
  let root: Record<string, unknown> = {};
  let indent: string | number = 2;
  let trailingNewline = true;
  if (text !== null) {
    const parsed = parseSettings(text);
    if (!parsed.ok) return parsed;
    root = parsed.root;
    indent = detectIndent(text);
    trailingNewline = text.endsWith("\n");
  }
  const perms = isObject(root.permissions) ? root.permissions : {};
  const rawList = perms.deny;
  if (rawList !== undefined && !Array.isArray(rawList)) return { ok: false, error: "settings `permissions` list of deny rules is not an array; refusing to touch it" };
  const list: unknown[] = rawList === undefined ? [] : [...(rawList as unknown[])];

  let nextOwned: string[];
  if (action === "install") {
    const added = DENY_PROFILE_RULES.filter((r) => !list.includes(r));
    list.push(...added);
    nextOwned = [...new Set([...owned, ...added])];
  } else {
    const drop = new Set(owned);
    const kept = list.filter((r) => !(typeof r === "string" && drop.has(r)));
    list.length = 0;
    list.push(...kept);
    nextOwned = [];
  }
  const before = rawList === undefined ? 0 : (rawList as unknown[]).length;
  if (list.length === before && JSON.stringify(list) === JSON.stringify(rawList ?? [])) {
    return { ok: true, changed: false, before: text, after: text ?? "", diff: NO_CHANGES, owned: nextOwned };
  }
  if (list.length > 0) perms.deny = list;
  else delete perms.deny;
  if (Object.keys(perms).length > 0) root.permissions = perms;
  else delete root.permissions;
  const after = JSON.stringify(root, null, indent) + (trailingNewline ? "\n" : "");
  const diff = unifiedDiff(text ?? "", after, text === null ? "/dev/null" : label, label);
  return { ok: true, changed: after !== text, before: text, after, diff, owned: nextOwned };
}
