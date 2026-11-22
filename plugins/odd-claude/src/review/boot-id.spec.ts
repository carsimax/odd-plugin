import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BootReaders, SYSCTL_PATH, isBootId, parseLinuxBoot, parseMacBoot, readBootId } from "./boot-id.js";

const U = "4fd77cbd-1111-4222-8333-444455556666";

function readers(over: Partial<BootReaders>): BootReaders {
  return { platform: "linux", readText: () => undefined, readLink: () => undefined, sysctl: () => undefined, ...over };
}

test("Linux: boot_id + pid namespace are joined", () => {
  assert.equal(parseLinuxBoot(`${U}\n`, "pid:[4026531836]"), `${U}/pid:[4026531836]`);
  const r = readers({ readText: (p) => (p === "/proc/sys/kernel/random/boot_id" ? `${U}\n` : undefined), readLink: (p) => (p === "/proc/self/ns/pid" ? "pid:[4026531836]" : undefined) });
  assert.equal(readBootId(r), `${U}/pid:[4026531836]`);
});

test("Linux: two pid namespaces of the same boot differ", () => {
  assert.notEqual(parseLinuxBoot(U, "pid:[4026531836]"), parseLinuxBoot(U, "pid:[4026532999]"));
});

test("Linux: garbage, oversized, missing parts are undefined", () => {
  assert.equal(parseLinuxBoot("garbage", "pid:[1]"), undefined);
  assert.equal(parseLinuxBoot(`${"a".repeat(500)}`, "pid:[1]"), undefined);
  assert.equal(parseLinuxBoot(U, "net:[1]"), undefined);
  assert.equal(parseLinuxBoot(U, "pid:[x]"), undefined);
  assert.equal(parseLinuxBoot(U, undefined), undefined);
  assert.equal(parseLinuxBoot(undefined, "pid:[1]"), undefined);
  assert.equal(readBootId(readers({ readText: () => "garbage", readLink: () => "pid:[1]" })), undefined);
});

test("macOS: kern.bootsessionuuid; garbage and failures are undefined", () => {
  assert.equal(parseMacBoot(`${U.toUpperCase()}\n`), `mac:${U}`);
  assert.equal(readBootId(readers({ platform: "darwin", sysctl: (n) => (n === "kern.bootsessionuuid" ? `${U}\n` : undefined) })), `mac:${U}`);
  assert.equal(parseMacBoot("nope"), undefined);
  assert.equal(parseMacBoot("x".repeat(10_000)), undefined);
  assert.equal(parseMacBoot(undefined), undefined);
  assert.equal(readBootId(readers({ platform: "darwin" })), undefined);
});

test("other platforms and throwing readers are undefined, never throw", () => {
  assert.equal(readBootId(readers({ platform: "win32" })), undefined);
  assert.equal(
    readBootId(readers({ readText: () => { throw new Error("boom"); } })),
    undefined,
  );
});

test("isBootId is strict", () => {
  assert.ok(isBootId(`${U}/pid:[4026531836]`));
  assert.ok(!isBootId(""));
  assert.ok(!isBootId("a b"));
  assert.ok(!isBootId("x".repeat(129)));
  assert.ok(!isBootId(5));
});

test("sysctl is spawned by absolute path (no PATH lookup)", () => {
  assert.equal(SYSCTL_PATH, "/usr/sbin/sysctl");
  assert.ok(isAbsolute(SYSCTL_PATH));
});

test("darwin: a fake sysctl first on PATH is never spawned", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-fake-sysctl-"));
  try {
    const FAKE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const marker = join(dir, "marker");
    const fake = join(dir, "sysctl");
    writeFileSync(fake, `#!/bin/sh\necho ran > '${marker}'\necho ${FAKE}\n`);
    chmodSync(fake, 0o755);
    const mod = fileURLToPath(new URL("./boot-id.js", import.meta.url));
    const r = spawnSync(process.execPath, ["-e", `import(process.argv[1]).then((m) => process.stdout.write(String(m.bootId())))`, `file://${mod}`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(marker), false, "the fake sysctl from PATH ran");
    assert.ok(!r.stdout.includes(FAKE), r.stdout);
    assert.match(r.stdout, /^mac:[0-9a-f-]{36}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
