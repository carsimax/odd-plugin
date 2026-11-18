// Skill registry (R53): `.atl/skill-registry.md` indexes project + user + plugin skills by trigger and path.
// Semantics follow the upstream registry: index not summary, skip sdd-*/_shared/skill-registry,
// project > user > plugin on a name clash, empty registry when nothing is found, `.atl/.gitignore` with `*`,
// git-tracked targets preserved on automatic refresh (forced refresh overrides), opt-out env, home-directory guard.
// Cheap to re-run: a stat-only fingerprint of every SKILL.md short-circuits before any skill file is read.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, parse } from "node:path";
import { atomicWriteFile } from "./state.js";
export const REGISTRY_REL_PATH = ".atl/skill-registry.md";
export const CACHE_REL_PATH = ".atl/.skill-registry.cache.json";
export const NO_REGISTRY_ENV = "ODD_CLAUDE_NO_SKILL_REGISTRY";
const EXCLUDE_NAMES = new Set(["_shared", "skill-registry"]);
const EXCLUDE_PREFIXES = ["sdd-"];
export function parseFrontmatter(source) {
    const text = source.replace(/\r\n?/g, "\n");
    if (!text.startsWith("---\n"))
        return {};
    const end = text.indexOf("\n---", 4);
    if (end === -1)
        return {};
    const lines = text.slice(4, end).split("\n");
    const out = {};
    for (let i = 0; i < lines.length; i++) {
        const m = /^([\w-]+):(.*)$/.exec(lines[i]);
        if (!m)
            continue;
        let value = m[2].trim();
        if ([">", ">-", "|", "|-"].includes(value)) {
            const block = [];
            while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]))
                block.push(lines[++i].trim());
            value = block.join(" ").trim();
        }
        else if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        if (m[1] === "name")
            out.name = value;
        else if (m[1] === "description")
            out.description = value;
        else if (m[1] === "disable-model-invocation")
            out.disableModelInvocation = value === "true";
    }
    return out;
}
function excluded(name) {
    const bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    return EXCLUDE_NAMES.has(bare) || EXCLUDE_PREFIXES.some((p) => bare.startsWith(p));
}
function projectDirs(cwd) {
    return ["skills", ".claude/skills", ".agents/skills", ".agent/skills", ".atl/skills", ".github/skills", ".cursor/skills", ".codex/skills", ".gemini/skills"].map((d) => join(cwd, d));
}
function userDirs(home) {
    return [".claude/skills", ".agents/skills", ".config/agents/skills"].map((d) => join(home, d));
}
/** SKILL.md files directly under `<root>/<dir>/` (dot-dirs and excluded names skipped), sorted. */
function skillFiles(root) {
    let names;
    try {
        names = readdirSync(root);
    }
    catch {
        return [];
    }
    const out = [];
    for (const n of names.sort()) {
        if (n.startsWith(".") || excluded(n))
            continue;
        const file = join(root, n, "SKILL.md");
        try {
            if (statSync(file).isFile())
                out.push(file);
        }
        catch {
            // not a skill dir
        }
    }
    return out;
}
function locate(deps) {
    const located = [];
    const sources = [];
    const seen = new Set();
    const add = (dir, scope, prefix, label) => {
        const abs = resolve(dir);
        if (seen.has(abs))
            return;
        seen.add(abs);
        const files = skillFiles(abs);
        try {
            if (!statSync(abs).isDirectory())
                return;
        }
        catch {
            return;
        }
        sources.push(label);
        for (const file of files)
            located.push({ file, scope, prefix });
    };
    for (const d of projectDirs(deps.cwd))
        add(d, "project", "", d.slice(deps.cwd.length + 1));
    for (const d of userDirs(deps.home))
        add(d, "user", "", `~/${d.slice(deps.home.length + 1)}`);
    for (const p of deps.plugins)
        add(join(p.root, "skills"), "plugin", `${p.name}:`, `plugin ${p.name}`);
    return { located, sources };
}
function fingerprint(located) {
    const h = createHash("sha256");
    for (const l of located) {
        try {
            const s = statSync(l.file);
            h.update(`${l.scope}|${l.prefix}|${l.file}|${s.mtimeMs}|${s.size}\n`);
        }
        catch {
            h.update(`${l.file}|gone\n`);
        }
    }
    return h.digest("hex");
}
const rank = { project: 0, user: 1, plugin: 2 };
function load(located) {
    const entries = [];
    for (const l of located) {
        let fm;
        try {
            fm = parseFrontmatter(readFileSync(l.file, "utf8"));
        }
        catch {
            continue;
        }
        if (fm.disableModelInvocation)
            continue;
        const bare = fm.name || basename(dirname(l.file));
        const name = `${l.prefix}${bare}`;
        if (excluded(name))
            continue;
        entries.push({ name, path: l.file, description: (fm.description ?? "").replace(/\s+/g, " ").trim(), scope: l.scope });
    }
    // First entry wins per name after ordering project > user > plugin (stable within a scope).
    const ordered = entries.map((e, i) => ({ e, i })).sort((a, b) => rank[a.e.scope] - rank[b.e.scope] || a.i - b.i);
    const byName = new Map();
    for (const { e } of ordered)
        if (!byName.has(e.name))
            byName.set(e.name, e);
    return [...byName.values()].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}
