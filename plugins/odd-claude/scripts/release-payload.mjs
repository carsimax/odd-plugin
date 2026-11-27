#!/usr/bin/env node
// Builds the release assets: odd-claude-payload-<version>.tar.gz, odd-claude.mjs, and checksums.txt.
// Usage: node scripts/release-payload.mjs --version <v> --out <dir> --bundle <path>
// Runs the build first and fails when dist/ differs from the committed one.
// The tarball is written in-process (ustar + gzip) so it is byte-identical across platforms and runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PAYLOAD_ITEMS, assertVersion, readTree } from "../dist/installer/payload.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  process.stderr.write(`release-payload: ${msg}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const version = opt("--version");
const outArg = opt("--out");
const bundle = opt("--bundle");
if (!version) fail("--version <v> is required");
if (!outArg) fail("--out <dir> is required");
try {
  assertVersion(version);
} catch (e) {
  fail(e.message);
}
if (!bundle) fail("--bundle <path> is required");
if (!existsSync(bundle)) fail(`bundle not found: ${bundle}`);

// A stale committed dist/ must never ship: rebuild, then require git to see no modified, deleted or untracked file under dist/.
const sh = (cmd, a) => spawnSync(cmd, a, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
const built = sh("npm", ["run", "build"]);
if (built.status !== 0) fail(`build failed:\n${built.stdout}${built.stderr}`);
const drift = sh("git", ["status", "--porcelain", "--", "dist"]);
if (drift.status !== 0 || drift.stdout.trim() !== "") fail("dist/ is stale: run `npm run build` and commit dist/");

const top = `odd-claude-${version}`;

// Raw payload files (placeholders stay unresolved; staging resolves them at install time), in sorted order.
const files = new Map();
for (const item of PAYLOAD_ITEMS) {
  const abs = join(root, item);
  if (!existsSync(abs)) continue;
  if (statSync(abs).isDirectory()) for (const [rel, f] of readTree(abs)) files.set(`${item}/${rel}`, f);
  else files.set(item, { data: readFileSync(abs), mode: statSync(abs).mode & 0o777 });
}
if (files.size === 0) fail(`no payload found under ${root}`);

const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
function header(name, size, mode, type) {
  const h = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) fail(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100);
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155);
  const sum = [...h].reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

const chunks = [];
const dirs = new Set([top]);
for (const rel of files.keys()) {
  const parts = `${top}/${rel}`.split("/");
  for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
}
const entries = [...[...dirs].map((d) => [`${d}/`, null]), ...[...files].map(([rel, f]) => [`${top}/${rel}`, f])].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
for (const [name, f] of entries) {
  if (!f) {
    chunks.push(header(name, 0, 0o755, "5"));
    continue;
  }
  chunks.push(header(name, f.data.length, f.mode & 0o111 ? 0o755 : 0o644, "0"), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
}
chunks.push(Buffer.alloc(1024));
const tgz = gzipSync(Buffer.concat(chunks), { level: 9 });

const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const assets = [];
const tarName = `odd-claude-payload-${version}.tar.gz`;
writeFileSync(join(out, tarName), tgz);
assets.push(tarName);
copyFileSync(bundle, join(out, "odd-claude.mjs"));
assets.push("odd-claude.mjs");
const sums = assets.sort().map((n) => `${createHash("sha256").update(readFileSync(join(out, n))).digest("hex")}  ${n}\n`);
writeFileSync(join(out, "checksums.txt"), sums.join(""));
process.stdout.write(`${assets.map((n) => join(out, n)).join("\n")}\n${join(out, "checksums.txt")}\n`);
