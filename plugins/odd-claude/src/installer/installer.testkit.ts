// Test helpers: a small payload tree and temp install roots. Never touches the real home.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROFILE_ROLES } from "../lib/profiles.js";
import { resolveInstallPaths, type InstallPaths } from "./paths.js";

export function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function agentMd(role: string, model?: string): string {
  return `---\nname: ${role}\ndescription: test agent ${role}\n${model ? `model: ${model}\n` : ""}maxTurns: 5\n---\n\nBody of ${role}.\n`;
}

/** A minimal release payload (what stagePayload copies). */
export function makeSource(): string {
  const root = mkdtempSync(join(tmpdir(), "odd-src-"));
  put(root, "package.json", '{"name":"odd-claude","version":"9.9.9"}\n');
  put(root, "dist/hooks/run.js", "// run\n");
  put(root, "support/verification.md", "Support: see ${CLAUDE_PLUGIN_ROOT}/support/memory.md and data ${CLAUDE_PLUGIN_DATA}\n");
  put(root, "support/memory.md", "memory doc\n");
  put(root, "support/test-first.md", "support ${CLAUDE_PLUGIN_ROOT}/x\n");
  put(root, "hooks/hooks.json", "{}\n");
  put(root, "output-styles/odd.md", "style at ${CLAUDE_PLUGIN_ROOT}/support\n");
  put(root, "skills/odd-doctor/SKILL.md", '---\nname: odd-doctor\n---\nRun `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/doctor.js" --data-dir "${CLAUDE_PLUGIN_DATA}"` for ${CLAUDE_SESSION_ID}\n');
  put(root, "skills/odd-doctor/refs/extra.md", "extra\n");
  for (const role of PROFILE_ROLES) put(root, `agents/${role}.md`, agentMd(role, role === "odd-explore" ? "haiku" : undefined));
  return root;
}

export function makeHome(): { home: string; paths: InstallPaths } {
  const home = mkdtempSync(join(tmpdir(), "odd-home-"));
  return { home, paths: resolveInstallPaths({}, home) };
}