export function scanSkills(deps) {
    const { located, sources } = locate(deps);
    return { sources, entries: load(located) };
}
function cell(v) {
    const t = v.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
    return t === "" ? "—" : t;
}
export function renderRegistry(cwd, sources, entries) {
    return [
        `# Skill Registry — ${basename(cwd)}`, "",
        "<!-- Disk skill registry generated by odd-claude. -->", "",
        "## Sources scanned", "", ...sources.map((s) => `- ${s}`), "",
        "## Contract", "",
        "**Delegator use only.** This disk index is not a summary. In Claude Code the session's own skill list is the effective view; use these rows for exact paths. Pass exact `SKILL.md` paths to subagents.", "",
        "`SKILL.md` remains the source of truth. Do not inject generated summaries or compact rules by default; pass paths so subagents load the full contract and preserve author intent.", "",
        "## Skills", "", "| Skill | Trigger / description | Scope | Path |", "| --- | --- | --- | --- |",
        ...entries.map((e) => `| \`${cell(e.name)}\` | ${cell(e.description)} | ${e.scope} | \`${cell(e.path)}\` |`),
        "", "## Loading protocol", "",
        "1. Match task context and target files against the `Trigger / description` column.",
        "2. Pass only the matching `Path` values to the subagent under `## Skills to load before work`.",
        "3. Instruct the subagent to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.",
        "4. If no matching skill exists, proceed without skill injection and report `skill_resolution: none`.", "",
    ].join("\n");
}
function truthy(v) {
    return v === "1" || v === "true" || v === "yes" || v === "on";
}
function readOptional(path) {
    try {
        return readFileSync(path);
    }
    catch {
        return undefined;
    }
}
function ensureAtlIgnored(cwd) {
    const dir = join(cwd, ".atl");
    const file = join(dir, ".gitignore");
    const existing = readOptional(file)?.toString("utf8");
    if (existing === undefined) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, "*\n");
        return;
    }
    const rules = existing.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
    if (rules.at(-1) === "*")
        return;
    writeFileSync(file, `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}*\n`);
}
export function refreshRegistry(deps) {
    const cwd = resolve(deps.cwd);
    const registryPath = join(cwd, REGISTRY_REL_PATH);
    const skip = (reason, warning) => ({ status: "skipped", reason, skillCount: 0, registryPath, ...(warning ? { warning } : {}) });
    if (!deps.force && truthy(deps.env[NO_REGISTRY_ENV]))
        return skip("opt-out");
    if (cwd === resolve(deps.home) || cwd === parse(cwd).root)
        return skip("home-or-broad-directory");
    if (!existsSync(cwd))
        return skip("no-cwd");
    const force = deps.force === true;
    if (!force) {
        let tracked;
        try {
            tracked = deps.gitTracked(cwd, [REGISTRY_REL_PATH, CACHE_REL_PATH, ".atl/.gitignore"]);
        }
        catch {
            return skip("git-unavailable", "Skill registry automatic writes skipped: cannot verify Git tracking. Run the refresh command deliberately.");
        }
        if (tracked.length > 0) {
            return skip("tracked-target", `Skill registry automatic writes skipped for tracked targets: ${tracked.join(", ")}.`);
        }
    }
    const { located, sources } = locate({ cwd, home: deps.home, plugins: deps.plugins });
    const fp = fingerprint(located);
    const cachePath = join(cwd, CACHE_REL_PATH);
    const registryBytes = readOptional(registryPath);
    let cache = {};
    try {
        cache = JSON.parse(readOptional(cachePath)?.toString("utf8") ?? "{}");
    }
    catch {
        // corrupt cache: rebuild
    }
    const sha = (b) => createHash("sha256").update(b).digest("hex");
    if (!force && registryBytes && cache.fingerprint === fp && cache.registry_sha256 === sha(registryBytes)) {
        return { status: "unchanged", reason: "fingerprint-unchanged", skillCount: countRows(registryBytes.toString("utf8")), registryPath };
    }
    const entries = load(located);
    const md = renderRegistry(cwd, sources, entries);
    const newCache = `${JSON.stringify({ schema: 1, fingerprint: fp, registry_sha256: sha(md) })}\n`;
    const registryChanged = !registryBytes?.equals(Buffer.from(md));
    const cacheChanged = readOptional(cachePath)?.toString("utf8") !== newCache;
    try {
        if (registryChanged || cacheChanged) {
            ensureAtlIgnored(cwd);
            if (registryChanged)
                atomicWriteFile(registryPath, md);
            if (cacheChanged)
                atomicWriteFile(cachePath, newCache);
        }
    }
    catch (err) {
        const code = err.code;
        if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOTDIR" || code === "EISDIR" || code === "EEXIST") {
            return skip("storage-unavailable", `Skill registry is unavailable: ${REGISTRY_REL_PATH} is not writable (${code}).`);
        }
        throw err;
    }
    return {
        status: registryChanged ? "written" : "unchanged",
        reason: registryChanged ? (force ? "forced" : "fingerprint-changed") : "bytes-identical",
        skillCount: entries.length,
        registryPath,
    };
}
/** Cheap read of an existing registry (no scan, no git): path and row count, or undefined when absent. */
export function peekRegistry(cwd) {
    const registryPath = join(resolve(cwd), REGISTRY_REL_PATH);
    const bytes = readOptional(registryPath);
    return bytes ? { registryPath, skillCount: countRows(bytes.toString("utf8")) } : undefined;
}
function countRows(md) {
    return md.split("\n").filter((l) => /^\| `/.test(l)).length;
}
/** Git-tracked subset of targets; [] outside a git repository; throws when git cannot answer. */
export function realGitTracked(cwd, targets) {
    try {
        const out = execFileSync("git", ["ls-files", "--cached", "-z", "--", ...targets], {
            cwd,
            encoding: "utf8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, LC_ALL: "C" },
        });
        return out.split("\0").filter(Boolean);
    }
    catch (err) {
        const stderr = String(err.stderr ?? "");
        if (/not a git repository/.test(stderr))
            return [];
        throw err;
    }
}
/** Plugins whose skills are indexed: this plugin (CLAUDE_PLUGIN_ROOT) plus installed plugins. Fail-safe. */
export function realPluginRoots(env, home) {
    const out = [];
    const own = env.CLAUDE_PLUGIN_ROOT;
    if (own)
        out.push({ name: pluginName(own) ?? "odd-claude", root: own });
    try {
        const raw = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"));
        for (const [key, installs] of Object.entries(raw.plugins ?? {})) {
            const root = installs?.[0]?.installPath;
            if (typeof root !== "string" || resolve(root) === (own ? resolve(own) : ""))
                continue;
            out.push({ name: key.split("@")[0], root });
        }
    }
    catch {
        // no installed plugins file
    }
    return out;
}
function pluginName(root) {
    try {
        const n = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name;
        return typeof n === "string" && n !== "" ? n : undefined;
    }
    catch {
        return undefined;
    }
}
