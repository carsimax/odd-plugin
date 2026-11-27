// Full install / uninstall / update flows over the installer modules. Pure Node with an injected runner: no UI,
// so the CLI and the Ink TUI share it and tests drive it without a terminal. Every step reports through `onStep`
// and a failure is returned as a step, never thrown. A dry run plans only: read-only detection commands may run,
// nothing is written and no external tool mutates anything.
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../lib/state.js";
import { isPidAlive } from "../lib/pid.js";
import { listBackups, restoreBackup, type BackupInfo } from "./backup.js";
import { detectDeps, installDeps, planDeps, type DepAction, type DepsDetected } from "./deps.js";
import { DEFAULT_EXTRAS, applyExtras, planExtras, removeExtras, type ExtrasOptions } from "./extras.js";
import { buildHookEntries, installHooks, uninstallHooks } from "./hooks-config.js";
import { installOutputStyle, readOddState, uninstallOutputStyle, writeOddState, type ManagedPaths } from "./managed-settings.js";
import { applyMcp, planMcp, removeMcp, type McpRunner } from "./mcp.js";
import { readSelection, type ModelSelection } from "./models.js";
import { activeVersion, assertVersion } from "./payload.js";
import { resolveInstallPaths, type InstallPaths } from "./paths.js";
import { installPlan, runInstall, runUninstall, summarizePlan, uninstallPlan, type InstallPlan } from "./plan.js";
import { detectOddPlugin, migrateFromPlugin, migratePluginState, pluginDataDir } from "./plugin-migration.js";
import { BUNDLE_ASSET, releaseRepo } from "./release.js";
import { checkLatest, compareVersions, downloadRelease, extractPayload, rollback, runUpdate, type RollbackResult, type UpdateResult } from "./update.js";

type Env = Record<string, string | undefined>;

export type StepStatus = "ok" | "skipped" | "warning" | "failed";
export interface StepResult {
  id: string;
  label: string;
  status: StepStatus;
  detail: string;
}
export type OnStep = (step: StepResult) => void;

export interface BaseOptions {
  env: Env;
  homedir: string;
  runner: McpRunner;
  dryRun?: boolean;
}

export interface FlowContext {
  paths: InstallPaths;
  managed: ManagedPaths;
  oddRoot: string;
  defaultOddHome: string;
  env: NodeJS.ProcessEnv;
}

