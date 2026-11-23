// S3: an agent escalation reaches the review-due decision of the Stop reminder and the delivery notice. Everything goes through
// the public interface: the review MCP tools (ReviewServer) and the hooks (runHook), over a real temp repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../hooks/run.js";
import { ReviewServer, type Response } from "../mcp/review-server.js";
import type { ToolDeps } from "../mcp/tools.js";
import { setReviewMode } from "../review/mode.js";
import { consentBinding } from "../review/consent.js";
import { chmodSync } from "node:fs";
import { UNREVIEWED_DELIVERY_NOTICE } from "../review/gate.js";

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Fx {
  dir: string;
  repo: string;
  data: string;
  commonDir: string;
  cleanup: () => void;
}

/** A repository with one commit and a LOW-risk workspace change (README only) or a HIGH-risk one (package.json dependency). */
function fx(dirty: "low" | "high" = "low"): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-escalation-")));
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(repo);
  mkdirSync(data);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (dirty === "low") writeFileSync(join(repo, "README.md"), "# t\n\nmore docs\n");
  else writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
  return { dir, repo, data, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

interface Called {
  isError: boolean;
  body: any;
}

function server(f: Fx): (name: string, args?: Record<string, unknown>) => Promise<Called> {
  const deps: ToolDeps = { modeOptions: { dataDir: f.data } };
  const s = new ReviewServer({ deps, cwd: f.repo });
  let id = 0;
  return async (name, args = {}) => {
    const res = (await s.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as Response;
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const result = res.result as { content: { text: string }[]; isError?: boolean };
    return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
  };
}

const on = (f: Fx): void => void setReviewMode("enable", "global", f.repo, { dataDir: f.data });
const stop = (f: Fx, session = "s1"): { exitCode: number; stdout: string } =>
  runHook("Stop", JSON.stringify({ session_id: session, cwd: f.repo, stop_hook_active: false }), { dataDir: f.data });
const push = (f: Fx): { exitCode: number; stdout: string } =>
  runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd: f.repo, tool_name: "Bash", tool_input: { command: "git push" } }), { dataDir: f.data });
const SILENT = { exitCode: 0, stdout: "" };
const ESC = { item: 3, reason: "touches the dependency policy" };

function assertNotice(r: { exitCode: number; stdout: string }, why: string): void {
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: UNREVIEWED_DELIVERY_NOTICE } }, why);
}

const errorOf = (c: Called): { code: string; message: string } => {
  assert.equal(c.isError, true, JSON.stringify(c.body));
  return c.body.error;
};

test("a non-escalated low-risk candidate: neither the Stop reminder nor the delivery notice", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const a = await call("review_assess", {});
    assert.equal(a.body.risk_level, "low");
    assert.equal(a.body.review_due, false);
    assert.deepEqual(stop(f), SILENT);
    assert.deepEqual(push(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("an escalated candidate: review_assess reports it due, the Stop reminder blocks once and the delivery notice appears", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const a = await call("review_assess", { escalate: ESC });
    assert.equal(a.isError, false);
    assert.equal(a.body.review_due, true);
    assert.equal(a.body.risk_level, "low", "the assessment itself is not rewritten");
    const r = stop(f);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(out.decision, "block");
    assert.ok(out.reason.includes(a.body.target_identity), "names the escalated candidate");
    assert.deepEqual(stop(f), SILENT, "once per session and candidate");
    assertNotice(push(f), "delivery notice for the escalated candidate");
    // the escalation is only read by the hooks: another session reminds again, nothing else changed
    assert.equal(JSON.parse(stop(f, "s2").stdout).decision, "block");
  } finally {
    f.cleanup();
  }
});

test("RDD off: an escalated candidate stays silent", async () => {
  const f = fx();
  try {
    const call = server(f);
    assert.equal((await call("review_assess", { escalate: ESC })).body.review_due, true);
    assert.deepEqual(stop(f), SILENT);
    assert.deepEqual(push(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("a changed candidate drops the escalation", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    await call("review_assess", { escalate: ESC });
    assertNotice(push(f), "control: the escalated candidate notices");
    writeFileSync(join(f.repo, "README.md"), "# t\n\neven more docs\n");
    assert.deepEqual(push(f), SILENT);
    assert.deepEqual(stop(f, "s9"), SILENT);
  } finally {
    f.cleanup();
  }
});

test("an escalation can only raise: a high-risk candidate stays high and due", async () => {
  const f = fx("high");
  try {
    const call = server(f);
    const plain = await call("review_assess", {});
    const esc = await call("review_assess", { escalate: ESC });
    assert.equal(plain.body.risk_level, "high");
    assert.equal(esc.body.risk_level, "high");
    assert.equal(esc.body.review_due, true);
  } finally {
    f.cleanup();
  }
});

test("the escalate reason is measured in UTF-8 bytes: 500 bytes of multibyte characters pass, 501 fail", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const tooLong = errorOf(await call("review_assess", { escalate: { item: 1, reason: `${"é".repeat(250)}a` } }));
    assert.equal(tooLong.code, "invalid_input");
    assert.match(tooLong.message, /500 UTF-8 bytes/);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false, "a rejected escalation stores nothing");
    assert.deepEqual(push(f), SILENT);
    const ok = await call("review_assess", { escalate: { item: 1, reason: "é".repeat(250) } });
    assert.equal(ok.isError, false);
    assert.equal(ok.body.review_due, true);
    // 501 single-byte characters are rejected too, whichever layer measures them
    assert.equal(errorOf(await call("review_assess", { escalate: { item: 1, reason: "a".repeat(501) } })).code, "invalid_input");
  } finally {
    f.cleanup();
  }
});

test("the escalate reason rejects only line breaks: a tab is accepted, CR, LF and Unicode line separators are not", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    for (const reason of ["one\ntwo", "one\rtwo", "one two", "one\u0085two", "one\vtwo", "one\ftwo"]) {
      const e = errorOf(await call("review_assess", { escalate: { item: 2, reason } }));
      assert.equal(e.code, "invalid_input", JSON.stringify(reason));
      assert.match(e.message, /one line/);
    }
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false);
    assert.deepEqual(stop(f), SILENT);
    const ok = await call("review_assess", { escalate: { item: 2, reason: "one\ttwo" } });
    assert.equal(ok.isError, false);
    assert.equal(ok.body.review_due, true);
  } finally {
    f.cleanup();
  }
});

