// U16 (S1, S4): contract conformance of the envelopes (moved from conformance/contract.spec.ts; the canonical-JSON vector tests are in-process and stay there).
// Every consent, start and status envelope the real MCP server emits over a real lifecycle validates against the vendored schemas with the
// documented odd differences applied as named, minimal patches (envelopes.testkit.ts); each patch is proven still needed, and the validators
// are shown to bite on corrupted envelopes (negative controls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATION_ROOT, MIRROR_ROOT } from "./impl.testkit.js";
import {
  CONSENT_PATCHES, START_PATCHES, STATUS_PATCHES, checkAckEnvelope, clone, conformEnvelope, conformToolBody, schemaViolations, type EnvelopeKind, type SchemaPatch,
} from "./envelopes.testkit.js";
import { commitHigh, commitLow, makeFakeReviewer, makeWorld, withClient, type Called, type McpClient, type World } from "./harness.testkit.js";
import { acknowledge, approveThroughCapture, decline, relay, status } from "./scenarios.testkit.js";

// ---- 2. envelopes of a real lifecycle ----

interface Corpus {
  consent: unknown[];
  start: unknown[];
  status: unknown[];
}

/** Every consent / start / status envelope seen over: low (closed, acknowledged), high (consent, group capture, ack), and a decline. */
async function gather(): Promise<Corpus> {
  const corpus: Corpus = { consent: [], start: [], status: [] };
  const record = (tool: string, r: Called): void => {
    conformToolBody(tool, r.isError, r.body);
    const schema = (r.body as { schema?: string }).schema ?? "";
    if (schema.includes(".consent/")) corpus.consent.push(r.body);
    else if (schema.includes(".start/")) corpus.start.push(r.body);
    else if (schema.includes(".status/")) corpus.status.push(r.body);
    else if ((r.body as { outcome?: string }).outcome === "consent-required") corpus.consent.push((r.body as { envelope: unknown }).envelope);
  };
  const run = async (prep: (w: World) => void, fn: (c: McpClient, w: World) => Promise<void>): Promise<void> => {
    const w = makeWorld();
    const fake = makeFakeReviewer();
    try {
      prep(w);
      await withClient({ fake, world: w }, async (c) => {
        c.observe = record;
        await fn(c, w);
      });
    } finally {
      w.cleanup();
      fake.cleanup();
    }
  };
  await run(commitLow, async (c, w) => {
    await status(c); // fresh target
    const s = await relay(c);
    await status(c); // token lost
    await status(c, { acknowledgement: s.acknowledgement }); // acknowledgement offered
    await acknowledge(c, w, s.acknowledgement);
    await status(c); // already acknowledged
  });
  await run(commitHigh, async (c, w) => {
    const { ack } = await approveThroughCapture(c, w); // consent, start (created), status (collect), forecast, captured
    await status(c, { acknowledgement: ack });
    await acknowledge(c, w, ack);
    await status(c);
  });
  await run(commitHigh, async (c, w) => {
    await decline(c, w, await relay(c));
    await status(c); // declined
  });
  return corpus;
}

let corpusP: Promise<Corpus> | undefined;
const corpus = (): Promise<Corpus> => (corpusP ??= gather());

test("the real lifecycle yields every family of envelope", async () => {
  const c = await corpus();
  assert.ok(c.consent.length >= 2 && c.start.length >= 2 && c.status.length >= 6, JSON.stringify([c.consent.length, c.start.length, c.status.length]));
  const reasons = new Set(c.status.map((s) => (s as any).next_transition.reason_code));
  for (const r of ["native_low_risk_verification", "reviewer_results_required", "approved_acknowledgement_required", "acknowledgement_token_unavailable", "target_already_acknowledged", "consent_declined"]) {
    assert.ok(reasons.has(r), `no status envelope with ${r} (saw ${[...reasons].join(", ")})`);
  }
  assert.ok(c.start.some((s) => (s as any).action === "created") && c.start.some((s) => (s as any).action === "closed"));
});

const FAMILIES: [EnvelopeKind, SchemaPatch[]][] = [
  ["consent", CONSENT_PATCHES],
  ["start", START_PATCHES],
  ["status", STATUS_PATCHES],
];

