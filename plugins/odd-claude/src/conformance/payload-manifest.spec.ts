// Payload conformance, the stand-in for `claude plugin validate` now that odd-claude is no longer a plugin: frontmatter of
// agents, skills and output styles, and the shape of hooks/hooks.json. Claude Code ignores unknown frontmatter keys silently,
// so a typo would otherwise ship unnoticed. Checks are pure functions over (file name, text), unit-tested below with bad input.
// Description length and "odd output style" are covered by skill-descriptions.spec.ts and are not repeated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const AGENT_KEYS = new Set([
  "name", "description", "tools", "disallowedTools", "model", "maxTurns", "color", "omitClaudeMd", "effort", "skills",
  "permissionMode", "mcpServers", "hooks", "memory", "isolation", "background", "initialPrompt",
]);
export const MODEL_ALIASES = new Set(["haiku", "sonnet", "opus", "fable", "inherit"]);
export const HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "Notification", "PermissionRequest",
]);

/** Line-based `key: value` frontmatter; null when the file has no `---` block. Surrounding double quotes are stripped. */
export function parseFrontmatter(text: string): Map<string, string> | null {
  const body = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (body === undefined) return null;
  const out = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim().replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

const list = (v: string): string[] => v.split(",").map((s) => s.trim());

/** Problems found in one agent file (`stem` is the file name without `.md`). */
export function agentProblems(stem: string, text: string): string[] {
  const fm = parseFrontmatter(text);
  if (!fm) return ["no frontmatter"];
  const p: string[] = [];
  if (!fm.get("name")) p.push("missing name");
  else if (fm.get("name") !== stem) p.push(`name "${fm.get("name")}" differs from file stem`);
  if (!fm.get("description")) p.push("missing description");
  for (const k of fm.keys()) if (!AGENT_KEYS.has(k)) p.push(`unknown key "${k}"`);
  const model = fm.get("model");
  if (model !== undefined && !MODEL_ALIASES.has(model) && !model.startsWith("claude-")) p.push(`invalid model "${model}"`);
  const turns = fm.get("maxTurns");
  if (turns !== undefined && !/^[1-9]\d*$/.test(turns)) p.push(`maxTurns "${turns}" is not a positive integer`);
  for (const k of ["tools", "disallowedTools"]) {
    const v = fm.get(k);
    if (v !== undefined && list(v).some((s) => s === "")) p.push(`${k} has an empty entry`);
  }
  const tools = fm.get("tools");
  const denied = fm.get("disallowedTools");
  if (tools !== undefined && denied !== undefined) {
    const both = list(tools).filter((t) => t !== "" && list(denied).includes(t));
    if (both.length) p.push(`in both tools and disallowedTools: ${both.join(", ")}`);
  }
  return p;
}

/** Problems found in one SKILL.md (`dir` is its directory name). */
export function skillProblems(dir: string, text: string): string[] {
  const fm = parseFrontmatter(text);
  if (!fm) return ["no frontmatter"];
  if (!fm.get("name")) return ["missing name"];
  return fm.get("name") === dir ? [] : [`name "${fm.get("name")}" differs from directory`];
}

/** Problems found in one output style file. */
export function styleProblems(text: string): string[] {
  const fm = parseFrontmatter(text);
  if (!fm) return ["no frontmatter"];
  const p: string[] = [];
  if (!fm.get("name")) p.push("missing name");
  if (!fm.get("description")) p.push("missing description");
  return p;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems found in the text of hooks/hooks.json. */
export function hooksProblems(text: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return [`invalid JSON: ${(e as Error).message}`];
  }
  if (!isObject(json) || !isObject(json.hooks)) return ["no top-level hooks object"];
  const p: string[] = [];
  for (const [event, groups] of Object.entries(json.hooks)) {
    if (!HOOK_EVENTS.has(event)) p.push(`${event}: unknown event`);
    if (!Array.isArray(groups)) {
      p.push(`${event}: value is not an array`);
      continue;
    }
    groups.forEach((g, gi) => {
      if (!isObject(g) || !Array.isArray(g.hooks)) {
        p.push(`${event}[${gi}]: group has no hooks array`);
        return;
      }
      g.hooks.forEach((h, hi) => {
        const at = `${event}[${gi}].hooks[${hi}]`;
        if (!isObject(h) || h.type !== "command") return p.push(`${at}: type is not "command"`), undefined;
        if (typeof h.command !== "string" || h.command.trim() === "") return p.push(`${at}: empty command`), undefined;
        const arg = /dist\/hooks\/run\.js"?\s+(\S+)/.exec(h.command)?.[1];
        if (/dist\/hooks\/run\.js/.test(h.command) && arg !== event) p.push(`${at}: run.js argument "${arg ?? ""}" differs from event`);
        return undefined;
      });
    });
  }
  return p;
}

const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");
const collect = (items: string[], problems: (item: string) => string[]): string[] => items.flatMap((i) => problems(i).map((m) => `${i}: ${m}`));
const files = (dir: string, ext: string): string[] => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(ext)).sort();
const skillDirs = (): string[] => readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

// Real payload.

test("every agent has valid frontmatter", () => {
  assert.deepEqual(collect(files("agents", ".md"), (f) => agentProblems(f.replace(/\.md$/, ""), read("agents", f))), []);
});

