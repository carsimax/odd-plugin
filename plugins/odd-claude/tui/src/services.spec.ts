import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { parseArgs } from "../../src/installer/args.js";
import type { CliIo } from "../../src/installer/cli.js";
import { defaultSelection } from "../../src/installer/models.js";
import { DEFAULT_EXTRAS } from "../../src/installer/extras.js";
import { runFullInstall } from "../../src/installer/orchestrate.js";
import { makeHome, makeSource } from "../../src/installer/installer.testkit.js";
import { fail, fakeRunner, ghRunner, makeRelease, ok, type Call } from "../../src/installer/update.testkit.js";
import { createServices } from "./services.js";

describe("createServices update", () => {
  it("re-applies through the new version's installer, exactly once", async () => {
    const { home } = makeHome();
    const env = {};
    const quiet = fakeRunner((c) => (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get" ? fail("No MCP server named x found") : undefined));
    await runFullInstall({ env, homedir: home, runner: quiet.runner, source: makeSource(), deps: false });
    const bin = join("versions", "9.9.10", "dist", "installer", "bin.js");
    const isReapply = (c: Call): boolean => c.args[0]?.endsWith(bin) === true && c.args[1] === "reapply";
    const steps = JSON.stringify({ ok: true, steps: [{ id: "hooks", label: "Hooks", status: "ok", detail: "child" }] });
    const gh = ghRunner(makeRelease("9.9.10"), (c) => (isReapply(c) ? ok(steps) : c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get" ? fail("No MCP server named x found") : undefined));
    const parsed = parseArgs(["update", "--force"]);
    assert.ok(parsed.ok);
    const io: CliIo = { env, homedir: home, runner: gh.runner, stdout: () => {}, stderr: () => {}, isTty: false, version: "1.0.0" };
    const r = await createServices(io, parsed.args).run({ flow: "update", selection: defaultSelection(), extras: DEFAULT_EXTRAS, deps: false, purge: false }, () => {});
    assert.equal(r.ok, true);
    assert.equal(gh.calls.filter(isReapply).length, 1);
  });
});
