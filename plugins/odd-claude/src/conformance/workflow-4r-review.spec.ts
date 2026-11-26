// T3 (S4, D2): the odd-4r-review dynamic workflow. `meta` must be a pure literal and the body must merge lens results in plain JS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../workflows/odd-4r-review.js", import.meta.url));
const source = readFileSync(FILE, "utf8");
const LENSES = ["risk", "resilience", "readability", "reliability"];

/** Index just past the brace that closes the object literal opening at `open`; strings are skipped. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced meta literal");
}
const MARK = "export const meta =";
const metaStart = source.indexOf(MARK);
const metaEnd = closingBrace(source, source.indexOf("{", metaStart));
const metaText = source.slice(metaStart + MARK.length, metaEnd);

test("workflow starts with a pure-literal meta carrying name, description, whenToUse and the two phases", () => {
  assert.equal(metaStart, 0, "meta is the first statement");
  assert.ok(!metaText.includes("${"), "no template interpolation");
  assert.ok(!/`/.test(metaText), "no template literals");
  assert.ok(!/\.\.\./.test(metaText) && !/\w\s*\(/.test(metaText.replace(/"(?:[^"\\]|\\.)*"/g, '""')), "no spread or calls");
  const meta = JSON.parse(JSON.stringify(runInContext(`(${metaText})`, createContext({}))));
  assert.equal(meta.name, "odd-4r-review");
  assert.equal(typeof meta.description, "string");
  assert.equal(typeof meta.whenToUse, "string");
  assert.deepEqual(meta.phases.map((p: { title: string }) => p.title), ["Review", "Merge"]);
});

interface Call { prompt: string; opts: { agentType: string; phase: string; label: string; schema: unknown } }
type Reply = (lens: string) => unknown;

async function run(args: unknown, reply: Reply) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const ctx = createContext({
    args,
    log: (m: string) => logs.push(m),
    phase: () => undefined,
    agent: async (prompt: string, opts: Call["opts"]) => {
      calls.push({ prompt, opts });
      return reply(opts.agentType.replace("odd-review-", ""));
    },
    parallel: async (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t().catch(() => null))),
  });
  const body = source.slice(metaEnd).replace(/^;?/, "");
  const fn = runInContext(`(async () => {\n${body}\n})`, ctx) as () => Promise<any>;
  const result = JSON.parse(JSON.stringify(await fn())); // plain realm: vm arrays fail deepEqual prototype checks
  return { result, calls, logs };
}
const row = (lens: string, id: string, severity: string, location: string, claim: string) => ({ id, lens: `review-${lens}`, location, severity, claim, evidence_class: "deterministic", causal_disposition: "introduced", proof_refs: [`changed-hunk:${location}`] });
const envelope = (lens: string, findings: unknown[]) => ({ review_result: { lens_results: [{ lens: `review-${lens}`, findings, evidence: ["e"] }] } });

test("runs one odd-review-<lens> agent per lens, in the Review phase, with range and diff in the prompt and a schema", async () => {
  const { calls, result } = await run({ diff: "diff --git a/x b/x", range: "main..HEAD" }, (l) => envelope(l, []));
  assert.deepEqual(calls.map((c) => c.opts.agentType).sort(), LENSES.map((l) => `odd-review-${l}`).sort());
  for (const c of calls) {
    assert.equal(c.opts.phase, "Review");
    assert.ok(c.opts.label.length > 0);
    assert.ok(c.opts.schema && typeof c.opts.schema === "object");
    assert.ok(c.prompt.includes("main..HEAD") && c.prompt.includes("diff --git a/x b/x"));
  }
  assert.deepEqual([...result.lenses_run].sort(), [...LENSES].sort());
  assert.deepEqual(result.lenses_failed, []);
  assert.deepEqual(result.findings, []);
  assert.equal(result.range, "main..HEAD");
  assert.equal(result.advisory, "Advisory only: this review gates nothing and approves nothing. You decide what to fix.");
});

test("a lens subset runs only those agents", async () => {
  const { calls, result } = await run({ diff: "d", range: "HEAD", lenses: ["risk", "reliability"] }, (l) => envelope(l, []));
  assert.deepEqual(calls.map((c) => c.opts.agentType).sort(), ["odd-review-reliability", "odd-review-risk"]);
  assert.deepEqual([...result.lenses_run].sort(), ["reliability", "risk"]);
});

test("merge dedupes the same location and claim across lenses, sorts by severity, and records a failed lens", async () => {
  const { result, logs } = await run({ diff: "d", range: "r" }, (l) => {
    if (l === "resilience") return null;
    if (l === "risk") return envelope(l, [row(l, "RISK-1", "WARNING", "b.ts:2", "Shared problem."), row(l, "RISK-2", "BLOCKER", "a.ts:1", "Bad thing.")]);
    if (l === "readability") return envelope(l, [row(l, "READ-1", "SUGGESTION", "c.ts:3", "Rename."), row(l, "READ-2", "WARNING", "b.ts:2", "Shared problem.")]);
    return envelope(l, []);
  });
  assert.deepEqual(result.findings.map((f: any) => [f.severity, f.location]), [["BLOCKER", "a.ts:1"], ["WARNING", "b.ts:2"], ["SUGGESTION", "c.ts:3"]]);
  assert.deepEqual([...result.findings[1].lenses].sort(), ["readability", "risk"]);
  assert.deepEqual(result.lenses_failed, ["resilience"]);
  assert.ok(!result.lenses_run.includes("resilience"));
  assert.ok(logs.some((m) => m.includes("resilience")), "failed lens is logged");
});

test("validation throws a clear Error on an empty diff, an unknown lens or an empty lens list", async () => {
  await assert.rejects(run({ diff: "  \n", range: "r" }, () => null), /empty diff/i);
  await assert.rejects(run({ range: "r" }, () => null), /empty diff/i);
  await assert.rejects(run({ diff: "d", range: "r", lenses: ["risk", "speed"] }, () => null), /unknown lens.*speed/i);
  await assert.rejects(run({ diff: "d", range: "r", lenses: [] }, () => null), /lens/i);
});