test("an invalid escalate is rejected before anything is stored: item outside 1-6, blank reason, extra field, the old boolean", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const bad: unknown[] = [
      { item: 0, reason: "r" }, { item: 7, reason: "r" }, { item: 1.5, reason: "r" }, { item: "1", reason: "r" }, { reason: "r" }, { item: 1 },
      { item: 1, reason: "" }, { item: 1, reason: "   " }, { item: 1, reason: 5 }, { item: 1, reason: "r", extra: true }, true, "yes", null,
    ];
    for (const escalate of bad) assert.equal(errorOf(await call("review_assess", { escalate })).code, "invalid_input", JSON.stringify(escalate));
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false, "no state was written");
    assert.deepEqual(stop(f), SILENT);
    assert.deepEqual(push(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("review_start and review_run carry the escalation into a fresh START: the frozen tier and the consent envelope read high", async () => {
  const plain = fx();
  const viaStart = fx();
  const viaRun = fx();
  const invalid = fx();
  try {
    // control: a low-risk candidate starts without consent
    const control = await server(plain)("review_start", {});
    assert.equal(control.body.risk_level, "low");
    const start = await server(viaStart)("review_start", { escalate: ESC });
    assert.equal(start.isError, false);
    assert.equal(start.body.action, "consent_required");
    assert.equal(start.body.risk_level, "high");
    const run = await server(viaRun)("review_run", { escalate: ESC });
    assert.equal(run.isError, false);
    assert.equal(run.body.outcome, "consent-required");
    assert.equal(run.body.envelope.risk_level, "high");
    // the escalated START is a candidate that is now due for the hooks too
    on(viaStart);
    assert.equal(JSON.parse(stop(viaStart).stdout).decision, "block");
    // an invalid escalate stops before START: nothing starts, nothing is stored
    assert.equal(errorOf(await server(invalid)("review_start", { escalate: { item: 9, reason: "r" } })).code, "invalid_input");
    assert.equal(errorOf(await server(invalid)("review_run", { escalate: { item: 1, reason: "a\nb" } })).code, "invalid_input");
    assert.equal(existsSync(join(invalid.commonDir, "odd-plugin")), false);
  } finally {
    for (const x of [plain, viaStart, viaRun, invalid]) x.cleanup();
  }
});

test("a START that is not fresh ignores the escalation: an existing lineage keeps its frozen tier", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const first = await call("review_start", {});
    assert.equal(first.body.risk_level, "low");
    const again = await call("review_start", { escalate: ESC });
    assert.equal(again.isError, false);
    assert.equal(again.body.risk_level, "low", "the frozen tier is never changed by a later escalation");
    assert.equal(again.body.action, "replayed");
  } finally {
    f.cleanup();
  }
});

const STORE = (f: Fx): string => join(f.commonDir, "odd-plugin", "review-escalations.json");

