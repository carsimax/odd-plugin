import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, canonicalBytes, domainHash, CanonicalError } from "./canonical.js";

// Vectors: [domain, version, input value, expected canonical text, expected hash].
// Hashes were derived independently from the canonical text with node:crypto
// (SHA-256 over "odd-claude.<domain>/v<version>\0" + canonical text).
const VECTORS: Array<[string, number, unknown, string, string]> = [
  ["review-state", 2, {}, "{}", "sha256:b7d5152c4127f29578aa4cecfa4cb6b2b8232db4ff5c41c434bb8ad354f18d74"],
  ["review-state", 2, { b: 1, a: 2 }, '{"a":2,"b":1}', "sha256:308345c9fe8ffadd2b1f7c1ce9897ab6000f0d8f7b654ed012fa23090593d705"],
  ["lens-result", 1, { k: "héllo ✓ 😀" }, '{"k":"héllo ✓ 😀"}', "sha256:a8ace900d1d303672ca376350376ffcf567302c18434d3fd5c19b588a400cd95"],
  ["paths", 1, [[1, [2, []]], { z: [{ b: null, a: true }] }], '[[1,[2,[]]],{"z":[{"a":true,"b":null}]}]', "sha256:8f5bda9c065adc632aba2b3fb3afaf15572017720b0d1a7ae760d16c05c972fa"],
  ["paths", 1, -0, "0", "sha256:4223c6ff2cd5e70a7b002a5478f4f5427eb7fb03eb0e3f3e23b3bf22fea8a7f0"],
  ["paths", 1, "\u0000\n\"\\", '"\\u0000\\n\\"\\\\"', "sha256:1271f60a00e80a25087b8ce9185a1de6ed729f361c2b6da26f0ea0a5b1e0b36a"],
  ["paths", 1, [1e21, 0.1, 1e-7], "[1e+21,0.1,1e-7]", "sha256:9a08f49845448054ee409ebbfa173136800eb07ec65cedbab030f1de3dde7eb5"],
  ["review-snapshot", 4, { é: 3, a: { b: { c: [] } }, _: 2, B: 1 }, '{"B":1,"_":2,"a":{"b":{"c":[]}},"é":3}', "sha256:e84338778d35cc51051ef57cf891abd7c59a86894dc39b2bac6ba8fbe65cb41b"],
];

for (const [domain, version, value, text, hash] of VECTORS) {
  test(`vector ${domain}/v${version} ${text.slice(0, 30)}`, () => {
    assert.equal(canonicalJson(value), text);
    assert.equal(domainHash(domain, version, value), hash);
  });
}

test("canonicalBytes is the UTF-8 encoding of the canonical text", () => {
  const bytes = canonicalBytes({ k: "é😀" });
  assert.deepEqual([...bytes], [...Buffer.from('{"k":"é😀"}', "utf8")]);
  assert.equal(bytes.byteLength, 14);
});

test("key order never changes the hash; array order does", () => {
  assert.equal(domainHash("x", 1, { a: 1, b: { d: 1, c: 2 } }), domainHash("x", 1, { b: { c: 2, d: 1 }, a: 1 }));
  assert.notEqual(domainHash("x", 1, [1, 2]), domainHash("x", 1, [2, 1]));
});

test("domain and version separate hashes", () => {
  const v = { a: 1 };
  assert.notEqual(domainHash("x", 1, v), domainHash("y", 1, v));
  assert.notEqual(domainHash("x", 1, v), domainHash("x", 2, v));
});

test("output is sha256:<64 lowercase hex>", () => {
  assert.match(domainHash("x", 1, null), /^sha256:[0-9a-f]{64}$/);
});

test("accepts null, booleans, null-prototype objects and shared (non-cyclic) references", () => {
  const shared = { n: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared, c: null, d: false }), '{"a":{"n":1},"b":{"n":1},"c":null,"d":false}');
  const bare = Object.create(null) as Record<string, unknown>;
  bare.z = 1;
  assert.equal(canonicalJson(bare), '{"z":1}');
});

test("rejects undefined (top level, object member, array item, sparse hole)", () => {
  assert.throws(() => canonicalJson(undefined), CanonicalError);
  assert.throws(() => canonicalJson({ a: undefined }), CanonicalError);
  assert.throws(() => canonicalJson([1, undefined]), CanonicalError);
  assert.throws(() => canonicalJson(new Array(2)), CanonicalError);
});

test("rejects NaN and Infinity", () => {
  for (const n of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalJson(n), CanonicalError);
    assert.throws(() => canonicalJson({ n }), CanonicalError);
  }
});

test("rejects functions, symbols, bigint and non-plain objects", () => {
  assert.throws(() => canonicalJson(() => 1), CanonicalError);
  assert.throws(() => canonicalJson({ f() {} }), CanonicalError);
  assert.throws(() => canonicalJson(Symbol("s")), CanonicalError);
  assert.throws(() => canonicalJson(1n), CanonicalError);
  assert.throws(() => canonicalJson(new Date(0)), CanonicalError);
  assert.throws(() => canonicalJson(new Map()), CanonicalError);
});

test("rejects cycles", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  assert.throws(() => canonicalJson(o), CanonicalError);
  const a: unknown[] = [];
  a.push([a]);
  assert.throws(() => canonicalJson(a), CanonicalError);
});

test("rejects invalid domains and versions", () => {
  for (const d of ["", "Review", "a b", "a/b", "a\0b", "-a", "a-"]) assert.throws(() => domainHash(d, 1, {}), CanonicalError, d);
  for (const v of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => domainHash("x", v, {}), CanonicalError, String(v));
});
