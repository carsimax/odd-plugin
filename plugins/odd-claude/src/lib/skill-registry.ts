// Skill registry (R53): `.atl/skill-registry.md` indexes project + user + plugin skills by trigger and path.
// Semantics follow the upstream registry: index not summary, skip sdd-*/_shared/skill-registry,
// project > user > plugin on a name clash, empty registry when nothing is found, `.atl/.gitignore` with `*`,
// git-tracked targets preserved on automatic refresh (forced refresh overrides), opt-out env, home-directory guard.
// Cheap to re-run: a stat-only fingerprint of every SKILL.md short-circuits before any skill file is read.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, parse } from "node:path";
import { truthy } from "./codegraph.js";
import { oddClaudeRoot } from "./root.js";
import { atomicWriteFile } from "./state.js";

export const REGISTRY_REL_PATH = ".atl/skill-registry.md";
export const CACHE_REL_PATH = ".atl/.skill-registry.cache.json";
export const NO_REGISTRY_ENV = "ODD_CLAUDE_NO_SKILL_REGISTRY";
const EXCLUDE_NAMES = new Set(["_shared", "skill-registry", "odd-skill-registry"]);
const EXCLUDE_PREFIXES = ["sdd-"];

export interface SkillEntry {
  name: string;
  path: string;
  description: string;
  scope: "project" | "user" | "plugin";
}

export interface PluginRoot {
  name: string;
  root: string;
}

export interface RefreshDeps {
  cwd: string;
  home: string;
  plugins: PluginRoot[];
  env: Record<string, string | undefined>;
  /** Git-tracked subset of `targets` (relative to cwd). May throw when git cannot answer. */
  gitTracked: (cwd: string, targets: string[]) => string[];
  /** Deliberate refresh: overrides the tracked-target guard and the opt-out is still honoured only when not forced. */
  force?: boolean;
}

export interface RefreshResult {
  status: "written" | "unchanged" | "skipped";
  reason: string;
  skillCount: number;
  registryPath: string;
  warning?: string;
}

export function parseFrontmatter(source: string): { name?: string; description?: string; disableModelInvocation?: boolean } {
  const text = source.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const lines = text.slice(4, end).split("\n");
  const out: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let value = m[2]!.trim();
    if ([">", ">-", "|", "|-"].includes(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(" ").trim();
    } else if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (m[1] === "name") out.name = value;
    else if (m[1] === "description") out.description = value;
    else if (m[1] === "disable-model-invocation") out.disableModelInvocation = value === "true";
  }
  return out;
}

function excluded(name: string): boolean {
  const bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  return EXCLUDE_NAMES.has(bare) || EXCLUDE_PREFIXES.some((p) => bare.startsWith(p));
}

function projectDirs(cwd: string): string[] {
  return ["skills", ".claude/skills", ".agents/skills", ".agent/skills", ".atl/skills", ".github/skills", ".cursor/skills", ".codex/skills", ".gemini/skills"].map((d) => join(cwd, d));
}

function userDirs(home: string): string[] {
  return [".claude/skills", ".agents/skills", ".config/agents/skills"].map((d) => join(home, d));
}

/** SKILL.md files directly under `<root>/<dir>/` (dot-dirs and excluded names skipped), sorted. */
function skillFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (n.startsWith(".") || excluded(n)) continue;
    const file = join(root, n, "SKILL.md");
    try {
      if (statSync(file).isFile()) out.push(file);
    } catch {
      // not a skill dir
    }
  }
  return out;
}

interface Located {
  file: string;
  scope: SkillEntry["scope"];
  prefix: string;
}

function locate(deps: Pick<RefreshDeps, "cwd" | "home" | "plugins">): { located: Located[]; sources: string[] } {
  const located: Located[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string, scope: SkillEntry["scope"], prefix: string, label: string): void => {
    const abs = resolve(dir);
    if (seen.has(abs)) return;
    seen.add(abs);
    const files = skillFiles(abs);
    try {
      if (!statSync(abs).isDirectory()) return;
    } catch {
      return;
    }
    sources.push(label);
    for (const file of files) located.push({ file, scope, prefix });
  };
  for (const d of projectDirs(deps.cwd)) add(d, "project", "", d.slice(deps.cwd.length + 1));
  for (const d of userDirs(deps.home)) add(d, "user", "", `~/${d.slice(deps.home.length + 1)}`);
  for (const p of deps.plugins) add(join(p.root, "skills"), "plugin", `${p.name}:`, `plugin ${p.name}`);
  return { located, sources };
}

function fingerprint(located: Located[]): string {
  const h = createHash("sha256");
  for (const l of located) {
    try {
      const s = statSync(l.file);
      h.update(`${l.scope}|${l.prefix}|${l.file}|${s.mtimeMs}|${s.size}\n`);
    } catch {
      h.update(`${l.file}|gone\n`);
    }
  }
  return h.digest("hex");
}

const rank = { project: 0, user: 1, plugin: 2 } as const;

