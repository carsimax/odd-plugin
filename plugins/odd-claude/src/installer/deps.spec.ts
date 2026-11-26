import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectDeps, installDeps, planDeps } from "./deps.js";
import { fail, fakeRunner, ok, type Call } from "./update.testkit.js";

const key = (c: Call): string => `${c.cmd} ${c.args.join(" ")}`;
/** Tools in `present` answer their version probe; everything else is "not found". */
const probes = (present: string[]) => (c: Call) => {
  const probe = ["engram version", "codegraph --version", "brew --version", "npm --version"].find((p) => key(c) === p);
  if (probe) return present.includes(c.cmd) ? ok("1.0.0\n") : fail("command not found", 127);
  return undefined;
};

describe("detectDeps", () => {
  it("probes engram, codegraph, brew and npm with the exact argv", async () => {
    const { runner, calls } = fakeRunner(probes(["engram", "brew"]));
    const d = await detectDeps(runner);
    assert.deepEqual(calls.map(key), ["engram version", "codegraph --version", "brew --version", "npm --version"]);
    assert.deepEqual(d, { engram: true, codegraph: false, brew: true, npm: false });
  });

  it("treats a throwing runner (ENOENT) as absent", async () => {
    const d = await detectDeps(() => { throw new Error("spawnSync ENOENT"); });
    assert.deepEqual(d, { engram: false, codegraph: false, brew: false, npm: false });
  });
});

describe("planDeps", () => {
  it("skips what is installed", () => {
    const plan = planDeps({ engram: true, codegraph: true, brew: false, npm: false });
    assert.deepEqual(plan.map((p) => [p.name, p.status]), [["engram", "present"], ["codegraph", "present"]]);
  });

  it("plans the brew and npm installs", () => {
    const plan = planDeps({ engram: false, codegraph: false, brew: true, npm: true });
    assert.deepEqual(plan[0]!.steps.map((s) => [s.cmd, ...s.args].join(" ")), ["brew install gentleman-programming/tap/engram", "engram setup claude-code"]);
    assert.deepEqual(plan[1]!.steps.map((s) => [s.cmd, ...s.args].join(" ")), ["npm install -g @colbymchenry/codegraph"]);
    assert.deepEqual(plan.map((p) => p.status), ["install", "install"]);
  });

  it("gives manual instructions without brew or npm", () => {
    const plan = planDeps({ engram: false, codegraph: false, brew: false, npm: false });
    assert.deepEqual(plan.map((p) => p.status), ["manual", "manual"]);
    assert.match(plan[0]!.instructions ?? "", /https:\/\/github\.com\/Gentleman-Programming\/engram/);
    assert.match(plan[1]!.instructions ?? "", /npm install -g @colbymchenry\/codegraph/);
  });
});

describe("installDeps", () => {
  it("installs both after confirmation and runs the exact commands in order", async () => {
    const { runner, calls } = fakeRunner(probes(["brew", "npm"]));
    const asked: string[] = [];
    const res = await installDeps(runner, { confirm: (a) => { asked.push(a.name); return true; } });
    assert.deepEqual(asked, ["engram", "codegraph"]);
    assert.deepEqual(calls.slice(4).map(key), ["brew install gentleman-programming/tap/engram", "engram setup claude-code", "npm install -g @colbymchenry/codegraph"]);
    assert.deepEqual(res.map((r) => [r.name, r.status]), [["engram", "installed"], ["codegraph", "installed"]]);
  });

  it("never calls `codegraph install`", async () => {
    const { runner, calls } = fakeRunner(probes(["brew", "npm"]));
    await installDeps(runner, { confirm: () => true });
    assert.equal(calls.some((c) => c.cmd === "codegraph" && c.args[0] === "install"), false);
  });

  it("skips installed deps without asking", async () => {
    const { runner, calls } = fakeRunner(probes(["engram", "codegraph", "brew", "npm"]));
    let asked = 0;
    const res = await installDeps(runner, { confirm: () => { asked++; return true; } });
    assert.equal(asked, 0);
    assert.equal(calls.length, 4);
    assert.deepEqual(res.map((r) => r.status), ["skipped", "skipped"]);
  });

  it("installs nothing when confirm declines", async () => {
    const { runner, calls } = fakeRunner(probes(["brew", "npm"]));
    const res = await installDeps(runner, { confirm: () => false });
    assert.equal(calls.length, 4, "only the probes ran");
    assert.deepEqual(res.map((r) => r.status), ["declined", "declined"]);
  });

  it("reports manual instructions for engram without brew and does not ask", async () => {
    const { runner, calls } = fakeRunner(probes(["npm"]));
    const asked: string[] = [];
    const res = await installDeps(runner, { confirm: (a) => { asked.push(a.name); return true; } });
    assert.deepEqual(asked, ["codegraph"]);
    assert.equal(res[0]!.status, "manual");
    assert.match(res[0]!.detail, /https:\/\/github\.com\/Gentleman-Programming\/engram/);
    assert.equal(calls.some((c) => c.cmd === "brew" && c.args[0] === "install"), false);
  });

  it("reports a failure per dependency and keeps going", async () => {
    const { runner } = fakeRunner((c) => (key(c).startsWith("brew install") ? fail("brew exploded") : probes(["brew", "npm"])(c)));
    const res = await installDeps(runner, { confirm: () => true });
    assert.equal(res[0]!.status, "failed");
    assert.match(res[0]!.detail, /brew exploded/);
    assert.equal(res[1]!.status, "installed");
  });

  it("does not throw when the runner throws, and skips engram setup after a failed install", async () => {
    const calls: string[] = [];
    const res = await installDeps(
      (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        if (args[0] === "install") throw new Error("spawn failed");
        return probes(["brew", "npm"])({ cmd, args }) ?? ok();
      },
      { confirm: () => true },
    );
    assert.deepEqual(res.map((r) => r.status), ["failed", "failed"]);
    assert.equal(calls.includes("engram setup claude-code"), false);
  });

  it("reports a failing engram setup as a failure", async () => {
    const { runner } = fakeRunner((c) => (key(c) === "engram setup claude-code" ? fail("setup failed") : probes(["brew", "npm"])(c)));
    const res = await installDeps(runner, { confirm: (a) => a.name === "engram" });
    assert.equal(res[0]!.status, "failed");
    assert.match(res[0]!.detail, /setup failed/);
    assert.equal(res[1]!.status, "declined");
  });
});
