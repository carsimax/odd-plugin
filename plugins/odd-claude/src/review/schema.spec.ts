import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validate, validateFile, SchemaError } from "./schema.js";
import { INTEGRATION_ROOT, MIRROR_ROOT, PLUGIN_ROOT, REPO_ROOT, clone, listFiles, readJson } from "./fixtures.testkit.js";

const V2S = join(INTEGRATION_ROOT, "v2", "schemas");
const V2F = join(INTEGRATION_ROOT, "v2", "fixtures");
const mem = (schema: unknown, value: unknown) => validate(schema as never, value, { base: "mem://root", load: () => { throw new Error("no refs"); } });

// ---- validator unit tests -------------------------------------------------------------

test("type / enum / const / pattern / length", () => {
  assert.deepEqual(mem({ type: "string", minLength: 2, maxLength: 3, pattern: "^a" }, "abc"), []);
  assert.notDeepEqual(mem({ type: "string" }, 1), []);
  assert.notDeepEqual(mem({ type: "string", minLength: 2 }, "a"), []);
  assert.notDeepEqual(mem({ type: "string", maxLength: 1 }, "ab"), []);
  assert.notDeepEqual(mem({ type: "string", pattern: "^a" }, "ba"), []);
  assert.deepEqual(mem({ enum: ["x", 1, null] }, null), []);
  assert.notDeepEqual(mem({ enum: ["x"] }, "y"), []);
  assert.deepEqual(mem({ const: { a: [1] } }, { a: [1] }), []);
  assert.notDeepEqual(mem({ const: { a: [1] } }, { a: [2] }), []);
});

test("integer / number / boolean / null / array / object types", () => {
  assert.deepEqual(mem({ type: "integer", minimum: 0, maximum: 3 }, 3), []);
  assert.notDeepEqual(mem({ type: "integer" }, 1.5), []);
  assert.notDeepEqual(mem({ type: "integer", maximum: 3 }, 4), []);
  assert.notDeepEqual(mem({ type: "integer", minimum: 0 }, -1), []);
  assert.deepEqual(mem({ type: "number" }, 1.5), []);
  assert.notDeepEqual(mem({ type: "number" }, "1"), []);
  assert.deepEqual(mem({ type: "boolean" }, false), []);
  assert.deepEqual(mem({ type: "null" }, null), []);
  assert.notDeepEqual(mem({ type: "object" }, []), []);
  assert.notDeepEqual(mem({ type: "array" }, {}), []);
  assert.deepEqual(mem({ type: ["string", "null"] }, null), []);
});

test("object keywords", () => {
  const s = { type: "object", required: ["a"], properties: { a: { type: "string" } }, additionalProperties: false };
  assert.deepEqual(mem(s, { a: "x" }), []);
  assert.notDeepEqual(mem(s, {}), []);
  assert.notDeepEqual(mem(s, { a: 1 }), []);
  assert.notDeepEqual(mem(s, { a: "x", b: 1 }), []);
  assert.notDeepEqual(mem({ additionalProperties: { type: "integer" } }, { z: "s" }), []);
  const dep = { dependentRequired: { a: ["b"] } };
  assert.deepEqual(mem(dep, { b: 1 }), []);
  assert.deepEqual(mem(dep, { a: 1, b: 1 }), []);
  assert.notDeepEqual(mem(dep, { a: 1 }), []);
});

test("array keywords", () => {
  assert.deepEqual(mem({ type: "array", minItems: 1, maxItems: 2, items: { type: "integer" } }, [1]), []);
  assert.notDeepEqual(mem({ minItems: 1 }, []), []);
  assert.notDeepEqual(mem({ maxItems: 1 }, [1, 2]), []);
  assert.notDeepEqual(mem({ items: { type: "integer" } }, [1, "a"]), []);
  assert.notDeepEqual(mem({ uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]), []);
  assert.deepEqual(mem({ uniqueItems: true }, [1, "1", [1]]), []);
  const tuple = { prefixItems: [{ const: 1 }, { const: 2 }], items: false };
  assert.deepEqual(mem(tuple, [1, 2]), []);
  assert.deepEqual(mem(tuple, [1]), []);
  assert.notDeepEqual(mem(tuple, [1, 2, 3]), []);
  assert.notDeepEqual(mem(tuple, [2, 1]), []);
  assert.deepEqual(mem({ prefixItems: [{ const: 1 }], items: { type: "string" } }, [1, "a"]), []);
  assert.notDeepEqual(mem({ prefixItems: [{ const: 1 }], items: { type: "string" } }, [1, 2]), []);
  const contains = { contains: { const: 1 }, minContains: 2, maxContains: 3 };
  assert.deepEqual(mem(contains, [1, 1]), []);
  assert.notDeepEqual(mem(contains, [1]), []);
  assert.notDeepEqual(mem(contains, [1, 1, 1, 1]), []);
  assert.notDeepEqual(mem({ contains: { const: 1 } }, [2]), []);
});

