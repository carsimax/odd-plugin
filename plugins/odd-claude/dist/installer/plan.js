// Install/uninstall as a serializable list of actions (for --dry-run, nothing is written) plus the runners that execute them.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyInstallFiles, applyUninstallFiles, planInstallFiles, planUninstallFiles } from "./files.js";
import { readSelection, writeProfileState } from "./models.js";
import { activeVersion, payloadWouldChange, stagePayload } from "./payload.js";
const profilesFile = (paths) => join(paths.dataDir, "profiles.json");
function profileUnchanged(paths, selection) {
    if (!existsSync(profilesFile(paths)))
        return false;
    const cur = readSelection(paths.dataDir);
    return cur.profile === selection.profile && Object.entries(selection.roles).every(([r, m]) => cur.roles[r] === m);
}
/** Pure: reads the source and the current install, writes nothing. */
export function installPlan(opts) {
    const { paths, sourceRoot, version, selection } = opts;
    const files = planInstallFiles(paths, selection, { payloadDir: sourceRoot, oddVersion: version });
    const versionDir = join(paths.versionsDir, version);
    const actions = [
        { area: "payload", action: !existsSync(versionDir) ? "create" : payloadWouldChange(sourceRoot, paths, version) ? "update" : "unchanged", path: versionDir },
        { area: "payload", action: activeVersion(paths) === version ? "unchanged" : existsSync(paths.currentLink) ? "update" : "create", path: paths.currentLink, detail: `-> versions/${version}` },
        ...files.actions.map((a) => ({ area: "file", action: a.action, path: a.target, ...(a.reason ? { detail: a.reason } : {}) })),
        ...files.blocks.map((b) => ({ area: "file", action: b.action, path: `${files.claudeMd}#${b.id}`, ...(b.reason ? { detail: b.reason } : {}) })),
        { area: "profile", action: profileUnchanged(paths, selection) ? "unchanged" : existsSync(profilesFile(paths)) ? "update" : "create", path: profilesFile(paths), detail: selection.profile },
        { area: "manifest", action: existsSync(paths.manifestPath) ? "update" : "create", path: paths.manifestPath },
    ];
    return { version, actions, warnings: files.warnings, files };
}
export function uninstallPlan(opts) {
    const { paths, purge } = opts;
    const files = planUninstallFiles(paths);
    const actions = [
        ...files.actions
            .filter((a) => a.action !== "missing")
            .map((a) => ({ area: "file", action: a.action === "remove" ? "remove" : "keep", path: a.rel.startsWith("CLAUDE.md#") ? `${a.target}${a.rel.slice("CLAUDE.md".length)}` : a.target, ...(a.reason ? { detail: a.reason } : {}) })),
        { area: "payload", action: "remove", path: paths.currentLink },
        { area: "payload", action: "remove", path: paths.versionsDir },
        { area: "manifest", action: files.actions.some((a) => a.action === "keep") ? "update" : "remove", path: paths.manifestPath },
        { area: "data", action: purge ? "remove" : "keep", path: paths.dataDir },
        { area: "data", action: purge ? "remove" : "keep", path: paths.backupsDir },
    ];
    return { actions, files };
}
/** One line per area and action with counts, then conflicts and warnings. */
export function summarizePlan(plan) {
    const lines = [];
    for (const area of ["payload", "file", "profile", "manifest", "data"]) {
        const counts = new Map();
        for (const a of plan.actions.filter((x) => x.area === area))
            counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
        if (counts.size > 0)
            lines.push(`${area}: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}`);
    }
    for (const a of plan.actions.filter((x) => x.action === "conflict"))
        lines.push(`conflict: ${a.path} (${a.detail ?? "kept"})`);
    for (const w of plan.warnings ?? [])
        lines.push(`warning: ${w}`);
    return lines.join("\n");
}
/** Stages the payload, persists the model profile, then installs the files and the ledger. */
export function runInstall(opts) {
    const { paths, sourceRoot, version, selection } = opts;
    const staged = stagePayload(sourceRoot, paths, version);
    writeProfileState(paths.dataDir, selection);
    const plan = planInstallFiles(paths, selection, { oddVersion: version });
    return { ...applyInstallFiles(paths, plan), version, payloadChanged: staged.changed, warnings: plan.warnings };
}
export function runUninstall(opts) {
    return applyUninstallFiles(opts.paths, { purge: opts.purge ?? false });
}