/** Every path the flows touch, derived from env and home only. */
export function flowContext(o: { env: Env; homedir: string }): FlowContext {
  const paths = resolveInstallPaths(o.env, o.homedir);
  return {
    paths,
    managed: { settingsPath: join(paths.claudeDir, "settings.json"), statePath: join(paths.oddHome, "settings-state.json"), backupDir: paths.backupsDir },
    oddRoot: paths.currentLink,
    defaultOddHome: join(o.homedir, ".odd-claude"),
    env: o.env as NodeJS.ProcessEnv,
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/** Defaults for the real process: real env, real home, real runner is supplied by the caller. */
export const processBase = (): Pick<BaseOptions, "env" | "homedir"> => ({ env: process.env, homedir: osHomedir() });

// ---------------------------------------------------------------- detection

export interface Detection {
  node: { version: string; ok: boolean };
  claude: { present: boolean; version?: string };
  gh: { present: boolean; authenticated: boolean };
  deps: DepsDetected;
  installedVersion: string | null;
  /** Newest version known from the cached update check (no network); null when none is cached or it is not newer. */
  updateAvailable: string | null;
  /** Ids of the odd-claude plugin install, or null when `claude plugin list` could not answer. */
  pluginIds: string[] | null;
  selection: ModelSelection;
  paths: InstallPaths;
}

export async function detect(o: { env: Env; homedir: string; runner: McpRunner; nodeVersion?: string }): Promise<Detection> {
  const ctx = flowContext(o);
  const code = async (cmd: string, args: string[]): Promise<{ code: number | null; out: string }> => {
    try {
      const r = await o.runner(cmd, args, { env: ctx.env });
      return { code: r.code, out: firstLine(r.stdout) };
    } catch {
      return { code: null, out: "" };
    }
  };
  const nodeVersion = o.nodeVersion ?? process.versions.node;
  const claude = await code("claude", ["--version"]);
  const gh = await code("gh", ["--version"]);
  const auth = gh.code === 0 ? await code("gh", ["auth", "status"]) : { code: null, out: "" };
  const plugin = await detectOddPlugin(o.runner, ctx.env);
  const installedVersion = activeVersion(ctx.paths);
  let cached: { version?: unknown } | undefined;
  try {
    cached = readOddState(ctx.managed.statePath).update as { version?: unknown } | undefined;
  } catch {
    /* corrupt state: detection only skips the cached update hint; the flows report it */
  }
  const latest = typeof cached?.version === "string" ? cached.version : null;
  return {
    node: { version: nodeVersion, ok: Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10) >= 22 },
    claude: { present: claude.code === 0, ...(claude.code === 0 && claude.out ? { version: claude.out } : {}) },
    gh: { present: gh.code === 0, authenticated: auth.code === 0 },
    deps: await detectDeps(o.runner, ctx.env),
    installedVersion,
    updateAvailable: latest !== null && installedVersion !== null && compareVersions(latest, installedVersion) > 0 ? latest : null,
    pluginIds: plugin.ok ? plugin.ids : null,
    selection: readSelection(ctx.paths.dataDir),
    paths: ctx.paths,
  };
}

// ---------------------------------------------------------------- reporting helper

function reporter(onStep?: OnStep): { steps: StepResult[]; emit: (id: string, label: string, status: StepStatus, detail: string) => StepResult } {
  const steps: StepResult[] = [];
  return {
    steps,
    emit(id, label, status, detail) {
      const s = { id, label, status, detail };
      steps.push(s);
      try {
        onStep?.(s);
      } catch {
        /* a UI callback must never break the flow */
      }
      return s;
    },
  };
}

const worst = (list: StepStatus[]): StepStatus => (list.includes("failed") ? "failed" : list.includes("warning") ? "warning" : list.length > 0 && list.every((s) => s === "skipped") ? "skipped" : "ok");

// ---------------------------------------------------------------- extras persistence (update re-applies what the user chose)

function savedExtras(statePath: string): ExtrasOptions {
  const e = readOddState(statePath).extras as Partial<ExtrasOptions> | undefined;
  const b = e?.builtin as { mode?: string; ids?: unknown } | undefined;
  const ai = e?.claudeAi;
  if (!e || typeof e.statusLine !== "boolean" || !ai || typeof ai.connectors !== "boolean" || typeof ai.skills !== "boolean" || typeof ai.plugins !== "boolean") return DEFAULT_EXTRAS;
  const builtin: ExtrasOptions["builtin"] =
    b?.mode === "keep" ? { mode: "keep" } : b?.mode === "subset" && Array.isArray(b.ids) ? { mode: "subset", ids: b.ids.map(String) } : { mode: "all" };
  return { statusLine: e.statusLine, claudeAi: { connectors: ai.connectors, skills: ai.skills, plugins: ai.plugins }, builtin };
}

function saveExtras(statePath: string, extras: ExtrasOptions): void {
  writeOddState(statePath, { ...readOddState(statePath), extras });
}

// ---------------------------------------------------------------- install

export interface InstallFlowOptions extends BaseOptions {
  /** Local checkout (plugins/odd-claude layout); otherwise the latest GitHub release. */
  source?: string;
  /** Undefined keeps the stored selection (balanced when none), so reinstalling never resets the models. */
  selection?: ModelSelection;
  extras?: ExtrasOptions;
  /** Install Engram / codegraph when missing (still needs `confirmDep`). Default true. */
  deps?: boolean;
  confirmDep?: (action: DepAction) => boolean | Promise<boolean>;
  /** Uninstall the Claude Code plugin and carry its state over. Default true. */
  migrate?: boolean;
  force?: boolean;
}

export interface FullResult {
  ok: boolean;
  dryRun: boolean;
  version: string | null;
  steps: StepResult[];
  /** Dry run with a local source: the file-level plan the Review screen summarizes. */
  plan?: InstallPlan;
  summary?: string;
}

interface ResolvedSource {
  root?: string;
  version: string;
  detail: string;
  bundle?: string;
}

function readSourceVersion(root: string): string {
  const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  const v = String(raw.version ?? "");
  assertVersion(v);
  return v;
}

async function resolveSource(o: InstallFlowOptions, ctx: FlowContext, dry: boolean, work: { dir?: string }): Promise<ResolvedSource> {
  if (o.source !== undefined) {
    const root = resolve(o.source);
    if (!existsSync(join(root, "package.json"))) throw new Error(`--source ${root} has no package.json (expected the plugins/odd-claude tree)`);
    const version = readSourceVersion(root);
    return { root, version, detail: `local checkout ${root} (v${version})` };
  }
  const repo = releaseRepo(o.env);
  const latest = await checkLatest(o.runner, o.env, { statePath: dry ? undefined : ctx.managed.statePath, force: o.force });
  if (!latest.ok) throw new Error(latest.error);
  if (dry) return { version: latest.version, detail: `would download release v${latest.version} from ${repo}` };
  work.dir = mkdtempSync(join(tmpdir(), "odd-install-"));
  const dl = await downloadRelease(o.runner, { repo, version: latest.version, destDir: join(work.dir, "dl"), env: ctx.env });
  if (!dl.ok) throw new Error(dl.error);
  const ex = await extractPayload(o.runner, dl.tarball, join(work.dir, "src"), ctx.env);
  if (!ex.ok) throw new Error(ex.error);
  return { root: ex.root, version: latest.version, bundle: dl.bundle, detail: `release v${latest.version} from ${repo}, checksums verified` };
}

const INSTALL_STEPS: [string, string][] = [
  ["migrate", "Migrate from the Claude Code plugin"],
  ["source", "Resolve the payload"],
  ["install", "Install files, models and manifest"],
  ["hooks", "Register hooks in settings.json"],
  ["output-style", "Set the odd output style"],
  ["mcp", "Register MCP servers"],
  ["extras", "Status line, claude.ai sync, builtin plugins"],
  ["deps", "External dependencies (Engram, codegraph)"],
];
const label = (id: string): string => INSTALL_STEPS.find(([i]) => i === id)![1];

const lockBusy = (path: string): string => `another odd-claude install or update is running; wait for it to finish (or remove ${path} if it crashed)`;

/** Exclusive `<oddHome>/.lock` (pid inside). Returns a release function, or the failure message when another live run holds it or the lock cannot be created. A dead holder's lock is replaced. */
function acquireLock(oddHome: string): (() => void) | string {
  const path = join(oddHome, ".lock");
  try {
    return tryLock(oddHome, path);
  } catch (e) {
    return `cannot create the lock ${path}: ${errMsg(e)}`;
  }
}

function tryLock(oddHome: string, path: string): (() => void) | string {
  const created = !existsSync(oddHome);
  mkdirSync(oddHome, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        rmSync(path, { force: true });
        if (created) {
          try {
            rmdirSync(oddHome); // a run that wrote nothing leaves no trace
          } catch {
            /* not empty: keep it */
          }
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (isPidAlive(pid)) return lockBusy(path);
      unlinkSync(path);
    }
  }
  return lockBusy(path);
}

export async function runFullInstall(o: InstallFlowOptions, onStep?: OnStep): Promise<FullResult> {
  if (o.dryRun) return installFlow(o, onStep);
  const release = acquireLock(flowContext(o).paths.oddHome);
  if (typeof release === "string") {
    const { steps, emit } = reporter(onStep);
    emit("lock", "Install lock", "failed", release);
    return { ok: false, dryRun: false, version: null, steps };
  }
  try {
    return await installFlow(o, onStep);
  } finally {
    release();
  }
}

async function installFlow(o: InstallFlowOptions, onStep?: OnStep): Promise<FullResult> {
  const ctx = flowContext(o);
  const dry = o.dryRun === true;
  const { steps, emit } = reporter(onStep);
  const work: { dir?: string } = {};
  const extras = o.extras ?? DEFAULT_EXTRAS;
  let version: string | null = null;
  let plan: InstallPlan | undefined;
  let stoppedBy: string | null = null;
  const step = (id: string, status: StepStatus, detail: string): StepResult => emit(id, label(id), status, detail);
  const skipRest = (from: string): void => {
    const i = INSTALL_STEPS.findIndex(([id]) => id === from);
    for (const [id, lbl] of INSTALL_STEPS.slice(i)) emit(id, lbl, "skipped", `not run: ${stoppedBy} failed`);
  };

  try {
    // 1. migrate
    if (o.migrate === false) step("migrate", "skipped", "disabled");
    else {
      const parts: string[] = [];
      const states: StepStatus[] = [];
      // State is copied BEFORE the uninstall: `claude plugin uninstall` deletes the plugin data dir.
      const dirs = pluginDataDir(ctx.paths.claudeDir);
      if (dirs.length > 0) {
        if (dry) parts.push(`would copy state from ${dirs.length} plugin data dir(s)`);
        else {
          const copied: string[] = [];
          try {
            for (const d of dirs) copied.push(...migratePluginState(d, ctx.paths.dataDir).copied);
            if (copied.length > 0) parts.push(`copied ${[...new Set(copied)].join(", ")}`);
          } catch (e) {
            states.push("warning");
            parts.push(`state copy failed: ${errMsg(e)}`);
          }
        }
      }
      const det = await detectOddPlugin(o.runner, ctx.env);
      if (!det.ok) parts.push(`plugin detection unavailable (${det.error})`);
      else if (det.ids.length > 0) {
        if (dry) parts.push(`would uninstall plugin ${det.ids.join(", ")}`);
        else {
          const m = await migrateFromPlugin(o.runner, det.ids, ctx.env);
          if (m.failed.length > 0) {
            states.push("warning");
            parts.push(`could not uninstall ${m.failed.map((f) => `${f.id} (${f.error})`).join(", ")}; remove it manually to avoid duplicate hooks`);
          } else parts.push(`uninstalled plugin ${m.uninstalled.join(", ")}`);
          if (m.marketplace === "failed") {
            states.push("warning");
            parts.push(`marketplace not removed: ${m.marketplaceError}`);
          }
        }
      }
      step("migrate", states.length > 0 ? worst(states) : parts.some((p) => p.startsWith("would") || p.startsWith("uninstalled") || p.startsWith("copied")) ? "ok" : "skipped", parts.length > 0 ? parts.join("; ") : "no plugin install found");
    }

    // 2. payload source
    let src: ResolvedSource;
    try {
      src = await resolveSource(o, ctx, dry, work);
    } catch (e) {
      step("source", "failed", errMsg(e));
      stoppedBy = "source";
      skipRest("install");
      return { ok: false, dryRun: dry, version, steps };
    }
    version = src.version;
    step("source", "ok", src.detail);

    // 3. files, models, manifest
    const selection = o.selection ?? readSelection(ctx.paths.dataDir);
    if (dry) {
      if (src.root) {
        try {
          plan = installPlan({ paths: ctx.paths, sourceRoot: src.root, version: src.version, selection });
          const summary = summarizePlan(plan).split("\n").join("; ");
          step("install", plan.warnings.length > 0 || plan.actions.some((a) => a.action === "conflict") ? "warning" : "ok", `would install v${src.version} (${selection.profile}): ${summary}`);
        } catch (e) {
          step("install", "failed", errMsg(e));
          stoppedBy = "install";
        }
      } else step("install", "ok", `would stage v${src.version} (${selection.profile}) and install its files`);
    } else {
      try {
        const r = runInstall({ paths: ctx.paths, sourceRoot: src.root!, version: src.version, selection });
        const notes = [...r.conflicts.map((c) => `kept ${c}`), ...r.warnings];
        step("install", notes.length > 0 ? "warning" : "ok", `v${r.version} (${selection.profile}): ${r.written.length} files written${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`);
        if (src.bundle) {
          atomicWriteFile(join(ctx.paths.oddHome, "bin", BUNDLE_ASSET), readFileSync(src.bundle), 0o755);
        }
      } catch (e) {
        step("install", "failed", errMsg(e));
        stoppedBy = "install";
      }
    }
    if (stoppedBy) {
      skipRest("hooks");
      return { ok: false, dryRun: dry, version, steps, plan };
    }

    // 4. hooks
    if (dry) {
      const n = src.root && existsSync(join(src.root, "hooks", "hooks.json")) ? Object.keys(buildHookEntries({ oddRoot: src.root, oddHome: ctx.paths.oddHome, defaultOddHome: ctx.defaultOddHome })).length : null;
      step("hooks", "ok", n === null ? "would merge odd hooks into settings.json" : `would merge hooks for ${n} events into settings.json`);
    } else {
      try {
        const r = installHooks({ ...ctx.managed, oddRoot: ctx.oddRoot, oddHome: ctx.paths.oddHome, defaultOddHome: ctx.defaultOddHome });
        step("hooks", r.status === "error" ? "failed" : "ok", r.status === "error" ? r.error ?? "hooks failed" : r.status === "unchanged" ? "hooks already registered" : "hooks registered");
      } catch (e) {
        step("hooks", "failed", errMsg(e));
      }
    }

    // 5. output style
    if (dry) step("output-style", "ok", 'would set outputStyle to "odd" (previous value is restored on uninstall)');
    else {
      try {
        const r = installOutputStyle(ctx.managed);
        step("output-style", r.status === "error" ? "failed" : "ok", r.status === "error" ? r.error ?? "output style failed" : r.status === "unchanged" ? 'outputStyle already "odd"' : 'outputStyle set to "odd"');
      } catch (e) {
        step("output-style", "failed", errMsg(e));
      }
    }

    // 6. MCP
    try {
      if (dry) {
        const p = await planMcp({ runner: o.runner, env: ctx.env, oddRoot: ctx.oddRoot });
        const add = p.servers.filter((s) => s.action === "add").map((s) => s.name);
        const unknown = p.servers.filter((s) => s.action === "unknown");
        step("mcp", unknown.length > 0 ? "warning" : "ok", `would register ${add.join(", ") || "nothing"}${unknown.length > 0 ? `; ${unknown[0]!.detail}` : ""}`);
      } else {
        const { results } = await applyMcp({ runner: o.runner, env: ctx.env, oddRoot: ctx.oddRoot, statePath: ctx.managed.statePath, dataDir: ctx.paths.dataDir });
        const bad = results.filter((r) => r.status === "failed" || r.status === "unknown");
        step("mcp", bad.length > 0 ? "warning" : "ok", results.map((r) => `${r.name}: ${r.status}${r.status === "failed" || r.status === "unknown" ? ` (${r.detail})` : ""}`).join(", "));
      }
    } catch (e) {
      step("mcp", "failed", errMsg(e));
    }

    // 7. extras
    try {
      if (dry) {
        const p = await planExtras({ oddRoot: ctx.oddRoot, options: extras, runner: o.runner, env: ctx.env });
        step("extras", p.warnings.length > 0 ? "warning" : "ok", `would change ${p.changes.length} settings${p.warnings.length > 0 ? `; ${p.warnings.join("; ")}` : ""}`);
      } else {
        const r = await applyExtras({ oddRoot: ctx.oddRoot, options: extras, runner: o.runner, env: ctx.env, paths: ctx.managed });
        if (r.settings?.status === "error") step("extras", "failed", r.settings.error ?? "settings write failed");
        else {
          saveExtras(ctx.managed.statePath, extras);
          step("extras", r.warnings.length > 0 ? "warning" : "ok", `${r.settings?.changed.length ?? 0} settings changed${r.warnings.length > 0 ? `; ${r.warnings.join("; ")}` : ""}`);
        }
      }
    } catch (e) {
      step("extras", "failed", errMsg(e));
    }

    // 8. dependencies
    if (o.deps === false) step("deps", "skipped", "disabled (--no-deps)");
    else {
      try {
        if (dry) {
          const acts = planDeps(await detectDeps(o.runner, ctx.env));
          step("deps", acts.some((a) => a.status === "manual") ? "warning" : "ok", acts.map((a) => `${a.name}: ${a.status === "install" ? "would install" : a.status}`).join(", "));
        } else {
          const rs = await installDeps(o.runner, { confirm: o.confirmDep ?? (() => false), env: ctx.env });
          const st: StepStatus = rs.some((r) => r.status === "failed" || r.status === "manual") ? "warning" : rs.every((r) => r.status === "declined" || r.status === "skipped") && rs.some((r) => r.status === "declined") ? "skipped" : "ok";
          step("deps", st, rs.map((r) => `${r.name}: ${r.status}${r.status === "failed" || r.status === "manual" ? ` (${r.detail})` : ""}`).join(", "));
        }
      } catch (e) {
        step("deps", "failed", errMsg(e));
      }
    }
    return { ok: !steps.some((s) => s.status === "failed"), dryRun: dry, version, steps, plan, summary: plan ? summarizePlan(plan) : undefined };
  } finally {
    if (work.dir) rmSync(work.dir, { recursive: true, force: true });
  }
}

/** Dry run: the steps that would run and the file-level plan. Writes nothing. */
export function planFullInstall(o: InstallFlowOptions): Promise<FullResult> {
  return runFullInstall({ ...o, dryRun: true });
}

// ---------------------------------------------------------------- uninstall

export interface UninstallFlowOptions extends BaseOptions {
  purge?: boolean;
}

const UNINSTALL_STEPS: [string, string][] = [
  ["extras", "Restore status line, claude.ai sync, builtin plugins"],
  ["mcp", "Remove MCP servers odd-claude added"],
  ["output-style", "Restore the previous output style"],
  ["hooks", "Remove odd hooks from settings.json"],
  ["files", "Remove installed files"],
];

/** Reverse of the install order. Never uninstalls Engram or codegraph. */
export async function runFullUninstall(o: UninstallFlowOptions, onStep?: OnStep): Promise<FullResult> {
  const ctx = flowContext(o);
  const dry = o.dryRun === true;
  const { steps, emit } = reporter(onStep);
  const step = (id: string, status: StepStatus, detail: string): void => void emit(id, UNINSTALL_STEPS.find(([i]) => i === id)![1], status, detail);
  const guard = async (id: string, fn: () => Promise<[StepStatus, string]> | [StepStatus, string]): Promise<void> => {
    try {
      const [s, d] = await fn();
      step(id, s, d);
    } catch (e) {
      step(id, "failed", errMsg(e));
    }
  };
  const restoreNote = (r: { status: string; error?: string; restored: string[][]; kept: { reason: string }[] }): [StepStatus, string] =>
    r.status === "error" ? ["failed", r.error ?? "settings write failed"] : [r.kept.length > 0 ? "warning" : "ok", `${r.restored.length} restored${r.kept.length > 0 ? `; ${r.kept.map((k) => k.reason).join("; ")}` : ""}`];

  const state = readOddState(ctx.managed.statePath);
  await guard("extras", () => {
    if (dry) return ["ok", `would restore ${Object.values(state.settings ?? {}).filter((s) => ["statusLine", "disableClaudeAiConnectors", "syncClaudeAiSkills", "syncClaudeAiPlugins", "enabledPlugins"].includes(s.path[0]!)).length} settings`];
    const r = restoreNote(removeExtras({ paths: ctx.managed }));
    if (state.extras !== undefined) {
      const cur = readOddState(ctx.managed.statePath);
      delete cur.extras;
      writeOddState(ctx.managed.statePath, cur);
    }
    return r;
  });
  await guard("mcp", async () => {
    const recorded = Array.isArray(state.mcp?.added) ? state.mcp.added : [];
    if (dry) return ["ok", recorded.length > 0 ? `would remove ${recorded.join(", ")}` : "no servers recorded"];
    const { results } = await removeMcp({ runner: o.runner, env: ctx.env, statePath: ctx.managed.statePath });
    return [results.some((r) => r.status === "failed") ? "warning" : "ok", results.length > 0 ? results.map((r) => `${r.name}: ${r.status}${r.status === "failed" ? ` (${r.detail})` : ""}`).join(", ") : "no servers recorded"];
  });
  await guard("output-style", () => (dry ? ["ok", "would restore the previous outputStyle"] : restoreNote(uninstallOutputStyle(ctx.managed))));
  await guard("hooks", () => {
    if (dry) return ["ok", "would remove odd hook entries (foreign hooks stay)"];
    const r = uninstallHooks({ ...ctx.managed, oddRoot: ctx.oddRoot });
    return [r.status === "error" ? "failed" : "ok", r.status === "error" ? r.error ?? "hooks failed" : r.status === "unchanged" ? "no odd hooks found" : "odd hooks removed"];
  });
  let plan: ReturnType<typeof uninstallPlan> | undefined;
  await guard("files", () => {
    plan = uninstallPlan({ paths: ctx.paths, purge: o.purge });
    if (dry) return ["ok", `would remove ${plan.actions.filter((a) => a.area === "file" && a.action === "remove").length} files${o.purge ? " and purge data and backups" : "; data and backups are kept"}`];
    const r = runUninstall({ paths: ctx.paths, purge: o.purge });
    if (o.purge) {
      rmSync(ctx.managed.statePath, { force: true });
      rmSync(join(ctx.paths.oddHome, "bin"), { recursive: true, force: true });
      try {
        rmdirSync(ctx.paths.oddHome);
      } catch {
        /* not empty: leave it */
      }
    }
    return [r.kept.length > 0 ? "warning" : "ok", `${r.removed.length} files removed${r.kept.length > 0 ? `; kept edited files: ${r.kept.join(", ")}` : ""}${o.purge ? "; data and backups purged" : ""}`];
  });
  return { ok: !steps.some((s) => s.status === "failed"), dryRun: dry, version: null, steps, summary: plan ? summarizePlan(plan) : undefined };
}

// ---------------------------------------------------------------- update, rollback, models, backups

export interface UpdateFlowOptions extends BaseOptions {
  force?: boolean;
  /** Overrides the stored selection (default: the installed one). */
  selection?: ModelSelection;
  now?: () => number;
  /** Re-apply with the freshly staged version's installer (a child process through the runner) instead of the running code. */
  reapplyInNewVersion?: boolean;
}
export interface UpdateFlowResult extends FullResult {
  status: UpdateResult["status"];
  from: string | null;
  to?: string;
}

/** runUpdate, then re-applies hooks, MCP and extras idempotently with the options saved at install. */
export async function runUpdateFlow(o: UpdateFlowOptions, onStep?: OnStep): Promise<UpdateFlowResult> {
  if (o.dryRun) return updateFlow(o, onStep);
  const ctx = flowContext(o);
  const release = acquireLock(ctx.paths.oddHome);
  if (typeof release === "string") {
    const { steps, emit } = reporter(onStep);
    emit("lock", "Update lock", "failed", release);
    return { ok: false, dryRun: false, version: null, steps, status: "failed", from: activeVersion(ctx.paths) };
  }
  try {
    return await updateFlow(o, onStep);
  } finally {
    release();
  }
}

async function updateFlow(o: UpdateFlowOptions, onStep?: OnStep): Promise<UpdateFlowResult> {
  const ctx = flowContext(o);
  const { steps, emit } = reporter(onStep);
  const selection = o.selection ?? readSelection(ctx.paths.dataDir);
  let u: UpdateResult;
  try {
    u = await runUpdate({ runner: o.runner, env: o.env, paths: ctx.paths, selection, force: o.force, dryRun: o.dryRun, now: o.now });
  } catch (e) {
    emit("update", "Update from GitHub Releases", "failed", errMsg(e));
    return { ok: false, dryRun: o.dryRun === true, version: null, steps, status: "failed", from: activeVersion(ctx.paths) };
  }
  const base = { dryRun: o.dryRun === true, version: u.to ?? u.from, status: u.status, from: u.from, to: u.to };
  const lbl = "Update from GitHub Releases";
  if (u.status === "check-failed" || u.status === "failed") {
    emit("update", lbl, "failed", `${u.error ?? "update failed"}${u.rolledBack ? "; previous version restored" : ""}`);
    return { ...base, ok: false, steps };
  }
  if (u.status === "up-to-date") {
    emit("update", lbl, "skipped", `already on v${u.from}`);
    return { ...base, ok: true, steps };
  }
  if (u.status === "dry-run") {
    emit("update", lbl, "ok", `would update ${u.from ?? "none"} -> ${u.to}: ${(u.steps ?? []).join("; ")}`);
    return { ...base, ok: true, steps };
  }
  emit("update", lbl, u.warnings && u.warnings.length > 0 ? "warning" : "ok", `${u.from ?? "none"} -> ${u.to}`);
  let reapply: StepResult[] | undefined;
  if (o.reapplyInNewVersion && u.to !== undefined) {
    const viaChild = await reapplyWithNewInstaller(o, ctx, u.to);
    if ("timedOut" in viaChild) {
      emit("reapply", "Re-apply with the new installer", "failed", viaChild.timedOut);
      return { ...base, ok: false, steps };
    }
    if ("steps" in viaChild) reapply = viaChild.steps.map((s) => emit(s.id, s.label, s.status, s.detail));
    else emit("reapply", "Re-apply with the new installer", "warning", `${viaChild.reason}; re-applied with the running version`);
  }
  reapply ??= await reapplyIntegrations(o, ctx, emit);
  return { ...base, ok: !reapply.some((s) => s.status === "failed"), steps };
}

const REAPPLY_TIMEOUT_MS = 300_000;

/**
 * Runs `reapply --json` from the staged version's own bin, so a release that adds migrations applies them in the
 * same `update`. Anything but a parseable step list (spawn error, old bin without the command) falls back.
 */
async function reapplyWithNewInstaller(o: BaseOptions, ctx: FlowContext, to: string): Promise<{ steps: StepResult[] } | { reason: string } | { timedOut: string }> {
  const bin = join(ctx.paths.versionsDir, to, "dist", "installer", "bin.js");
  let r;
  try {
    r = await o.runner(process.execPath, [bin, "reapply", "--json"], { env: { ...o.env, HOME: o.homedir }, timeout: REAPPLY_TIMEOUT_MS });
  } catch (e) {
    // A child killed mid-run may have half-applied a migration: never repeat it in-process on top of that.
    if ((e as NodeJS.ErrnoException).code === "ETIMEDOUT") return { timedOut: `the v${to} installer timed out after ${REAPPLY_TIMEOUT_MS / 1000} s; run update again` };
    return { reason: `could not start the v${to} installer (${errMsg(e)})` };
  }
  try {
    const doc = JSON.parse(r.stdout) as { steps?: unknown };
    const ok = Array.isArray(doc.steps) && doc.steps.length > 0 && doc.steps.every((x) => x && typeof x.id === "string" && typeof x.label === "string" && typeof x.status === "string" && x.status in { ok: 1, skipped: 1, warning: 1, failed: 1 });
    if (ok) return { steps: (doc.steps as StepResult[]).map((x) => ({ id: x.id, label: x.label, status: x.status, detail: typeof x.detail === "string" ? x.detail : "" })) };
  } catch {
    /* not JSON */
  }
  return { reason: `the v${to} installer has no usable reapply (exit ${r.code}: ${firstLine(r.stderr) || "no output"})` };
}

/** Internal `reapply`: hooks, MCP and extras for the installed version, with the options saved at install. */
export async function runReapply(o: BaseOptions, onStep?: OnStep): Promise<FullResult> {
  const ctx = flowContext(o);
  const { steps, emit } = reporter(onStep);
  const version = activeVersion(ctx.paths);
  if (version === null) {
    emit("reapply", "Re-apply integrations", "failed", "odd-claude is not installed; run install first");
    return { ok: false, dryRun: o.dryRun === true, version, steps };
  }
  const out = o.dryRun ? [emit("reapply", "Re-apply integrations", "ok", "would refresh hooks, MCP and extras")] : await reapplyIntegrations(o, ctx, emit);
  return { ok: !out.some((s) => s.status === "failed"), dryRun: o.dryRun === true, version, steps };
}

async function reapplyIntegrations(o: BaseOptions, ctx: FlowContext, emit: ReturnType<typeof reporter>["emit"]): Promise<StepResult[]> {
  const out: StepResult[] = [];
  const add = (id: string, status: StepStatus, detail: string): void => void out.push(emit(id, label(id), status, detail));
  try {
    const h = installHooks({ ...ctx.managed, oddRoot: ctx.oddRoot, oddHome: ctx.paths.oddHome, defaultOddHome: ctx.defaultOddHome });
    add("hooks", h.status === "error" ? "failed" : "ok", h.status === "error" ? h.error ?? "hooks failed" : "hooks refreshed");
  } catch (e) {
    add("hooks", "failed", errMsg(e));
  }
  try {
    const { results } = await applyMcp({ runner: o.runner, env: ctx.env, oddRoot: ctx.oddRoot, statePath: ctx.managed.statePath, dataDir: ctx.paths.dataDir });
    add("mcp", results.some((r) => r.status === "failed" || r.status === "unknown") ? "warning" : "ok", results.map((r) => `${r.name}: ${r.status}`).join(", "));
  } catch (e) {
    add("mcp", "failed", errMsg(e));
  }
  try {
    const r = await applyExtras({ oddRoot: ctx.oddRoot, options: savedExtras(ctx.managed.statePath), runner: o.runner, env: ctx.env, paths: ctx.managed });
    add("extras", r.settings?.status === "error" ? "failed" : r.warnings.length > 0 ? "warning" : "ok", r.settings?.status === "error" ? r.settings.error ?? "settings write failed" : `${r.settings?.changed.length ?? 0} settings changed`);
  } catch (e) {
    add("extras", "failed", errMsg(e));
  }
  return out;
}

export function runRollback(o: { env: Env; homedir: string; to?: string; selection?: ModelSelection }, onStep?: OnStep): FullResult & { rollback: RollbackResult } {
  const ctx = flowContext(o);
  const { steps, emit } = reporter(onStep);
  const r = rollback({ paths: ctx.paths, selection: o.selection ?? readSelection(ctx.paths.dataDir), to: o.to });
  const lbl = "Roll back to the previous version";
  if (r.ok) emit("rollback", lbl, r.warnings && r.warnings.length > 0 ? "warning" : "ok", `${r.from ?? "none"} -> ${r.to}`);
  else emit("rollback", lbl, "failed", r.error ?? "rollback failed");
  return { ok: r.ok, dryRun: false, version: r.to ?? r.from, steps, rollback: r };
}

/** "Configure models": re-installs agent files and profile state for the installed version from its staged payload. */
export function applyModels(o: { env: Env; homedir: string; selection: ModelSelection }, onStep?: OnStep): FullResult {
  const ctx = flowContext(o);
  const { steps, emit } = reporter(onStep);
  const lbl = "Apply the model selection";
  const version = activeVersion(ctx.paths);
  if (version === null) {
    emit("models", lbl, "failed", "odd-claude is not installed; run install first");
    return { ok: false, dryRun: false, version, steps };
  }
  try {
    const r = runInstall({ paths: ctx.paths, sourceRoot: join(ctx.paths.versionsDir, version), version, selection: o.selection });
    emit("models", lbl, r.conflicts.length > 0 ? "warning" : "ok", `${o.selection.profile}: ${r.written.length} agent/skill files updated${r.conflicts.length > 0 ? `; kept edited files: ${r.conflicts.join(", ")}` : ""}`);
    return { ok: true, dryRun: false, version, steps };
  } catch (e) {
    emit("models", lbl, "failed", errMsg(e));
    return { ok: false, dryRun: false, version, steps };
  }
}

export function backupsOf(o: { env: Env; homedir: string }): BackupInfo[] {
  return listBackups(flowContext(o).paths);
}

export function restoreBackupFlow(o: { env: Env; homedir: string; id: string }, onStep?: OnStep): FullResult {
  const { steps, emit } = reporter(onStep);
  try {
    const files = restoreBackup(flowContext(o).paths, o.id);
    emit("restore", "Restore backup", "ok", `${files.length} files restored from ${o.id}`);
    return { ok: true, dryRun: false, version: null, steps };
  } catch (e) {
    emit("restore", "Restore backup", "failed", errMsg(e));
    return { ok: false, dryRun: false, version: null, steps };
  }
}