test("combinators and conditionals", () => {
  assert.deepEqual(mem({ allOf: [{ type: "integer" }, { minimum: 2 }] }, 2), []);
  assert.notDeepEqual(mem({ allOf: [{ type: "integer" }, { minimum: 2 }] }, 1), []);
  assert.deepEqual(mem({ anyOf: [{ type: "string" }, { type: "integer" }] }, 1), []);
  assert.notDeepEqual(mem({ anyOf: [{ type: "string" }, { type: "integer" }] }, null), []);
  assert.deepEqual(mem({ oneOf: [{ type: "string" }, { type: "integer" }] }, 1), []);
  assert.notDeepEqual(mem({ oneOf: [{ type: "integer" }, { minimum: 0 }] }, 1), []); // matches both
  assert.notDeepEqual(mem({ oneOf: [{ type: "string" }] }, 1), []);
  assert.deepEqual(mem({ not: { type: "string" } }, 1), []);
  assert.notDeepEqual(mem({ not: { type: "string" } }, "a"), []);
  const cond = { if: { properties: { k: { const: 1 } }, required: ["k"] }, then: { required: ["t"] }, else: { required: ["e"] } };
  assert.deepEqual(mem(cond, { k: 1, t: 1 }), []);
  assert.notDeepEqual(mem(cond, { k: 1 }), []);
  assert.deepEqual(mem(cond, { k: 2, e: 1 }), []);
  assert.notDeepEqual(mem(cond, { k: 2 }), []);
  assert.deepEqual(mem({ if: { type: "string" } }, 1), []);
  assert.deepEqual(mem(true, 1), []);
  assert.notDeepEqual(mem(false, 1), []);
});

test("$ref: local pointer, $defs, sibling keywords and unresolved target", () => {
  const s = { $defs: { n: { type: "integer" } }, properties: { a: { $ref: "#/$defs/n", minimum: 2 } } };
  assert.deepEqual(mem(s, { a: 2 }), []);
  assert.notDeepEqual(mem(s, { a: "x" }), []);
  assert.notDeepEqual(mem(s, { a: 1 }), []);
  assert.throws(() => mem({ $ref: "#/$defs/missing" }, 1), SchemaError);
});

test("unsupported keywords fail loudly instead of passing silently", () => {
  assert.throws(() => mem({ patternProperties: {} }, {}), SchemaError);
  assert.throws(() => mem({ format: "uri" }, "x"), SchemaError);
});

test("errors carry the instance path", () => {
  const errs = mem({ properties: { a: { items: { type: "integer" } } } }, { a: [1, "x"] });
  assert.equal(errs.length > 0, true);
  assert.match(errs[0]!, /^\/a\/1: /);
});

// ---- vendored contract assets ---------------------------------------------------------

const PAIRS: Array<[string, string]> = [
  ["consent-v3", "consent-v3"],
  ["start-v4", "start-v4"],
  ["status-v5", "status-v5"],
  ["capture-result-dry-run", "capture-result-dry-run"],
];

for (const [schema, fixture] of PAIRS) {
  test(`fixture ${fixture} validates against ${schema} schema`, () => {
    const errs = validateFile(join(V2S, `${schema}.schema.json`), readJson(join(V2F, `${fixture}.fixture.json`)));
    assert.deepEqual(errs, []);
  });
}

test("every vendored v2 fixture has a vendored schema and validates", () => {
  for (const f of listFiles(V2F, ".fixture.json")) {
    const name = f.slice(V2F.length + 1).replace(/\.fixture\.json$/, "");
    assert.equal(existsSync(join(V2S, `${name}.schema.json`)), true, name);
    assert.deepEqual(validateFile(join(V2S, `${name}.schema.json`), readJson(f)), [], name);
  }
});

const SHA = "sha256:" + "a".repeat(64);
test("transition-binding schema: valid and invalid bindings", () => {
  const file = join(V2S, "transition-binding.schema.json");
  assert.deepEqual(validateFile(file, { target_identity: SHA }), []);
  assert.deepEqual(validateFile(file, { lineage_id: "my-lineage-1", revision: SHA, target_identity: SHA, repository_context: "rctx1_" + "0".repeat(64) }), []);
  assert.notDeepEqual(validateFile(file, {}), []);
  assert.notDeepEqual(validateFile(file, { target_identity: "sha256:xyz" }), []);
  assert.notDeepEqual(validateFile(file, { target_identity: SHA, extra: 1 }), []);
  assert.notDeepEqual(validateFile(file, { target_identity: SHA, lineage_id: "Bad_Lineage" }), []);
  assert.notDeepEqual(validateFile(file, { target_identity: SHA, repository_context: "rctx1_short" }), []);
});

