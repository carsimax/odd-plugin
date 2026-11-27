// U16 (S1, S4): canonical JSON and the odd-claude domain hash are pinned by vectors derived INDEPENDENTLY (python json.dumps with sorted keys,
// hashlib) over the vendored provider-mirror vectors and integration fixtures, and they round-trip. (In-process: they call the engine directly.
// The black-box envelope conformance of the same file lives in contract/contract.spec.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, domainHash } from "../review/canonical.js";
import { INTEGRATION_ROOT } from "../review/fixtures.testkit.js";

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
