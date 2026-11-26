// Full install / uninstall / update flows over the installer modules. Pure Node with an injected runner: no UI,
// so the CLI and the Ink TUI share it and tests drive it without a terminal. Every step reports through `onStep`
// and a failure is returned as a step, never thrown. A dry run plans only: read-only detection commands may run,
// nothing is written and no external tool mutates anything.
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./manifest.js";
import { listBackups, restoreBackup } from "./backup.js";
import { detectDeps, installDeps, planDeps } from "./deps.js";
import { DEFAULT_EXTRAS, applyExtras, planExtras, removeExtras } from "./extras.js";
import { buildHookEntries, installHooks, uninstallHooks } from "./hooks-config.js";
import { installOutputStyle, readOddState, uninstallOutputStyle, writeOddState } from "./managed-settings.js";
import { applyMcp, planMcp, removeMcp } from "./mcp.js";
import { readSelection } from "./models.js";
import { activeVersion, assertVersion } from "./payload.js";
import { resolveInstallPaths } from "./paths.js";
import { installPlan, runInstall, runUninstall, summarizePlan, uninstallPlan } from "./plan.js";
import { detectOddPlugin, migrateFromPlugin, migratePluginState, pluginDataDir } from "./plugin-migration.js";
import { BUNDLE_ASSET, releaseRepo } from "./release.js";
import { checkLatest, compareVersions, downloadRelease, extractPayload, rollback, runUpdate } from "./update.js";
/** Every path the flows touch, derived from env and home only. */
export function flowContext(o) {
    const paths = resolveInstallPaths(o.env, o.homedir);
    return {
        paths,
        managed: { settingsPath: join(paths.claudeDir, "settings.json"), statePath: join(paths.oddHome, "settings-state.json"), backupDir: paths.backupsDir },
        oddRoot: paths.currentLink,
        defaultOddHome: join(o.homedir, ".odd-claude"),
        env: o.env,
    };
}
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
const firstLine = (s) => s.trim().split("\n")[0] ?? "";
/** Defaults for the real process: real env, real home, real runner is supplied by the caller. */
export const processBase = () => ({ env: process.env, homedir: osHomedir() });
export async function detect(o) {
    const ctx = flowContext(o);
    const code = async (cmd, args) => {
        try {
            const r = await o.runner(cmd, args, { env: ctx.env });
            return { code: r.code, out: firstLine(r.stdout) };
        }
        catch {
            return { code: null, out: "" };
        }
    };
    const nodeVersion = o.nodeVersion ?? process.versions.node;
    const claude = await code("claude", ["--version"]);
    const gh = await code("gh", ["--version"]);
    const auth = gh.code === 0 ? await code("gh", ["auth", "status"]) : { code: null, out: "" };
    const plugin = await detectOddPlugin(o.runner, ctx.env);
    const installedVersion = activeVersion(ctx.paths);
    const cached = readOddState(ctx.managed.statePath).update;
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
function reporter(onStep) {
    const steps = [];
    return {
        steps,
        emit(id, label, status, detail) {
            const s = { id, label, status, detail };
            steps.push(s);
            try {
                onStep?.(s);
            }
            catch {
                /* a UI callback must never break the flow */
            }
            return s;
        },
    };
}
const worst = (list) => (list.includes("failed") ? "failed" : list.includes("warning") ? "warning" : list.length > 0 && list.every((s) => s === "skipped") ? "skipped" : "ok");
// ---------------------------------------------------------------- extras persistence (update re-applies what the user chose)
function savedExtras(statePath) {
    const e = readOddState(statePath).extras;
    const b = e?.builtin;
    const ai = e?.claudeAi;
    if (!e || typeof e.statusLine !== "boolean" || !ai || typeof ai.connectors !== "boolean" || typeof ai.skills !== "boolean" || typeof ai.plugins !== "boolean")
        return DEFAULT_EXTRAS;
    const builtin = b?.mode === "keep" ? { mode: "keep" } : b?.mode === "subset" && Array.isArray(b.ids) ? { mode: "subset", ids: b.ids.map(String) } : { mode: "all" };
    return { statusLine: e.statusLine, claudeAi: { connectors: ai.connectors, skills: ai.skills, plugins: ai.plugins }, builtin };
}
function saveExtras(statePath, extras) {
    writeOddState(statePath, { ...readOddState(statePath), extras });
}
function readSourceVersion(root) {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const v = String(raw.version ?? "");
    assertVersion(v);
    return v;
}
async function resolveSource(o, ctx, dry, work) {
    if (o.source !== undefined) {
        const root = resolve(o.source);
        if (!existsSync(join(root, "package.json")))
            throw new Error(`--source ${root} has no package.json (expected the plugins/odd-claude tree)`);
        const version = readSourceVersion(root);
        return { root, version, detail: `local checkout ${root} (v${version})` };
    }
    const repo = releaseRepo(o.env);
    const latest = await checkLatest(o.runner, o.env, { statePath: dry ? undefined : ctx.managed.statePath, force: o.force });
    if (!latest.ok)
        throw new Error(latest.error);
    if (dry)
        return { version: latest.version, detail: `would download release v${latest.version} from ${repo}` };
    work.dir = mkdtempSync(join(tmpdir(), "odd-install-"));
    const dl = await downloadRelease(o.runner, { repo, version: latest.version, destDir: join(work.dir, "dl"), env: ctx.env });
    if (!dl.ok)
        throw new Error(dl.error);
    const ex = await extractPayload(o.runner, dl.tarball, join(work.dir, "src"), ctx.env);
    if (!ex.ok)
        throw new Error(ex.error);
    return { root: ex.root, version: latest.version, bundle: dl.bundle, detail: `release v${latest.version} from ${repo}, checksums verified` };
}
const INSTALL_STEPS = [
    ["migrate", "Migrate from the Claude Code plugin"],
    ["source", "Resolve the payload"],
    ["install", "Install files, models and manifest"],
    ["hooks", "Register hooks in settings.json"],
    ["output-style", "Set the odd output style"],
    ["mcp", "Register MCP servers"],
    ["extras", "Status line, claude.ai sync, builtin plugins"],
    ["deps", "External dependencies (Engram, codegraph)"],
];
const label = (id) => INSTALL_STEPS.find(([i]) => i === id)[1];
export async function runFullInstall(o, onStep) {
    const ctx = flowContext(o);
    const dry = o.dryRun === true;
    const { steps, emit } = reporter(onStep);
    const work = {};
    const extras = o.extras ?? DEFAULT_EXTRAS;
    let version = null;
    let plan;
    let stoppedBy = null;
    const step = (id, status, detail) => emit(id, label(id), status, detail);
    const skipRest = (from) => {
        const i = INSTALL_STEPS.findIndex(([id]) => id === from);
        for (const [id, lbl] of INSTALL_STEPS.slice(i))
            emit(id, lbl, "skipped", `not run: ${stoppedBy} failed`);
    };
    try {
        // 1. migrate
        if (o.migrate === false)
            step("migrate", "skipped", "disabled");
        else {
            const parts = [];
            const states = [];
            const det = await detectOddPlugin(o.runner, ctx.env);
            if (!det.ok)
                parts.push(`plugin detection unavailable (${det.error})`);
            else if (det.ids.length > 0) {
                if (dry)
                    parts.push(`would uninstall plugin ${det.ids.join(", ")}`);
                else {
                    const m = await migrateFromPlugin(o.runner, det.ids, ctx.env);
                    if (m.failed.length > 0) {
                        states.push("warning");
                        parts.push(`could not uninstall ${m.failed.map((f) => `${f.id} (${f.error})`).join(", ")}; remove it manually to avoid duplicate hooks`);
                    }
                    else
                        parts.push(`uninstalled plugin ${m.uninstalled.join(", ")}`);
                    if (m.marketplace === "failed") {
                        states.push("warning");
                        parts.push(`marketplace not removed: ${m.marketplaceError}`);
                    }
                }
            }
            const dirs = pluginDataDir(o.homedir);
            if (dirs.length > 0) {
                if (dry)
                    parts.push(`would copy state from ${dirs.length} plugin data dir(s)`);
                else {
                    const copied = [];
                    try {
                        for (const d of dirs)
                            copied.push(...migratePluginState(d, ctx.paths.dataDir).copied);
                        if (copied.length > 0)
                            parts.push(`copied ${[...new Set(copied)].join(", ")}`);
                    }
                    catch (e) {
                        states.push("warning");
                        parts.push(`state copy failed: ${errMsg(e)}`);
                    }
                }
            }
            step("migrate", states.length > 0 ? worst(states) : parts.some((p) => p.startsWith("would") || p.startsWith("uninstalled") || p.startsWith("copied")) ? "ok" : "skipped", parts.length > 0 ? parts.join("; ") : "no plugin install found");
        }
        // 2. payload source
        let src;
        try {
            src = await resolveSource(o, ctx, dry, work);
        }
        catch (e) {
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
                }
                catch (e) {
                    step("install", "failed", errMsg(e));
                    stoppedBy = "install";
                }
            }
            else
                step("install", "ok", `would stage v${src.version} (${selection.profile}) and install its files`);
        }
        else {
            try {
                const r = runInstall({ paths: ctx.paths, sourceRoot: src.root, version: src.version, selection });
                const notes = [...r.conflicts.map((c) => `kept ${c}`), ...r.warnings];
                step("install", notes.length > 0 ? "warning" : "ok", `v${r.version} (${selection.profile}): ${r.written.length} files written${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`);
                if (src.bundle) {
                    atomicWriteFile(join(ctx.paths.oddHome, "bin", BUNDLE_ASSET), readFileSync(src.bundle), 0o755);
                }
            }
            catch (e) {
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
        }
        else {
            try {
                const r = installHooks({ ...ctx.managed, oddRoot: ctx.oddRoot, oddHome: ctx.paths.oddHome, defaultOddHome: ctx.defaultOddHome });
                step("hooks", r.status === "error" ? "failed" : "ok", r.status === "error" ? r.error ?? "hooks failed" : r.status === "unchanged" ? "hooks already registered" : "hooks registered");
            }
            catch (e) {
                step("hooks", "failed", errMsg(e));
            }
        }
        // 5. output style
        if (dry)
            step("output-style", "ok", 'would set outputStyle to "odd" (previous value is restored on uninstall)');
        else {
            try {
                const r = installOutputStyle(ctx.managed);
                step("output-style", r.status === "error" ? "failed" : "ok", r.status === "error" ? r.error ?? "output style failed" : r.status === "unchanged" ? 'outputStyle already "odd"' : 'outputStyle set to "odd"');
            }
            catch (e) {
                step("output-style", "failed", errMsg(e));
            }
        }
        // 6. MCP
        try {
            if (dry) {
                const p = await planMcp({ runner: o.runner, env: ctx.env, oddRoot: ctx.oddRoot });
                const add = p.servers.filter((s) => s.action === "add").map((s) => s.name);
                const unknown = p.servers.filter((s) => s.action === "unknown");
                step("mcp", unknown.length > 0 ? "warning" : "ok", `would register ${add.join(", ") || "nothing"}${unknown.length > 0 ? `; ${unknown[0].detail}` : ""}`);
            }
            else {
                const { results } = await applyMcp({ runner: o.runner, env: ctx.env, oddRoot: ctx.oddRoot, statePath: ctx.managed.statePath, dataDir: ctx.paths.dataDir });
                const bad = results.filter((r) => r.status === "failed" || r.status === "unknown");
                step("mcp", bad.length > 0 ? "warning" : "ok", results.map((r) => `${r.name}: ${r.status}${r.status === "failed" || r.status === "unknown" ? ` (${r.detail})` : ""}`).join(", "));
            }
        }
        catch (e) {
            step("mcp", "failed", errMsg(e));
        }
        // 7. extras
        try {
            if (dry) {
                const p = await planExtras({ oddRoot: ctx.oddRoot, options: extras, runner: o.runner, env: ctx.env });
                step("extras", p.warnings.length > 0 ? "warning" : "ok", `would change ${p.changes.length} settings${p.warnings.length > 0 ? `; ${p.warnings.join("; ")}` : ""}`);
            }
            else {
                const r = await applyExtras({ oddRoot: ctx.oddRoot, options: extras, runner: o.runner, env: ctx.env, paths: ctx.managed });
                if (r.settings?.status === "error")
                    step("extras", "failed", r.settings.error ?? "settings write failed");
                else {
                    saveExtras(ctx.managed.statePath, extras);
                    step("extras", r.warnings.length > 0 ? "warning" : "ok", `${r.settings?.changed.length ?? 0} settings changed${r.warnings.length > 0 ? `; ${r.warnings.join("; ")}` : ""}`);
                }
            }
        }
        catch (e) {
            step("extras", "failed", errMsg(e));
        }
        // 8. dependencies
        if (o.deps === false)
            step("deps", "skipped", "disabled (--no-deps)");
        else {
            try {
                if (dry) {
                    const acts = planDeps(await detectDeps(o.runner, ctx.env));
                    step("deps", acts.some((a) => a.status === "manual") ? "warning" : "ok", acts.map((a) => `${a.name}: ${a.status === "install" ? "would install" : a.status}`).join(", "));
                }
                else {
                    const rs = await installDeps(o.runner, { confirm: o.confirmDep ?? (() => false), env: ctx.env });
                    const st = rs.some((r) => r.status === "failed" || r.status === "manual") ? "warning" : rs.every((r) => r.status === "declined" || r.status === "skipped") && rs.some((r) => r.status === "declined") ? "skipped" : "ok";
                    step("deps", st, rs.map((r) => `${r.name}: ${r.status}${r.status === "failed" || r.status === "manual" ? ` (${r.detail})` : ""}`).join(", "));
                }
            }
            catch (e) {
                step("deps", "failed", errMsg(e));
            }
        }
        return { ok: !steps.some((s) => s.status === "failed"), dryRun: dry, version, steps, plan, summary: plan ? summarizePlan(plan) : undefined };
    }
    finally {
        if (work.dir)
            rmSync(work.dir, { recursive: true, force: true });
    }
}
/** Dry run: the steps that would run and the file-level plan. Writes nothing. */
export function planFullInstall(o) {
    return runFullInstall({ ...o, dryRun: true });
}
const UNINSTALL_STEPS = [
    ["extras", "Restore status line, claude.ai sync, builtin plugins"],
    ["mcp", "Remove MCP servers odd-claude added"],
    ["output-style", "Restore the previous output style"],
    ["hooks", "Remove odd hooks from settings.json"],
    ["files", "Remove installed files"],
];
/** Reverse of the install order. Never uninstalls Engram or codegraph. */
export async function runFullUninstall(o, onStep) {
    const ctx = flowContext(o);
    const dry = o.dryRun === true;
    const { steps, emit } = reporter(onStep);
    const step = (id, status, detail) => void emit(id, UNINSTALL_STEPS.find(([i]) => i === id)[1], status, detail);
    const guard = async (id, fn) => {
        try {
            const [s, d] = await fn();
            step(id, s, d);
        }
        catch (e) {
            step(id, "failed", errMsg(e));
        }
    };
    const restoreNote = (r) => r.status === "error" ? ["failed", r.error ?? "settings write failed"] : [r.kept.length > 0 ? "warning" : "ok", `${r.restored.length} restored${r.kept.length > 0 ? `; ${r.kept.map((k) => k.reason).join("; ")}` : ""}`];
    const state = readOddState(ctx.managed.statePath);
    await guard("extras", () => {
        if (dry)
            return ["ok", `would restore ${Object.values(state.settings ?? {}).filter((s) => ["statusLine", "disableClaudeAiConnectors", "syncClaudeAiSkills", "syncClaudeAiPlugins", "enabledPlugins"].includes(s.path[0])).length} settings`];
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
        if (dry)
            return ["ok", recorded.length > 0 ? `would remove ${recorded.join(", ")}` : "no servers recorded"];
        const { results } = await removeMcp({ runner: o.runner, env: ctx.env, statePath: ctx.managed.statePath });
        return [results.some((r) => r.status === "failed") ? "warning" : "ok", results.length > 0 ? results.map((r) => `${r.name}: ${r.status}${r.status === "failed" ? ` (${r.detail})` : ""}`).join(", ") : "no servers recorded"];
    });
    await guard("output-style", () => (dry ? ["ok", "would restore the previous outputStyle"] : restoreNote(uninstallOutputStyle(ctx.managed))));
    await guard("hooks", () => {
        if (dry)
            return ["ok", "would remove odd hook entries (foreign hooks stay)"];
        const r = uninstallHooks({ ...ctx.managed, oddRoot: ctx.oddRoot });
        return [r.status === "error" ? "failed" : "ok", r.status === "error" ? r.error ?? "hooks failed" : r.status === "unchanged" ? "no odd hooks found" : "odd hooks removed"];
    });
    let plan;
    await guard("files", () => {
        plan = uninstallPlan({ paths: ctx.paths, purge: o.purge });
        if (dry)
            return ["ok", `would remove ${plan.actions.filter((a) => a.area === "file" && a.action === "remove").length} files${o.purge ? " and purge data and backups" : "; data and backups are kept"}`];
        const r = runUninstall({ paths: ctx.paths, purge: o.purge });
        if (o.purge) {
            rmSync(ctx.managed.statePath, { force: true });
            rmSync(join(ctx.paths.oddHome, "bin"), { recursive: true, force: true });
            try {
                rmdirSync(ctx.paths.oddHome);
            }
            catch {
                /* not empty: leave it */
            }
        }
        return [r.kept.length > 0 ? "warning" : "ok", `${r.removed.length} files removed${r.kept.length > 0 ? `; kept edited files: ${r.kept.join(", ")}` : ""}${o.purge ? "; data and backups purged" : ""}`];
    });
    return { ok: !steps.some((s) => s.status === "failed"), dryRun: dry, version: null, steps, summary: plan ? summarizePlan(plan) : undefined };
}
/** runUpdate, then re-applies hooks, MCP and extras idempotently with the options saved at install. */
export async function runUpdateFlow(o, onStep) {
    const ctx = flowContext(o);
    const { steps, emit } = reporter(onStep);
    const selection = o.selection ?? readSelection(ctx.paths.dataDir);
    let u;
    try {
        u = await runUpdate({ runner: o.runner, env: o.env, paths: ctx.paths, selection, force: o.force, dryRun: o.dryRun, now: o.now });
    }
    catch (e) {
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
    const reapply = await reapplyIntegrations(o, ctx, emit);
    return { ...base, ok: !reapply.some((s) => s.status === "failed"), steps };
}
async function reapplyIntegrations(o, ctx, emit) {
    const out = [];
    const add = (id, status, detail) => void out.push(emit(id, label(id), status, detail));
    try {
        const h = installHooks({ ...ctx.managed, oddRoot: ctx.oddRoot, oddHome: ctx.paths.oddHome, defaultOddHome: ctx.defaultOddHome });
        add("hooks", h.status === "error" ? "failed" : "ok", h.status === "error" ? h.error ?? "hooks failed" : "hooks refreshed");
    }
    catch (e) {
        add("hooks", "failed", errMsg(e));
    }
    try {
        const { results } = await applyMcp({ runner: o.runner, env: ctx.env, oddRoot: ctx.oddRoot, statePath: ctx.managed.statePath, dataDir: ctx.paths.dataDir });
        add("mcp", results.some((r) => r.status === "failed" || r.status === "unknown") ? "warning" : "ok", results.map((r) => `${r.name}: ${r.status}`).join(", "));
    }
    catch (e) {
        add("mcp", "failed", errMsg(e));
    }
    try {
        const r = await applyExtras({ oddRoot: ctx.oddRoot, options: savedExtras(ctx.managed.statePath), runner: o.runner, env: ctx.env, paths: ctx.managed });
        add("extras", r.settings?.status === "error" ? "failed" : r.warnings.length > 0 ? "warning" : "ok", r.settings?.status === "error" ? r.settings.error ?? "settings write failed" : `${r.settings?.changed.length ?? 0} settings changed`);
    }
    catch (e) {
        add("extras", "failed", errMsg(e));
    }
    return out;
}
export function runRollback(o, onStep) {
    const ctx = flowContext(o);
    const { steps, emit } = reporter(onStep);
    const r = rollback({ paths: ctx.paths, selection: o.selection ?? readSelection(ctx.paths.dataDir), to: o.to });
    const lbl = "Roll back to the previous version";
    if (r.ok)
        emit("rollback", lbl, r.warnings && r.warnings.length > 0 ? "warning" : "ok", `${r.from ?? "none"} -> ${r.to}`);
    else
        emit("rollback", lbl, "failed", r.error ?? "rollback failed");
    return { ok: r.ok, dryRun: false, version: r.to ?? r.from, steps, rollback: r };
}
/** "Configure models": re-installs agent files and profile state for the installed version from its staged payload. */
export function applyModels(o, onStep) {
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
    }
    catch (e) {
        emit("models", lbl, "failed", errMsg(e));
        return { ok: false, dryRun: false, version, steps };
    }
}
export function backupsOf(o) {
    return listBackups(flowContext(o).paths);
}
export function restoreBackupFlow(o, onStep) {
    const { steps, emit } = reporter(onStep);
    try {
        const files = restoreBackup(flowContext(o).paths, o.id);
        emit("restore", "Restore backup", "ok", `${files.length} files restored from ${o.id}`);
        return { ok: true, dryRun: false, version: null, steps };
    }
    catch (e) {
        emit("restore", "Restore backup", "failed", errMsg(e));
        return { ok: false, dryRun: false, version: null, steps };
    }
}