test("every skill has frontmatter whose name is its directory", () => {
  assert.deepEqual(collect(skillDirs(), (d) => skillProblems(d, read("skills", d, "SKILL.md"))), []);
});

test("every output style has a name and description", () => {
  assert.deepEqual(collect(files("output-styles", ".md"), (f) => styleProblems(read("output-styles", f))), []);
});

test("hooks/hooks.json has known events and well-formed command hooks", () => {
  assert.deepEqual(hooksProblems(read("hooks", "hooks.json")), []);
});

// The checks themselves can fail.

const good = (extra = ""): string => `---\nname: odd-x\ndescription: Does x.\n${extra}---\nbody\n`;

test("agentProblems flags each bad shape", () => {
  assert.deepEqual(agentProblems("odd-x", good("tools: Read, Grep\nmodel: haiku\nmaxTurns: 5\n")), []);
  assert.deepEqual(agentProblems("odd-x", "no fm"), ["no frontmatter"]);
  assert.deepEqual(agentProblems("odd-x", "---\ndescription: d\n---\n"), ["missing name"]);
  assert.deepEqual(agentProblems("odd-y", good()), ['name "odd-x" differs from file stem']);
  assert.deepEqual(agentProblems("odd-x", "---\nname: odd-x\n---\n"), ["missing description"]);
  assert.deepEqual(agentProblems("odd-x", good("maxTurn: 5\n")), ['unknown key "maxTurn"']);
  assert.deepEqual(agentProblems("odd-x", good("model: gpt-4\n")), ['invalid model "gpt-4"']);
  assert.deepEqual(agentProblems("odd-x", good("model: claude-opus-4\n")), []);
  assert.deepEqual(agentProblems("odd-x", good("maxTurns: 0\n")), ['maxTurns "0" is not a positive integer']);
  assert.deepEqual(agentProblems("odd-x", good("maxTurns: 2.5\n")), ['maxTurns "2.5" is not a positive integer']);
  assert.deepEqual(agentProblems("odd-x", good("tools: Read,, Grep\n")), ["tools has an empty entry"]);
  assert.deepEqual(agentProblems("odd-x", good("disallowedTools: Edit,\n")), ["disallowedTools has an empty entry"]);
  assert.deepEqual(agentProblems("odd-x", good("tools: Read, Edit\ndisallowedTools: Edit, Write\n")), ["in both tools and disallowedTools: Edit"]);
});

test("skillProblems flags missing frontmatter, missing name and a name that differs from the directory", () => {
  assert.deepEqual(skillProblems("s", "---\nname: s\n---\n"), []);
  assert.deepEqual(skillProblems("s", "# s"), ["no frontmatter"]);
  assert.deepEqual(skillProblems("s", "---\ndescription: d\n---\n"), ["missing name"]);
  assert.deepEqual(skillProblems("s", "---\nname: t\n---\n"), ['name "t" differs from directory']);
});

test("styleProblems flags missing frontmatter, name and description", () => {
  assert.deepEqual(styleProblems(good()), []);
  assert.deepEqual(styleProblems("x"), ["no frontmatter"]);
  assert.deepEqual(styleProblems("---\nkeep-coding-instructions: true\n---\n"), ["missing name", "missing description"]);
});

test("hooksProblems flags each bad shape", () => {
  const hooks = (event: string, h: unknown): string => JSON.stringify({ hooks: { [event]: [{ hooks: [h] }] } });
  const cmd = (arg: string): unknown => ({ type: "command", command: `node "\${X}/dist/hooks/run.js" ${arg}` });
  assert.deepEqual(hooksProblems(hooks("Stop", cmd("Stop"))), []);
  assert.match(hooksProblems("{")[0]!, /^invalid JSON/);
  assert.deepEqual(hooksProblems("[]"), ["no top-level hooks object"]);
  assert.deepEqual(hooksProblems("{}"), ["no top-level hooks object"]);
  assert.deepEqual(hooksProblems(hooks("Stopp", cmd("Stopp"))), ["Stopp: unknown event"]);
  assert.deepEqual(hooksProblems(JSON.stringify({ hooks: { Stop: {} } })), ["Stop: value is not an array"]);
  assert.deepEqual(hooksProblems(JSON.stringify({ hooks: { Stop: [{}] } })), ["Stop[0]: group has no hooks array"]);
  assert.deepEqual(hooksProblems(hooks("Stop", { type: "prompt", command: "x" })), ['Stop[0].hooks[0]: type is not "command"']);
  assert.deepEqual(hooksProblems(hooks("Stop", { type: "command", command: "  " })), ["Stop[0].hooks[0]: empty command"]);
  assert.deepEqual(hooksProblems(hooks("Stop", { type: "command" })), ["Stop[0].hooks[0]: empty command"]);
  assert.deepEqual(hooksProblems(hooks("Stop", cmd("SessionEnd"))), ['Stop[0].hooks[0]: run.js argument "SessionEnd" differs from event']);
  assert.deepEqual(hooksProblems(hooks("Stop", { type: "command", command: "node a/dist/hooks/run.js" })), ['Stop[0].hooks[0]: run.js argument "" differs from event']);
});
