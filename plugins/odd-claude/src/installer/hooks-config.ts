// settings.json `hooks` for the global install: entries mirror the payload hooks/hooks.json (events, matchers, timeouts,
// async) with commands pointing at <oddRoot>/dist/hooks/run.js. Ours are identified by that path in the command, so
// foreign hooks are never touched, removed or reordered.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateSettingsFile, type Settings, type WriteResult } from "./managed-settings.js";

export interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
  [key: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}
export type HookEntries = Record<string, HookGroup[]>;

const PLUGIN_CODEGRAPH = "mcp__plugin_odd-claude_codegraph__.*";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const runPath = (oddRoot: string): string => `${oddRoot.replace(/\/+$/, "")}/dist/hooks/run.js`;

function isOurs(hook: unknown, oddRoot: string): boolean {
  return isObject(hook) && typeof hook.command === "string" && hook.command.includes(runPath(oddRoot));
}

export function buildHookEntries(opts: { oddRoot: string; oddHome: string; defaultOddHome: string }): HookEntries {
  const src = JSON.parse(readFileSync(join(opts.oddRoot, "hooks", "hooks.json"), "utf8")) as { hooks?: Record<string, HookGroup[]> };
  const prefix = opts.oddHome === opts.defaultOddHome ? "" : `ODD_CLAUDE_HOME="${opts.oddHome}" `;
  const out: HookEntries = {};
  for (const [event, groups] of Object.entries(src.hooks ?? {})) {
    out[event] = groups.map((g) => {
      const group: HookGroup = { ...g, hooks: g.hooks.map((h) => ({ ...h, command: `${prefix}node "${runPath(opts.oddRoot)}" ${event}` })) };
      if (typeof g.matcher === "string") group.matcher = g.matcher.split("|").filter((m) => m !== PLUGIN_CODEGRAPH).join("|");
      return group;
    });
  }
  return out;
}

/** Adds our groups (refreshing them in place when already present); pure, returns a new settings object. */
export function mergeHooks(settings: Settings, entries: HookEntries): Settings {
  const out = structuredClone(settings);
  const hooks: Record<string, unknown> = isObject(out.hooks) ? out.hooks : {};
  for (const [event, groups] of Object.entries(entries)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ourRun = groups.flatMap((g) => g.hooks.map((h) => h.command));
    const isOurHook = (h: unknown): boolean => isObject(h) && typeof h.command === "string" && ourRun.some((c) => sameRun(c, h.command as string));
    const next: unknown[] = [];
    const pending = [...groups];
    for (const g of existing) {
      if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurHook)) {
        next.push(g);
        continue;
      }
      // Our group (possibly sharing a group with foreign hooks): keep the foreign part, refresh ours in place.
      const rest = g.hooks.filter((h) => !isOurHook(h));
      if (rest.length > 0) next.push({ ...g, hooks: rest });
      const replacement = pending.shift();
      if (replacement) next.push(replacement);
    }
    next.push(...pending);
    hooks[event] = next;
  }
  out.hooks = hooks;
  return out;
}

/** Same hook script and event, ignoring the optional ODD_CLAUDE_HOME prefix. */
function sameRun(a: string, b: string): boolean {
  const strip = (c: string): string => c.replace(/^ODD_CLAUDE_HOME="[^"]*" /, "");
  return strip(a) === strip(b);
}

/** Removes exactly our hook commands and drops groups, events and the `hooks` key that become empty. */
export function unmergeHooks(settings: Settings, oddRoot: string): Settings {
  const out = structuredClone(settings);
  if (!isObject(out.hooks)) return out;
  const hooks = out.hooks;
  let touched = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some((h) => isOurs(h, oddRoot))) {
        kept.push(g);
        continue;
      }
      touched = true;
      const rest = g.hooks.filter((h) => !isOurs(h, oddRoot));
      if (rest.length > 0) kept.push({ ...g, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
    else if (groups.length > 0) delete hooks[event];
  }
  if (touched && Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

interface HookPaths {
  settingsPath: string;
  backupDir: string;
  now?: Date;
}

function replaceWith(target: Settings, next: Settings): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}

export function installHooks(opts: HookPaths & { oddRoot: string; oddHome: string; defaultOddHome: string }): WriteResult {
  const entries = buildHookEntries(opts);
  return updateSettingsFile(opts, (s) => replaceWith(s, mergeHooks(unmergeHooks(s, opts.oddRoot), entries)));
}

export function uninstallHooks(opts: HookPaths & { oddRoot: string }): WriteResult {
  return updateSettingsFile(opts, (s) => replaceWith(s, unmergeHooks(s, opts.oddRoot)));
}
