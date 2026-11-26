import { test } from "node:test";
import assert from "node:assert/strict";
import { collectDoctor, renderDoctor, parseVersion, nodeSatisfies, type DoctorDeps } from "./doctor.js";
import { doctorCli } from "../cli/doctor.js";

function deps(over: Partial<DoctorDeps> & { present?: Record<string, string> } = {}): DoctorDeps {
  const present = over.present ?? { git: "git version 2.40.1", engram: "engram 3.7.0", codegraph: "1.6.2" };
  return {
    exec: (cmd) => present[cmd],
    env: { CLAUDE_PLUGIN_DATA: "/data/odd" },
    nodeVersion: "v22.1.0",
    version: "0.1.0",
    installedPlugins: () => ["engram@engram"],
    installedVersion: () => "0.1.0",
    hooksInstalled: () => true,
    isWritable: () => true,
    ...over,
  };
}

test("parseVersion extracts the first semver and nodeSatisfies enforces >=22", () => {
  assert.equal(parseVersion("git version 2.40.1 (Apple)"), "2.40.1");
  assert.equal(parseVersion("no digits"), undefined);
  assert.equal(nodeSatisfies("v22.0.0"), true);
  assert.equal(nodeSatisfies("v21.9.9"), false);
  assert.equal(nodeSatisfies("garbage"), false);
});

test("all present: every item ok, nothing missing", () => {
  const r = collectDoctor(deps());
  assert.deepEqual(r.items.map((i) => [i.id, i.status]), [
    ["node", "ok"], ["git", "ok"], ["engram", "ok"], ["codegraph", "ok"], ["install", "ok"], ["hooks", "ok"], ["data-dir", "ok"],
  ]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.requiredMissing, []);
  assert.equal(r.ok, true);
  const text = renderDoctor(r);
  assert.match(text, /^missing: none$/m);
  assert.match(text, /git .*2\.40\.1/);
  assert.match(text, /^odd-claude doctor \(v0\.1\.0\)$/m);
});

test("install: reports the installed odd version; missing install or hooks are optional, listed and keep the report ok", () => {
  const ok = collectDoctor(deps({ installedVersion: () => "6.0.0" }));
  assert.match(ok.items.find((i) => i.id === "install")?.detail ?? "", /6\.0\.0/);
  const none = collectDoctor(deps({ installedVersion: () => undefined, hooksInstalled: () => false }));
  const byId = (id: string) => none.items.find((i) => i.id === id);
  assert.deepEqual([byId("install")?.status, byId("install")?.required, byId("hooks")?.status, byId("hooks")?.required], ["missing", false, "missing", false]);
  assert.match(byId("install")?.detail ?? "", /odd-claude install/);
  assert.deepEqual(none.missing, ["install", "hooks"]);
  assert.equal(none.ok, true);
  assert.equal(collectDoctor(deps({ hooksInstalled: () => undefined })).items.find((i) => i.id === "hooks")?.status, "missing");
});

test("missing optional (engram, codegraph): listed but report stays ok", () => {
  const r = collectDoctor(deps({ present: { git: "git version 2.40.1" }, installedPlugins: () => [] }));
  assert.deepEqual(r.missing, ["engram", "codegraph"]);
  assert.deepEqual(r.requiredMissing, []);
  assert.equal(r.ok, true);
  assert.match(renderDoctor(r), /^missing: engram, codegraph$/m);
});

test("engram counts as present with only the plugin or only the binary", () => {
  const onlyPlugin = collectDoctor(deps({ present: { git: "git version 2" } }));
  assert.equal(onlyPlugin.items.find((i) => i.id === "engram")?.status, "ok");
  const onlyBin = collectDoctor(deps({ installedPlugins: () => undefined }));
  assert.equal(onlyBin.items.find((i) => i.id === "engram")?.status, "ok");
});

test("missing required (git, old node): ok false and requiredMissing lists them", () => {
  const r = collectDoctor(deps({ present: {}, nodeVersion: "v18.0.0", installedPlugins: () => [] }));
  assert.deepEqual(r.requiredMissing, ["node", "git"]);
  assert.equal(r.ok, false);
  assert.match(renderDoctor(r), /^missing: node, git, engram, codegraph$/m);
});

test("data dir: resolved through the shared order; unset env falls back to the home default; non-writable is missing (optional)", () => {
  const unset = collectDoctor(deps({ env: { ODD_CLAUDE_HOME: "/h/odd" } }));
  const item = unset.items.find((i) => i.id === "data-dir");
  assert.equal(item?.status, "ok");
  assert.match(item?.detail ?? "", /\/h\/odd\/data/);
  const viaEnv = collectDoctor(deps({ env: { ODD_CLAUDE_DATA: "/x/d", CLAUDE_PLUGIN_DATA: "/y/d" } }));
  assert.match(viaEnv.items.find((i) => i.id === "data-dir")?.detail ?? "", /\/x\/d/);
  const ro = collectDoctor(deps({ isWritable: () => false }));
  assert.equal(ro.items.find((i) => i.id === "data-dir")?.status, "missing");
  assert.equal(ro.ok, true);
});

test("cli --json prints the report shape; exit 0 when only optionals are missing", () => {
  const res = doctorCli(["--json"], deps({ present: { git: "git version 2" }, installedPlugins: () => [] }));
  assert.equal(res.exitCode, 0);
  const j = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(j).sort(), ["items", "missing", "ok", "requiredMissing", "schema", "version"]);
  assert.equal(j.schema, 1);
  assert.deepEqual(Object.keys(j.items[0]).sort(), ["detail", "id", "label", "required", "status"]);
  assert.deepEqual(j.missing, ["engram", "codegraph"]);
});

test("cli exits 1 when required items are missing, text and json; 0 never hides the list", () => {
  const text = doctorCli([], deps({ present: {}, installedPlugins: () => [] }));
  assert.equal(text.exitCode, 1);
  assert.match(text.stdout, /missing: git, engram, codegraph/);
  assert.equal(doctorCli(["--json"], deps({ present: {} })).exitCode, 1);
  assert.equal(doctorCli([], deps()).exitCode, 0);
});

test("cli --data-dir replaces CLAUDE_PLUGIN_DATA when probing the data dir", () => {
  const seen: string[] = [];
  const res = doctorCli(["--json", "--data-dir", "/x/y"], deps({ env: {}, isWritable: (d) => (seen.push(d), true) }));
  assert.deepEqual(seen, ["/x/y", "/x/y"]);
  assert.equal(JSON.parse(res.stdout).items.find((i: { id: string }) => i.id === "data-dir").status, "ok");
});
