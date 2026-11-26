// Install and uninstall of the files under the Claude dir. The ledger (manifest) decides ownership: a file is replaced
// or removed only when its current hash equals the hash recorded when we wrote it.
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { backupFiles } from "./backup.js";
import { CLAUDE_MD, applyBlocks, parseBlocks, planBlocks, readDesiredBlocks } from "./claude-md.js";
import { atomicWriteFile, readManifest, sha256, writeManifest } from "./manifest.js";
import { agentFileForRole, applyAgentModel, roleCoverage } from "./models.js";
import { activeVersion, readTree } from "./payload.js";
import { resolvePlaceholders } from "./placeholders.js";
const fileHash = (p) => {
    try {
        return lstatSync(p).isFile() ? sha256(readFileSync(p)) : null;
    }
    catch {
        return null;
    }
};
/** Text of CLAUDE.md, null when absent; `special` when something other than a regular file sits there. */
function readClaudeMd(target) {
    try {
        if (!lstatSync(target).isFile())
            return { text: null, special: true };
        return { text: readFileSync(target, "utf8"), special: false };
    }
    catch {
        return { text: null, special: false };
    }
}
/** Rel names a block in results and plans: `CLAUDE.md#<id>`. */
export const blockRel = (id) => `${CLAUDE_MD}#${id}`;
const safeRel = (rel) => rel !== "" && !rel.startsWith("/") && !rel.split("/").includes("..");
/** Removes now-empty parents of `file`, stopping at (excluding) the Claude dir. */
function pruneEmptyDirs(claudeDir, file) {
    for (let d = dirname(file); d.startsWith(claudeDir + "/") && d !== claudeDir; d = dirname(d)) {
        try {
            if (readdirSync(d).length > 0)
                return;
            rmdirSync(d);
        }
        catch {
            return;
        }
    }
}
/** Desired files, from `payloadDir` (default: the `current` link), keyed by Claude-dir-relative path. */
function desiredFiles(paths, selection, payloadDir) {
    const resolveText = (t) => resolvePlaceholders(t, { root: paths.currentLink, data: paths.dataDir });
    const resolve = (b) => Buffer.from(resolveText(b.toString("utf8")));
    const files = new Map();
    const agentFiles = [];
    const dir = (name) => join(payloadDir, name);
    if (existsSync(dir("skills")))
        for (const [rel, f] of readTree(dir("skills")))
            files.set(`skills/${rel}`, { data: resolve(f.data), mode: f.mode });
    if (existsSync(dir("rules")))
        for (const [rel, f] of readTree(dir("rules")))
            if (rel.split("/").at(-1) !== ".gitkeep")
                files.set(`rules/${rel}`, { data: resolve(f.data), mode: f.mode });
    if (existsSync(dir("agents"))) {
        for (const [rel, f] of readTree(dir("agents"))) {
            if (rel.includes("/") || !rel.endsWith(".md"))
                continue;
            agentFiles.push(rel);
            const role = rel.slice(0, -3);
            let text = resolve(f.data).toString("utf8");
            const model = selection.roles[role];
            if (model !== undefined && rel === agentFileForRole(role))
                text = applyAgentModel(text, model);
            files.set(`agents/${rel}`, { data: Buffer.from(text), mode: f.mode });
        }
    }
    const style = join(dir("output-styles"), "odd.md");
    if (existsSync(style)) {
        const t = readTree(dir("output-styles")).get("odd.md");
        if (t)
            files.set("output-styles/odd.md", { data: resolve(t.data), mode: t.mode });
    }
    return { files, agentFiles, blocks: readDesiredBlocks(payloadDir, resolveText) };
}
export function planInstallFiles(paths, selection, opts = {}) {
    const manifest = readManifest(paths.manifestPath);
    const owned = manifest?.files ?? {};
    const { files, agentFiles, blocks: desired } = desiredFiles(paths, selection, opts.payloadDir ?? paths.currentLink);
    const coverage = roleCoverage(agentFiles);
    const warnings = [
        ...coverage.rolesWithoutAgentFile.filter((r) => !r.startsWith("review-")).map((r) => `no agent file for role ${r}`),
        ...coverage.unroutedAgentFiles.map((f) => `agent file ${f} has no model role`),
    ];
    const actions = [];
    for (const [rel, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        const target = join(paths.claudeDir, ...rel.split("/"));
        const want = sha256(f.data);
        const cur = fileHash(target);
        const base = { rel, target, content: f.data, mode: f.mode };
        if (cur === null && existsSync(target))
            actions.push({ ...base, action: "conflict", reason: "target exists and is not a regular file" });
        else if (cur === null)
            actions.push({ ...base, action: "create" });
        else if (cur === want)
            actions.push({ ...base, action: "unchanged" });
        else if (owned[rel] === undefined)
            actions.push({ ...base, action: "conflict", reason: "file exists and was not installed by odd-claude" });
        else if (cur === owned[rel])
            actions.push({ ...base, action: "update" });
        else
            actions.push({ ...base, action: "conflict", reason: "file was edited since odd-claude installed it" });
    }
    for (const [rel, hash] of Object.entries(owned).sort(([a], [b]) => a.localeCompare(b))) {
        if (files.has(rel) || !safeRel(rel))
            continue;
        const target = join(paths.claudeDir, ...rel.split("/"));
        const cur = fileHash(target);
        if (cur === null)
            continue;
        actions.push(cur === hash ? { action: "remove", rel, target } : { action: "conflict", rel, target, reason: "no longer shipped but edited since install; kept" });
    }
    const claudeMd = join(paths.claudeDir, CLAUDE_MD);
    const md = readClaudeMd(claudeMd);
    const blocks = md.special
        ? [...desired.map((d) => ({ action: "conflict", id: d.id, text: d.text })), ...Object.keys(manifest?.blocks ?? {}).filter((id) => !desired.some((d) => d.id === id)).map((id) => ({ action: "conflict", id }))].map((a) => ({ ...a, reason: "CLAUDE.md exists and is not a regular file" }))
        : planBlocks(md.text, desired, manifest?.blocks ?? {});
    const malformed = blocks.find((b) => b.reason?.startsWith("CLAUDE.md has malformed odd-claude markers"));
    if (malformed)
        warnings.push(malformed.reason);
    return { actions, warnings, selection, oddVersion: opts.oddVersion ?? activeVersion(paths) ?? "unknown", coverage, blocks, claudeMd };
}
/** Backs up what it overwrites or removes, writes create/update, skips conflicts, then rewrites the ledger. */
export function applyInstallFiles(paths, plan) {
    const prev = readManifest(paths.manifestPath);
    const touched = plan.actions.filter((a) => a.action === "update" || a.action === "remove").map((a) => a.target);
    const mdChanges = plan.blocks.some((b) => b.action === "create" || b.action === "update" || b.action === "remove");
    if (mdChanges)
        touched.push(plan.claudeMd);
    const backupDir = backupFiles(paths, touched);
    const files = {};
    const result = { backupDir, written: [], conflicts: [], removed: [] };
    for (const a of plan.actions) {
        if (a.action === "create" || a.action === "update") {
            atomicWriteFile(a.target, a.content, a.mode || 0o644);
            result.written.push(a.rel);
            files[a.rel] = sha256(a.content);
        }
        else if (a.action === "unchanged") {
            files[a.rel] = sha256(a.content);
        }
        else if (a.action === "remove") {
            rmSync(a.target, { force: true });
            pruneEmptyDirs(paths.claudeDir, a.target);
            result.removed.push(a.rel);
        }
        else {
            result.conflicts.push(a.rel);
            const old = prev?.files[a.rel];
            if (old !== undefined)
                files[a.rel] = old;
        }
    }
    const blocks = {};
    if (mdChanges) {
        const cur = readClaudeMd(plan.claudeMd).text;
        const next = applyBlocks(cur, plan.blocks);
        if (next.trim() === "")
            rmSync(plan.claudeMd, { force: true });
        else
            atomicWriteFile(plan.claudeMd, next, 0o644);
    }
    for (const b of plan.blocks) {
        if (b.action === "create" || b.action === "update") {
            result.written.push(blockRel(b.id));
            blocks[b.id] = sha256(b.text);
        }
        else if (b.action === "unchanged")
            blocks[b.id] = sha256(b.text);
        else if (b.action === "remove")
            result.removed.push(blockRel(b.id));
        else {
            result.conflicts.push(blockRel(b.id));
            const old = prev?.blocks?.[b.id];
            if (old !== undefined)
                blocks[b.id] = old;
        }
    }
    const manifest = { version: 1, oddVersion: plan.oddVersion, installedAt: new Date().toISOString(), files, ...(Object.keys(blocks).length > 0 ? { blocks } : {}), models: plan.selection };
    writeManifest(paths.manifestPath, manifest);
    return result;
}
export function planUninstallFiles(paths) {
    const manifest = readManifest(paths.manifestPath);
    const actions = [];
    for (const [rel, hash] of Object.entries(manifest?.files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (!safeRel(rel))
            continue;
        const target = join(paths.claudeDir, ...posix.normalize(rel).split("/"));
        const cur = fileHash(target);
        if (cur === null)
            actions.push({ action: "missing", rel, target });
        else if (cur === hash)
            actions.push({ action: "remove", rel, target });
        else
            actions.push({ action: "keep", rel, target, reason: "file was edited since odd-claude installed it" });
    }
    const claudeMd = join(paths.claudeDir, CLAUDE_MD);
    const owned = Object.entries(manifest?.blocks ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (owned.length > 0) {
        const md = readClaudeMd(claudeMd);
        const parsed = parseBlocks(md.text ?? "");
        for (const [id, hash] of owned) {
            const rel = blockRel(id);
            const cur = parsed.blocks.get(id);
            if (md.special)
                actions.push({ action: "keep", rel, target: claudeMd, reason: "CLAUDE.md is not a regular file" });
            else if (parsed.malformed)
                actions.push({ action: "keep", rel, target: claudeMd, reason: `CLAUDE.md has malformed odd-claude markers (${parsed.malformed})` });
            else if (!cur)
                actions.push({ action: "missing", rel, target: claudeMd });
            else if (cur.hash === hash)
                actions.push({ action: "remove", rel, target: claudeMd });
            else
                actions.push({ action: "keep", rel, target: claudeMd, reason: "block was edited since odd-claude installed it" });
        }
    }
    return { actions };
}
/** Removes hash-matching manifest files and the dirs they leave empty, `current` and `versions/`; `data/` and `backups/` only with `purge`. */
export function applyUninstallFiles(paths, opts = {}) {
    const manifest = readManifest(paths.manifestPath);
    const plan = planUninstallFiles(paths);
    const result = { removed: [], kept: [] };
    const left = {};
    const leftBlocks = {};
    const mdRemovals = plan.actions.filter((a) => a.rel.startsWith(`${CLAUDE_MD}#`) && a.action === "remove");
    if (mdRemovals.length > 0) {
        const target = join(paths.claudeDir, CLAUDE_MD);
        backupFiles(paths, [target]);
        const next = applyBlocks(readClaudeMd(target).text, mdRemovals.map((a) => ({ action: "remove", id: a.rel.slice(CLAUDE_MD.length + 1) })));
        if (next.trim() === "")
            rmSync(target, { force: true });
        else
            atomicWriteFile(target, next, 0o644);
    }
    for (const a of plan.actions) {
        if (a.rel.startsWith(`${CLAUDE_MD}#`)) {
            const id = a.rel.slice(CLAUDE_MD.length + 1);
            if (a.action === "remove")
                result.removed.push(a.rel);
            else if (a.action === "keep") {
                result.kept.push(a.rel);
                leftBlocks[id] = manifest.blocks[id];
            }
        }
        else if (a.action === "remove") {
            rmSync(a.target, { force: true });
            pruneEmptyDirs(paths.claudeDir, a.target);
            result.removed.push(a.rel);
        }
        else if (a.action === "keep") {
            result.kept.push(a.rel);
            left[a.rel] = manifest.files[a.rel];
        }
    }
    rmSync(paths.currentLink, { force: true });
    rmSync(paths.versionsDir, { recursive: true, force: true });
    if (result.kept.length > 0 && manifest) {
        const { blocks: _blocks, ...rest } = manifest;
        writeManifest(paths.manifestPath, { ...rest, files: left, ...(Object.keys(leftBlocks).length > 0 ? { blocks: leftBlocks } : {}) });
    }
    else
        rmSync(paths.manifestPath, { force: true });
    if (opts.purge) {
        rmSync(paths.dataDir, { recursive: true, force: true });
        rmSync(paths.backupsDir, { recursive: true, force: true });
        try {
            rmdirSync(paths.oddHome);
        }
        catch {
            // not empty (kept files still tracked, or user content): leave it
        }
    }
    return result;
}