test("mutated fixtures fail", () => {
  const cases: Array<[string, string, (v: any) => void]> = [
    ["consent-v3", "consent-v3", (v) => delete v.choices],
    ["consent-v3", "consent-v3", (v) => { v.choices = [v.choices[1], v.choices[0]]; }],
    ["consent-v3", "consent-v3", (v) => { v.risk_level = "low"; }],
    ["consent-v3", "consent-v3", (v) => { v.target_identity = "sha256:ABC"; }],
    ["consent-v3", "consent-v3", (v) => { v.extra = true; }],
    ["start-v4", "start-v4", (v) => delete v.lineage_id],
    ["start-v4", "start-v4", (v) => { v.state = "bogus"; }],
    ["start-v4", "start-v4", (v) => { v.selected_lenses = ["review-risk", "review-risk"]; }],
    ["start-v4", "start-v4", (v) => { v.correction_budget = 201; }],
    ["start-v4", "start-v4", (v) => { v.base_tree = "zz"; }],
    ["status-v5", "status-v5", (v) => delete v.candidates],
    ["status-v5", "status-v5", (v) => { v.target_identity = "nope"; }],
    ["status-v5", "status-v5", (v) => { v.contract = "other/v1"; }],
    ["status-v5", "status-v5", (v) => { v.surprise = 1; }],
    ["capture-result-dry-run", "capture-result-dry-run", (v) => { v.validation = "rejected"; }],
    ["capture-result-dry-run", "capture-result-dry-run", (v) => { v.selected_order = 4; }],
    ["capture-result-dry-run", "capture-result-dry-run", (v) => { v.lens = "review-other"; }],
    ["capture-result-dry-run", "capture-result-dry-run", (v) => delete v.subject_hash],
  ];
  for (const [schema, fixture, mutate] of cases) {
    const value = clone(readJson(join(V2F, `${fixture}.fixture.json`)));
    assert.deepEqual(validateFile(join(V2S, `${schema}.schema.json`), value), []);
    mutate(value);
    assert.notDeepEqual(validateFile(join(V2S, `${schema}.schema.json`), value), [], mutate.toString());
  }
});

const MIRROR: Array<[string, string]> = [
  ["lens", "lens"],
  ["refuter", "refuter"],
  ["targeted-validator", "targeted-validator"],
];
for (const [schema, vector] of MIRROR) {
  test(`provider mirror vector ${vector} validates against its schema`, () => {
    const s = join(MIRROR_ROOT, "schemas", `${schema}.schema.json`);
    const v = readJson(join(MIRROR_ROOT, "vectors", `${vector}.json`));
    assert.deepEqual(validateFile(s, v), []);
    const bad = clone(v) as Record<string, unknown>;
    bad.unexpected = 1;
    assert.notDeepEqual(validateFile(s, bad), []);
    const noHash = clone(v) as Record<string, unknown>;
    delete noHash[Object.keys(noHash)[0]!];
    assert.notDeepEqual(validateFile(s, noHash), []);
  });
}

test("lens vector: bad subject hash and unavailable-without-reason fail", () => {
  const s = join(MIRROR_ROOT, "schemas", "lens.schema.json");
  const v: any = clone(readJson(join(MIRROR_ROOT, "vectors", "lens.json")));
  v.subject_hash = "sha256:123";
  assert.notDeepEqual(validateFile(s, v), []);
  const u: any = clone(readJson(join(MIRROR_ROOT, "vectors", "lens.json")));
  u.inspection = { status: "unavailable", paths: [] };
  assert.notDeepEqual(validateFile(s, u), []);
  u.inspection.reason = "could not read";
  assert.deepEqual(validateFile(s, u), []);
});

// ---- fixtures are not shipped ---------------------------------------------------------

test("vendored fixtures live outside the plugin directory and never reach dist", () => {
  assert.equal(existsSync(join(PLUGIN_ROOT, "test-fixtures")), false);
  assert.equal(existsSync(join(REPO_ROOT, "test-fixtures", "review", "SOURCES.md")), true);
  assert.equal(existsSync(join(PLUGIN_ROOT, "dist", "test-fixtures")), false);
  const stack = [join(PLUGIN_ROOT, "dist")];
  const leaked: string[] = [];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (/\.(fixture|schema)\.json$/.test(e) || e === "SOURCES.md") leaked.push(p);
    }
  }
  assert.deepEqual(leaked, []);
});