for (const [kind, patches] of FAMILIES) {
  test(`${kind}: every envelope the server emitted validates against the vendored schema with the documented patches`, async () => {
    const envelopes = (await corpus())[kind];
    for (const e of envelopes) {
      assert.deepEqual(schemaViolations(kind, e), [], JSON.stringify(e).slice(0, 300));
      assert.ok(conformEnvelope(e));
    }
    assert.equal(new Set(patches.map((p) => p.name)).size, patches.length, "patch names are unique");
    for (const p of patches) assert.ok(p.why.length > 30 && /\b(L\d+|U\d+|S\d)/.test(p.why), `${p.name} states its reason and decision`);
  });

  test(`${kind}: each documented patch is still needed (without it a real envelope fails), so the patches stay minimal`, async () => {
    const envelopes = (await corpus())[kind];
    for (const p of patches) {
      const failing = envelopes.filter((e) => schemaViolations(kind, e, p.name).length > 0);
      assert.ok(failing.length > 0, `patch ${p.name} is not needed by any envelope of the real lifecycle: drop it (or extend the lifecycle that needs it)`);
    }
  });
}

test("negative controls: corrupting a real envelope is caught by the schema (the validators bite)", async () => {
  const c = await corpus();
  const created = clone(c.start.find((s) => (s as any).action === "created")) as any;
  const mutations: [string, (e: any) => void][] = [
    ["a missing required member", (e) => delete e.selected_lenses],
    ["a foreign contract", (e) => (e.contract = "something/v9")],
    ["an unknown top-level member", (e) => (e.surprise = 1)],
    ["a malformed target identity", (e) => (e.target_identity = "sha256:xyz")],
    ["a reason code outside the vocabulary", (e) => (e.risk_reasons[0].code = "made_up")],
    ["a tree that is not a tree id", (e) => (e.candidate_tree = "nope")],
  ];
  for (const [what, mutate] of mutations) {
    const e = clone(created);
    mutate(e);
    assert.notDeepEqual(schemaViolations("start", e), [], `start: ${what}`);
  }
  const consent = clone(c.consent[0]) as any;
  consent.choices[0].invocation = "rm -rf /";
  assert.notDeepEqual(schemaViolations("consent", consent), [], "a consent choice that is not a review_answer_consent call");
  const offPath = clone(c.consent[0]) as any;
  offPath.off_path.command = "node elsewhere.js";
  assert.notDeepEqual(schemaViolations("consent", offPath), [], "an off path that is not the real review-mode CLI");
  const collect = clone(c.status.find((s) => (s as any).next_transition.kind === "collect")) as any;
  collect.next_transition.reason_code = "made_up";
  // the schema's reason-specific rules are patched out (status.reason-rules), so the vocabulary is checked against the engine's own catalogue
  assert.throws(() => conformEnvelope(collect), /stop reason|catalogued|made_up|description/, "status: a reason code outside the vocabulary");
  const noForecast = clone(c.status[0]) as any;
  delete noForecast.forecast;
  assert.throws(() => conformEnvelope(noForecast), "status: no forecast (the schema leaves it optional, odd-claude always sends one)");
  const foreign = clone(c.status[0]) as any;
  foreign.contract = "something/v9";
  assert.notDeepEqual(schemaViolations("status", foreign), [], "status: a foreign contract");
  const badTarget = clone(c.status.find((s) => (s as any).target_identity !== undefined)) as any;
  badTarget.target_identity = "nope";
  assert.notDeepEqual(schemaViolations("status", badTarget), [], "status: a malformed target identity");
});

test("negative controls: the own-shape checks (acknowledged envelope, receipt hash) bite", async () => {
  const w = makeWorld();
  const fake = makeFakeReviewer();
  try {
    commitLow(w);
    await withClient({ fake, world: w }, async (c) => {
      const s = await relay(c);
      const ack = await acknowledge(c, w, s.acknowledgement);
      checkAckEnvelope(ack);
      const forged = clone(ack);
      forged.receipt.candidate_tree = "f".repeat(40);
      assert.throws(() => checkAckEnvelope(forged), /receipt_hash/, "a receipt edited after the fact no longer re-derives");
      const unburned = clone(ack);
      unburned.burned = false;
      assert.throws(() => checkAckEnvelope(unburned));
      const other = clone(ack);
      other.target_identity = `sha256:${"1".repeat(64)}`;
      assert.throws(() => checkAckEnvelope(other));
    });
  } finally {
    w.cleanup();
    fake.cleanup();
  }
});

test("the vendored schemas used here are the byte-exact upstream files (patches live in the test, never in the fixtures)", () => {
  for (const f of ["consent-v3", "start-v4", "status-v5"]) {
    const raw = readFileSync(join(INTEGRATION_ROOT, "v2", "schemas", `${f}.schema.json`), "utf8");
    assert.ok(raw.includes(["gentle", "ai"].join("-")), `${f} still carries the upstream product prefix: the rename is applied while loading`);
  }
  assert.equal(MIRROR_ROOT.endsWith("v1.6.0"), true);
});
