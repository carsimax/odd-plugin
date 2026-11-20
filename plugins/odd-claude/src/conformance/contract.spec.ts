// U16 (S1, S4): contract conformance.
//  1. Canonical JSON and the odd-claude domain hash are pinned by vectors derived INDEPENDENTLY (python json.dumps with sorted keys, hashlib)
//     over the vendored provider-mirror vectors and integration fixtures, and they round-trip.
//  2. Every consent, start and status envelope the real MCP server emits over a real lifecycle validates against the vendored schemas with the
//     documented odd differences applied as named, minimal patches (envelopes.testkit.ts); each patch is proven still needed, and the validators
//     are shown to bite on corrupted envelopes (negative controls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, domainHash } from "../review/canonical.js";
import { MIRROR_ROOT, INTEGRATION_ROOT, clone } from "../review/fixtures.testkit.js";
import {
  CONSENT_PATCHES, START_PATCHES, STATUS_PATCHES, checkAckEnvelope, conformEnvelope, conformToolBody, schemaViolations, type EnvelopeKind, type SchemaPatch,
} from "./envelopes.testkit.js";
import { commitHigh, commitLow, makeFakeReviewer, makeWorld, withClient, type Called, type McpClient, type World } from "./harness.testkit.js";
import { acknowledge, approveThroughCapture, decline, relay, status } from "./scenarios.testkit.js";

// ---- 1. canonical JSON and domain hash vectors ----

/** An independent canonicalizer: sorted keys (UTF-16 code unit order), no whitespace, JSON.stringify for scalars. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const sha = (domainText: string, text: string): string => `sha256:${createHash("sha256").update(`${domainText}\0${text}`, "utf8").digest("hex")}`;
const reversed = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(reversed);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, reversed(x)]));
  return v;
};

// [file under test-fixtures/review/vendor, canonical byte length, sha256 of "odd-claude.conformance-vector/v1\0" + canonical text]
// Derived with `python3`: json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False) and hashlib.sha256.
const VECTORS: [string, number, string][] = [
  ["provider-mirror/v1.6.0/vectors/lens.json", 225, "sha256:2ec9ae165cd948ff65dc8b252612c867c776a3ccd14f0e35065aff68e8d04087"],
  ["provider-mirror/v1.6.0/vectors/refuter.json", 111, "sha256:6ce8a6bde20aec6282cc80140687167a8ace5809ffaea9ae68a26aaadb558548"],
  ["provider-mirror/v1.6.0/vectors/targeted-validator.json", 381, "sha256:9be671bb34918d5d499d04c1b3a5d8ca75463fff59ff03cc4fcaac3badb945b7"],
  ["review-integration/v2/fixtures/capture-result-dry-run.fixture.json", 314, "sha256:367cf9d28dc442957588481f8629ea6f982b02365724592098e2966fc5a95f7b"],
  ["review-integration/v2/fixtures/consent-v3.fixture.json", 1987, "sha256:d7ee7ef9162a0d5c25b9ecda2dbd6c509af31af5f2e673ab49422f24d5c2f797"],
  ["review-integration/v2/fixtures/start-v4.fixture.json", 5001, "sha256:612ae098aa74a572c021d363dc98ef121a83c0118e0c5030efcce2441749b06e"],
  ["review-integration/v2/fixtures/status-v5.fixture.json", 1965, "sha256:e60d01b8d26d8a438409b41ab8b8ee601d91b26be39ac12cde5e322a68249597"],
];
const VENDOR = join(INTEGRATION_ROOT, "..");

for (const [file, length, hash] of VECTORS) {
  test(`vector ${file}: canonical text, domain hash and round trip`, () => {
    const doc = JSON.parse(readFileSync(join(VENDOR, file), "utf8")) as unknown;
    const text = canonicalJson(doc);
    assert.equal(text, canon(doc), "the engine's canonical form is the independent one");
    assert.equal(Buffer.byteLength(text), length);
    assert.equal(domainHash("conformance-vector", 1, doc), hash, "pinned hash (derived with python)");
    assert.equal(domainHash("conformance-vector", 1, doc), sha("odd-claude.conformance-vector/v1", text));
    assert.deepEqual(JSON.parse(text), doc, "canonical text round-trips");
    assert.equal(canonicalJson(JSON.parse(text)), text, "canonicalization is idempotent");
    assert.equal(domainHash("conformance-vector", 1, reversed(doc)), hash, "key order never matters");
    assert.notEqual(domainHash("conformance-vector", 2, doc), hash, "the version separates");
    assert.notEqual(domainHash("conformance-other", 1, doc), hash, "the domain separates");
    // the upstream product's domain never collides with ours
    assert.notEqual(sha(`${["gentle", "ai"].join("-")}.conformance-vector/v1`, text), hash);
  });
}

test("canonical text is UTF-16 ordered and escapes like JSON, on the hard cases (independent of the engine)", () => {
  const doc = { "10": 1, "9": 2, b: [{ "é": 1, z: 0, Z: -0 }], a: "\u0000\"\\é😀", "": null };
  assert.equal(canonicalJson(doc), '{"":null,"10":1,"9":2,"a":"\\u0000\\"\\\\é😀","b":[{"Z":0,"z":0,"é":1}]}');
  assert.equal(canonicalJson(doc), canon(doc));
});

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
