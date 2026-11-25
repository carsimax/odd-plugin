import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, loadConfig } from "../src/index.js";

test("precedence is argv over env over file over defaults", () => {
  const cfg = resolveConfig({
    defaults: { a: "d", b: "d", c: "d", d: "d" },
    file: { b: "f", c: "f", d: "f" },
    env: { APP_C: "e", APP_D: "e" },
    argv: ["--d=a"],
  });
  assert.deepEqual(cfg, { a: "d", b: "f", c: "e", d: "a" });
});

test("objects merge deeply across layers", () => {
  const cfg = resolveConfig({
    defaults: { db: { host: "localhost", port: 5432, opts: { ssl: false } } },
    file: { db: { host: "db.internal" } },
    argv: ["--db.opts.ssl=true"],
  });
  assert.deepEqual(cfg, { db: { host: "db.internal", port: 5432, opts: { ssl: true } } });
});

test("arrays and scalars are replaced, not merged", () => {
  const cfg = resolveConfig({ defaults: { tags: ["a", "b"], x: { y: 1 } }, file: { tags: ["c"], x: 5 } });
  assert.deepEqual(cfg, { tags: ["c"], x: 5 });
});

test("env: only APP_ variables, lowercased, double underscore nests", () => {
  const cfg = resolveConfig({
    env: { APP_DB__HOST: "h", APP_LOG_LEVEL: "debug", HOME: "/root", OTHER_X: "1", APP_A__B__C: "deep" },
  });
  assert.deepEqual(cfg, { db: { host: "h" }, log_level: "debug", a: { b: { c: "deep" } } });
});

test("values are coerced: booleans, integers, decimals, negatives; the rest stays text", () => {
  const cfg = resolveConfig({
    env: { APP_ON: "true", APP_OFF: "false", APP_N: "42", APP_F: "1.5", APP_NEG: "-3", APP_S: "007x", APP_E: "" },
  });
  assert.deepEqual(cfg, { on: true, off: false, n: 42, f: 1.5, neg: -3, s: "007x", e: "" });
});

test("argv: --a.b=value, bare --flag is true, other tokens are ignored", () => {
  const cfg = resolveConfig({ argv: ["serve", "--port=8080", "--verbose", "-x", "--name=a=b", "--db.host=h"] });
  assert.deepEqual(cfg, { port: 8080, verbose: true, name: "a=b", db: { host: "h" } });
});

test("inputs are not mutated and every argument is optional", () => {
  const defaults = { db: { host: "x" } };
  const file = { db: { port: 1 } };
  const cfg = resolveConfig({ defaults, file, argv: ["--db.host=y"] });
  assert.deepEqual(defaults, { db: { host: "x" } });
  assert.deepEqual(file, { db: { port: 1 } });
  assert.deepEqual(cfg, { db: { host: "y", port: 1 } });
  assert.deepEqual(resolveConfig({}), {});
  assert.deepEqual(resolveConfig(), {});
});

test("preserved: loadConfig keeps its shallow behavior", () => {
  assert.deepEqual(loadConfig({ a: { x: 1 }, b: 2 }, { a: { y: 2 } }), { a: { y: 2 }, b: 2 });
});
