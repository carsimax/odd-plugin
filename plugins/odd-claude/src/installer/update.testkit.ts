// Test helpers for update/deps: a recording fake runner and a fixture release built with the system tar.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "./manifest.js";
import type { McpRunner, RunResult } from "./mcp.js";
import { makeSource, put } from "./installer.testkit.js";

export interface Call {
  cmd: string;
  args: string[];
}
export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "boom", code = 1): RunResult => ({ code, stdout: "", stderr });

/** Records every call; `respond` may answer, otherwise exit 0. */
export function fakeRunner(respond?: (c: Call) => RunResult | undefined): { runner: McpRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: McpRunner = (cmd, args) => {
    const c = { cmd, args: [...args] };
    calls.push(c);
    return respond?.(c) ?? ok();
  };
  return { runner, calls };
}

export interface FixtureRelease {
  version: string;
  dir: string;
  tarball: string;
  bundle: string;
  checksums: string;
}

/** A release asset set (payload tarball, bundle, checksums.txt) in a temp dir, tarball made by system tar. */
export function makeRelease(version: string, opts: { tamper?: boolean; omitChecksumFor?: string } = {}): FixtureRelease {
  const dir = mkdtempSync(join(tmpdir(), "odd-rel-"));
  const stage = mkdtempSync(join(tmpdir(), "odd-relsrc-"));
  const src = makeSource();
  put(src, "cards/version.md", `release ${version}\n`);
  cpSync(src, join(stage, `odd-claude-${version}`), { recursive: true });
  const tarball = `odd-claude-payload-${version}.tar.gz`;
  const r = spawnSync("tar", ["-czf", join(dir, tarball), "-C", stage, `odd-claude-${version}`]);
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  writeFileSync(join(dir, "odd-claude.mjs"), `// bundle ${version}\n`);
  const names = [tarball, "odd-claude.mjs"];
  const lines = names.filter((n) => n !== opts.omitChecksumFor).map((n) => `${sha256(readFileSync(join(dir, n)))}  ${n}`);
  writeFileSync(join(dir, "checksums.txt"), lines.join("\n") + "\n");
  if (opts.tamper) writeFileSync(join(dir, "odd-claude.mjs"), "// tampered\n");
  return { version, dir, tarball, bundle: "odd-claude.mjs", checksums: "checksums.txt" };
}

/** Fake `gh` serving a fixture release; `tar` goes to the real system tar. `extra` may override any call. */
export function ghRunner(rel: FixtureRelease, extra?: (c: Call) => RunResult | undefined): { runner: McpRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: McpRunner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const x = extra?.({ cmd, args });
    if (x) return x;
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      const assets = [rel.tarball, rel.bundle, rel.checksums].map((name) => ({ name }));
      return ok(JSON.stringify({ tagName: `v${rel.version}`, assets }));
    }
    if (cmd === "gh" && args[0] === "release" && args[1] === "download") {
      const dest = args[args.indexOf("-D") + 1]!;
      mkdirSync(dest, { recursive: true });
      for (const n of [rel.tarball, rel.bundle, rel.checksums]) cpSync(join(rel.dir, n), join(dest, n));
      return ok();
    }
    if (cmd === "tar") {
      const r = spawnSync("tar", args, { encoding: "utf8" });
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    return ok();
  };
  return { runner, calls };
}