function load(located: Located[]): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const l of located) {
    let fm;
    try {
      fm = parseFrontmatter(readFileSync(l.file, "utf8"));
    } catch {
      continue;
    }
    if (fm.disableModelInvocation) continue;
    const bare = fm.name || basename(dirname(l.file));
    const name = `${l.prefix}${bare}`;
    if (excluded(name)) continue;
    entries.push({ name, path: l.file, description: (fm.description ?? "").replace(/\s+/g, " ").trim(), scope: l.scope });
  }
  // First entry wins per name after ordering project > user > plugin (stable within a scope).
  const ordered = entries.map((e, i) => ({ e, i })).sort((a, b) => rank[a.e.scope] - rank[b.e.scope] || a.i - b.i);
  const byName = new Map<string, SkillEntry>();
  for (const { e } of ordered) if (!byName.has(e.name)) byName.set(e.name, e);
  return [...byName.values()].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}

export function scanSkills(deps: Pick<RefreshDeps, "cwd" | "home" | "plugins">): { sources: string[]; entries: SkillEntry[] } {
  const { located, sources } = locate(deps);
  return { sources, entries: load(located) };
}

function cell(v: string): string {
  const t = v.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
  return t === "" ? "—" : t;
}

export function renderRegistry(cwd: string, sources: string[], entries: SkillEntry[]): string {
  return [
    `# Skill Registry — ${basename(cwd)}`, "",
    "<!-- Disk skill registry generated by odd-claude. -->", "",
    "## Sources scanned", "", ...sources.map((s) => `- ${s}`), "",
    "Delegator use only: the session skill list is the effective view; pass matching exact `Path` values to subagents under `## Skills to load before work` (protocol: rule `odd-skills`).", "",
    "## Skills", "", "| Skill | Trigger / description | Scope | Path |", "| --- | --- | --- | --- |",
    ...entries.map((e) => `| \`${cell(e.name)}\` | ${cell(e.description)} | ${e.scope} | \`${cell(e.path)}\` |`),
    "",
  ].join("\n");
}

function readOptional(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function ensureAtlIgnored(cwd: string): void {
  const dir = join(cwd, ".atl");
  const file = join(dir, ".gitignore");
  const existing = readOptional(file)?.toString("utf8");
  if (existing === undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "*\n");
    return;
  }
  const rules = existing.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (rules.at(-1) === "*") return;
  writeFileSync(file, `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}*\n`);
}

export function refreshRegistry(deps: RefreshDeps): RefreshResult {
  const cwd = resolve(deps.cwd);
  const registryPath = join(cwd, REGISTRY_REL_PATH);
  const skip = (reason: string, warning?: string): RefreshResult => ({ status: "skipped", reason, skillCount: 0, registryPath, ...(warning ? { warning } : {}) });
  if (!deps.force && truthy(deps.env[NO_REGISTRY_ENV])) return skip("opt-out");
  if (cwd === resolve(deps.home) || cwd === parse(cwd).root) return skip("home-or-broad-directory");
  if (!existsSync(cwd)) return skip("no-cwd");

  const force = deps.force === true;
  if (!force) {
    let tracked: string[];
    try {
      tracked = deps.gitTracked(cwd, [REGISTRY_REL_PATH, CACHE_REL_PATH, ".atl/.gitignore"]);
    } catch {
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
  let cache: { fingerprint?: string; registry_sha256?: string } = {};
  try {
    cache = JSON.parse(readOptional(cachePath)?.toString("utf8") ?? "{}") as typeof cache;
  } catch {
    // corrupt cache: rebuild
  }
  const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
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
      if (registryChanged) atomicWriteFile(registryPath, md);
      if (cacheChanged) atomicWriteFile(cachePath, newCache);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
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
export function peekRegistry(cwd: string): { registryPath: string; skillCount: number } | undefined {
  const registryPath = join(resolve(cwd), REGISTRY_REL_PATH);
  const bytes = readOptional(registryPath);
  return bytes ? { registryPath, skillCount: countRows(bytes.toString("utf8")) } : undefined;
}

function countRows(md: string): number {
  return md.split("\n").filter((l) => /^\| `/.test(l)).length;
}

/** Git-tracked subset of targets; [] outside a git repository; throws when git cannot answer. */
export function realGitTracked(cwd: string, targets: string[]): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "-z", "--", ...targets], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    return out.split("\0").filter(Boolean);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/not a git repository/.test(stderr)) return [];
    throw err;
  }
}

/** Plugins whose skills are indexed: this install (CLAUDE_PLUGIN_ROOT or the module root) plus installed plugins. Fail-safe. */
export function realPluginRoots(env: Record<string, string | undefined>, home: string): PluginRoot[] {
  const out: PluginRoot[] = [];
  const own = oddClaudeRoot(env);
  out.push({ name: "odd-claude", root: own });
  try {
    const raw = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    for (const [key, installs] of Object.entries(raw.plugins ?? {})) {
      const root = installs?.[0]?.installPath;
      if (typeof root !== "string" || resolve(root) === resolve(own)) continue;
      out.push({ name: key.split("@")[0]!, root });
    }
  } catch {
    // no installed plugins file
  }
  return out;
}