test("every tool that takes escalate rejects each invalid value as invalid_input and creates no escalation store", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const bad: unknown[] = [null, [], { item: 3, reason: "a\u0085b" }, { item: 3, reason: "a\vb" }, { item: 3, reason: "   " }, { item: 3, reason: "a".repeat(501) }];
    for (const tool of ["review_assess", "review_start", "review_run"]) {
      for (const escalate of bad) {
        const e = errorOf(await call(tool, { escalate }));
        assert.equal(e.code, "invalid_input", `${tool} ${JSON.stringify(escalate)}`);
        assert.equal(existsSync(STORE(f)), false, `${tool} ${JSON.stringify(escalate)}: no store`);
      }
    }
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false);
    assert.deepEqual(stop(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("garbage in the escalation store is ignored: the delivery notice and the Stop reminder stay silent", () => {
  const f = fx();
  try {
    on(f);
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    writeFileSync(STORE(f), "{garbage");
    assert.deepEqual(push(f), SILENT);
    assert.deepEqual(stop(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("an unusable escalation store (a directory) degrades: review_assess keeps its assessment, review_start and review_run still start, all report not_recorded, nothing is written", async () => {
  const f = fx();
  try {
    on(f);
    mkdirSync(STORE(f), { recursive: true });
    const call = server(f);
    const a = await call("review_assess", { escalate: ESC });
    assert.equal(a.isError, false);
    assert.equal(a.body.outcome, "assessed");
    assert.equal(a.body.risk_level, "low");
    assert.equal(a.body.escalation, "not_recorded");
    assert.match(a.body.escalation_detail, /escalation/i);
    assert.ok(a.body.escalation_detail.length <= 300);
    const s = await call("review_start", { escalate: ESC });
    assert.equal(s.isError, false, "START is not aborted");
    assert.equal(s.body.action, "closed");
    assert.equal(s.body.risk_level, "low", "an escalation that cannot be persisted is not applied: START runs at the base tier");
    assert.equal(s.body.escalation, "not_recorded");
    assert.match(s.body.escalation_detail, /escalation/i);
    const g = fx();
    try {
      on(g);
      mkdirSync(STORE(g), { recursive: true });
      const r = await server(g)("review_run", { escalate: ESC });
      assert.equal(r.isError, false);
      assert.equal(r.body.escalation, "not_recorded");
      assert.equal(r.body.outcome, "closed");
    } finally {
      g.cleanup();
    }
    assert.equal(lstatSync(STORE(f)).isDirectory(), true, "the directory is untouched");
    assert.deepEqual(readdirSync(STORE(f)), []);
    assert.deepEqual(readdirSync(join(f.commonDir, "odd-plugin")).filter((n) => n.startsWith("review-escalations")), ["review-escalations.json"], "no temp, lock or corrupt files");
    assert.deepEqual(push(f), SILENT);
    // without escalate the tools still work and carry no escalation field
    const plain = await call("review_assess", {});
    assert.equal(plain.isError, false);
    assert.equal("escalation" in plain.body, false);
  } finally {
    f.cleanup();
  }
});

test("a refused START leaves no escalation: binding_drift reports not_recorded, the store is absent and the hooks stay silent", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const wrong = `sha256:${"0".repeat(64)}`;
    const e = errorOf(await call("review_start", { escalate: ESC, target_identity: wrong }));
    assert.equal(e.code, "binding_drift");
    assert.equal((e as any).escalation, "not_recorded");
    assert.match((e as any).escalation_detail, /refused|not started/i);
    assert.equal(existsSync(STORE(f)), false, "nothing recorded");
    assert.deepEqual(stop(f), SILENT);
    assert.deepEqual(push(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("an escalation that cannot be bound to a candidate says so: an empty candidate is not_recorded on every tool", async () => {
  const f = fx();
  try {
    on(f);
    git(f.repo, "checkout", "-q", "--", ".");
    const call = server(f);
    const a = await call("review_assess", { escalate: ESC });
    assert.equal(a.body.outcome, "not_due");
    assert.equal(a.body.escalation, "not_recorded");
    assert.match(a.body.escalation_detail, /no changes|candidate/i);
    const s = await call("review_start", { escalate: ESC });
    assert.equal(s.isError, false);
    assert.equal(s.body.outcome, "not_due");
    assert.equal(s.body.escalation, "not_recorded");
    const r = await call("review_run", { escalate: ESC });
    assert.equal(r.body.outcome, "not-due");
    assert.equal(r.body.escalation, "not_recorded");
    assert.equal(existsSync(STORE(f)), false);
  } finally {
    f.cleanup();
  }
});

test("the escalation field: recorded on success; ignored_existing_lineage when a lineage exists or review_run resumes one", async () => {
  const f = fx();
  const g = fx();
  try {
    on(f);
    const call = server(f);
    const a = await call("review_assess", { escalate: ESC });
    assert.equal(a.body.escalation, "recorded");
    assert.equal(a.body.escalation_detail, undefined);
    const s = await call("review_start", { escalate: ESC });
    assert.equal(s.body.action, "consent_required");
    assert.equal(s.body.escalation, "recorded");
    // a candidate with a live lineage: the escalation is ignored and says so
    const first = await server(g)("review_start", {});
    assert.equal(first.body.risk_level, "low");
    const again = await server(g)("review_start", { escalate: ESC });
    assert.equal(again.body.action, "replayed");
    assert.equal(again.body.risk_level, "low");
    assert.equal(again.body.escalation, "ignored_existing_lineage");
    assert.match(again.body.escalation_detail, /lineage/i);
    assert.deepEqual(again.body.risk_reasons.filter((x: any) => x.code === "agent_escalation"), [], "the frozen lineage reasons are not rewritten");
    assert.equal(existsSync(STORE(g)), false, "an ignored escalation is not stored");
    const resumed = await server(g)("review_run", { lineage_id: first.body.lineage_id, escalate: ESC });
    assert.equal(resumed.body.escalation, "ignored_existing_lineage");
    assert.equal(existsSync(STORE(g)), false);
    const noEscalate = await server(g)("review_start", {});
    assert.equal("escalation" in noEscalate.body, false);
  } finally {
    f.cleanup();
    g.cleanup();
  }
});

test("two processes recording different candidates at once keep both entries (the store is serialized by a lock)", async () => {
  const f = fx();
  try {
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    const mod = new URL("../review/escalation.js", import.meta.url).href;
    const startAt = Date.now() + 1500;
    const N = 8;
    const code = `
      import { recordEscalation } from ${JSON.stringify(mod)};
      const i = Number(process.argv[1]);
      while (Date.now() < ${startAt}) { /* spin to start together */ }
      try {
        await recordEscalation(${JSON.stringify(f.commonDir)}, "sha256:" + String(i).padStart(64, "0"), { item: 1, reason: "r" + i });
      } catch (e) { process.stderr.write(String(e)); process.exit(3); }
    `;
    const codes = await Promise.all(
      Array.from({ length: N }, (_, i) => new Promise<number | null>((resolve) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", code, String(i)], { stdio: "ignore" });
        c.on("close", resolve);
      })),
    );
    assert.deepEqual(codes, Array(N).fill(0));
    const { readEscalation } = await import("../review/escalation.js");
    for (let i = 0; i < N; i++) assert.deepEqual(readEscalation(f.commonDir, `sha256:${String(i).padStart(64, "0")}`), { item: 1, reason: `r${i}` }, `entry ${i}`);
    assert.deepEqual(readdirSync(join(f.commonDir, "odd-plugin")), ["review-escalations.json"], "the lock and temp files are gone");
  } finally {
    f.cleanup();
  }
});

test("a lock that cannot be taken reports not_recorded instead of blocking", async () => {
  const f = fx();
  try {
    on(f);
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    // held by a live process (this one): never stale by age
    writeFileSync(`${STORE(f)}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const a = await server(f)("review_assess", { escalate: ESC });
    assert.equal(a.isError, false);
    assert.equal(a.body.risk_level, "low");
    assert.equal(a.body.escalation, "not_recorded");
    assert.match(a.body.escalation_detail, /lock|busy/i);
    assert.equal(existsSync(STORE(f)), false);
  } finally {
    f.cleanup();
  }
});

test("a corrupt store is preserved, never silently overwritten: it is renamed once to review-escalations.json.corrupt-<timestamp> and a fresh store is written", async () => {
  const f = fx();
  try {
    on(f);
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    writeFileSync(STORE(f), "{garbage");
    // reads stay silent
    assert.deepEqual(push(f), SILENT);
    const a = await server(f)("review_assess", { escalate: ESC });
    assert.equal(a.body.escalation, "recorded");
    assert.match(a.body.escalation_detail, /corrupt/i);
    const names = readdirSync(join(f.commonDir, "odd-plugin")).sort();
    const kept = names.filter((n) => /^review-escalations\.json\.corrupt-\d+/.test(n));
    assert.equal(kept.length, 1, names.join());
    assert.equal(readFileSync(join(f.commonDir, "odd-plugin", kept[0]!), "utf8"), "{garbage");
    assert.deepEqual(names.filter((n) => !kept.includes(n)), ["review-escalations.json"]);
    assert.equal(JSON.parse(stop(f).stdout).decision, "block");
    // a second write finds a valid store: nothing more is preserved
    await server(f)("review_assess", { escalate: { item: 2, reason: "again" } });
    assert.equal(readdirSync(join(f.commonDir, "odd-plugin")).filter((n) => n.includes(".corrupt-")).length, 1);
  } finally {
    f.cleanup();
  }
});

test("review_assess is not annotated read-only: it records an escalation", async () => {
  const f = fx();
  try {
    const s = new ReviewServer({ deps: { modeOptions: { dataDir: f.data } }, cwd: f.repo });
    const res = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as Response;
    const tool = (res.result as { tools: { name: string; description: string; annotations: Record<string, unknown> }[] }).tools.find((t) => t.name === "review_assess")!;
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.doesNotMatch(tool.description, /^Read-only/);
  } finally {
    f.cleanup();
  }
});

test("degraded store end to end: whatever tier START reports, answering consent proceeds consistently (the frozen authority carries the tier, not the store)", async () => {
  for (const mode of ["dir", "busy"] as const) {
    const f = fx();
    try {
      on(f);
      mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
      if (mode === "dir") mkdirSync(STORE(f));
      else writeFileSync(`${STORE(f)}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      const call = server(f);
      const s = await call("review_start", { escalate: ESC });
      assert.equal(s.isError, false, mode);
      assert.equal(s.body.escalation, "not_recorded", mode);
      if (s.body.action === "consent_required") {
        const answer = await call("review_answer_consent", {
          target_identity: s.body.target_identity, consent: "granted", consent_binding: consentBinding(s.body.target_identity, undefined),
        });
        assert.equal(answer.isError, false, `${mode}: ${JSON.stringify(answer.body)}`);
        assert.equal(answer.body.risk_level, s.body.risk_level, `${mode}: the granted answer freezes the tier START reported`);
      } else {
        assert.equal(s.body.risk_level, "low", `${mode}: without a persisted escalation START runs at the base tier`);
        assert.equal(s.body.action, "closed");
      }
    } finally {
      f.cleanup();
    }
  }
});

test("a store from another schema version is never renamed away: not_recorded, the file is untouched", async () => {
  const f = fx();
  try {
    on(f);
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    const future = JSON.stringify({ schema: "odd-claude.review-escalations/v2", entries: [] });
    writeFileSync(STORE(f), future);
    const a = await server(f)("review_assess", { escalate: ESC });
    assert.equal(a.isError, false);
    assert.equal(a.body.escalation, "not_recorded");
    assert.match(a.body.escalation_detail, /schema|version/i);
    assert.equal(readFileSync(STORE(f), "utf8"), future);
    assert.deepEqual(readdirSync(join(f.commonDir, "odd-plugin")), ["review-escalations.json"]);
    assert.deepEqual(push(f), SILENT);
  } finally {
    f.cleanup();
  }
});

test("a store that cannot be read (EACCES) is never renamed away: not_recorded, the file is untouched", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read a mode 000 file");
  const f = fx();
  try {
    on(f);
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    const valid = JSON.stringify({ schema: "odd-claude.review-escalations/v1", entries: [] });
    writeFileSync(STORE(f), valid);
    chmodSync(STORE(f), 0o000);
    const a = await server(f)("review_assess", { escalate: ESC });
    assert.equal(a.isError, false);
    assert.equal(a.body.escalation, "not_recorded");
    assert.match(a.body.escalation_detail, /EACCES|read/i);
    assert.deepEqual(readdirSync(join(f.commonDir, "odd-plugin")), ["review-escalations.json"], "not renamed");
    chmodSync(STORE(f), 0o600);
    assert.equal(readFileSync(STORE(f), "utf8"), valid);
  } finally {
    try { chmodSync(STORE(f), 0o600); } catch { /* absent */ }
    f.cleanup();
  }
});

test("review_run on a candidate with a live lineage and no lineage_id reports ignored_existing_lineage", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    // a high-risk candidate, consented, then driven to correction_required is heavy; use the pending guard directly:
    // a first START of the escalated candidate + granted consent opens a lineage in a reviewing state
    const s = await call("review_start", { escalate: ESC });
    await call("review_answer_consent", { target_identity: s.body.target_identity, consent: "granted", consent_binding: consentBinding(s.body.target_identity, undefined) });
    // the same candidate with a live lineage and no lineage_id: no fresh START; a lineage really exists
    const r = await call("review_run", { escalate: ESC });
    assert.equal(r.body.escalation ?? r.body.error?.escalation, "ignored_existing_lineage");
  } finally {
    f.cleanup();
  }
});
