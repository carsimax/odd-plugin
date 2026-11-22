import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMachineId, loadMachineId, stateHome } from "./machine-id.js";

const MODULE = fileURLToPath(new URL("./machine-id.js", import.meta.url));

function tmp(): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-machine-id-"));
  return { dir, file: join(dir, "odd-plugin", "machine-id"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("created once (0600, regular, uuid) and reused", () => {
  const t = tmp();
  try {
    const a = loadMachineId(t.dir);
    assert.ok(isMachineId(a));
    const st = statSync(t.file);
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(loadMachineId(t.dir), a);
    assert.equal(readFileSync(t.file, "utf8").trim(), a);
    assert.deepEqual(readdirSync(join(t.dir, "odd-plugin")), ["machine-id"]);
  } finally {
    t.done();
  }
});

for (const [name, content] of [
  ["corrupt", "hello\n"],
  ["empty", ""],
  ["oversized", `${"a".repeat(200)}\n`],
  ["uppercase uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n"],
] as const) {
  test(`${name} file: undefined (hostname fallback), never throws, file untouched`, () => {
    const t = tmp();
    try {
      mkdirSync(join(t.dir, "odd-plugin"), { recursive: true });
      writeFileSync(t.file, content);
      assert.equal(loadMachineId(t.dir), undefined);
      assert.equal(readFileSync(t.file, "utf8"), content);
    } finally {
      t.done();
    }
  });
}

test("a hardlinked file (nlink > 1) is rejected", () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "odd-plugin"), { recursive: true });
    const other = join(t.dir, "other");
    writeFileSync(other, "33333333-3333-4333-8333-333333333333\n");
    linkSync(other, t.file);
    assert.equal(loadMachineId(t.dir), undefined);
  } finally {
    t.done();
  }
});

test("symlinked file is never followed", () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "odd-plugin"), { recursive: true });
    const target = join(t.dir, "target");
    writeFileSync(target, "33333333-3333-4333-8333-333333333333\n");
    symlinkSync(target, t.file);
    assert.equal(loadMachineId(t.dir), undefined);
  } finally {
    t.done();
  }
});

test("symlinked odd-plugin directory is never followed", () => {
  const t = tmp();
  try {
    const real = join(t.dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(t.dir, "odd-plugin"));
    assert.equal(loadMachineId(t.dir), undefined);
    assert.deepEqual(readdirSync(real), []);
  } finally {
    t.done();
  }
});

test("unreadable file and unusable state dir: undefined, never throws", () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "odd-plugin"), { recursive: true });
    writeFileSync(t.file, "33333333-3333-4333-8333-333333333333\n");
    chmodSync(t.file, 0o000);
    if (process.getuid?.() !== 0) assert.equal(loadMachineId(t.dir), undefined);
    chmodSync(t.file, 0o600);
    const blocker = join(t.dir, "blocker");
    writeFileSync(blocker, "x");
    assert.equal(loadMachineId(join(blocker, "sub")), undefined); // ENOTDIR
  } finally {
    t.done();
  }
});

test("stateHome honors an absolute XDG_STATE_HOME only", () => {
  assert.equal(stateHome({ XDG_STATE_HOME: "/x/y" }), "/x/y");
  assert.notEqual(stateHome({ XDG_STATE_HOME: "relative" }), "relative");
  assert.ok(stateHome({}) === undefined || stateHome({}) !== "");
});

test("concurrent first creation by several processes yields one id", async () => {
  const t = tmp();
  try {
    const script = `import(process.argv[1]).then((m) => process.stdout.write(String(m.loadMachineId(process.argv[2]))));`;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const c = spawn(process.execPath, ["-e", script, `file://${MODULE}`, t.dir], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("error", reject);
        c.on("close", () => resolve(out));
      });
    const ids = await Promise.all(Array.from({ length: 8 }, run));
    assert.ok(isMachineId(ids[0]), `ids: ${ids.join(",")}`);
    assert.deepEqual([...new Set(ids)], [ids[0]]);
    assert.equal(readFileSync(t.file, "utf8").trim(), ids[0]);
    assert.deepEqual(readdirSync(join(t.dir, "odd-plugin")), ["machine-id"]);
  } finally {
    t.done();
  }
});

test("B2: concurrent first creation never yields undefined (nlink window), 20 rounds", async () => {
  const script = `import(process.argv[1]).then((m) => process.stdout.write(String(m.loadMachineId(process.argv[2]))));`;
  const run = (dir: string) =>
    new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ["-e", script, `file://${MODULE}`, dir], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", reject);
      c.on("close", () => resolve(out));
    });
  for (let round = 0; round < 20; round++) {
    const t = tmp();
    try {
      const ids = await Promise.all(Array.from({ length: 8 }, () => run(t.dir)));
      assert.ok(isMachineId(ids[0]), `round ${round}: ${ids.join(",")}`);
      assert.deepEqual([...new Set(ids)], [ids[0]], `round ${round}: ${ids.join(",")}`);
    } finally {
      t.done();
    }
  }
});

test("B2: machineId() does not cache a failure and caches the first success", () => {
  const t = tmp();
  try {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const script = `
      const fs = require("node:fs");
      import(process.argv[1]).then((m) => {
        const [file, other] = [process.argv[2], process.argv[3]];
        fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
        fs.writeFileSync(other, "${A}\\n");
        fs.linkSync(other, file); // persistent hardlink: nlink 2
        const r1 = m.machineId();
        fs.unlinkSync(other);
        const r2 = m.machineId();
        fs.writeFileSync(file, "${B}\\n");
        const r3 = m.machineId();
        process.stdout.write(JSON.stringify([r1 ?? null, r2 ?? null, r3 ?? null]));
      });`;
    const r = spawnSync(process.execPath, ["-e", script, `file://${MODULE}`, t.file, join(t.dir, "other")], {
      env: { ...process.env, XDG_STATE_HOME: t.dir },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [null, A, A]);
  } finally {
    t.done();
  }
});

test("B2: a persistent hardlink gives up within a bound", () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "odd-plugin"), { recursive: true });
    const other = join(t.dir, "other");
    writeFileSync(other, "33333333-3333-4333-8333-333333333333\n");
    linkSync(other, t.file);
    const t0 = performance.now();
    assert.equal(loadMachineId(t.dir), undefined);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
  } finally {
    t.done();
  }
});
