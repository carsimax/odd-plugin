#!/usr/bin/env node
// Sets the odd-claude version. Source of truth: plugins/odd-claude/package.json.
// Also updates plugin.json and the root marketplace.json while they exist.
// Usage: node scripts/bump-version.mjs <semver> [--allow-downgrade]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  process.stderr.write(`bump-version: ${msg}\n`);
  process.exit(1);
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** semver precedence: -1, 0 or 1. */
function compare(a, b) {
  const [ma, mb] = [SEMVER.exec(a), SEMVER.exec(b)];
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  const [pa, pb] = [ma[4], mb[4]];
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const [xa, xb] = [pa.split("."), pb.split(".")];
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const [na, nb] = [/^\d+$/.test(xa[i]), /^\d+$/.test(xb[i])];
    if (na && nb) {
      if (Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    } else if (na !== nb) return na ? -1 : 1;
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

const args = process.argv.slice(2);
const allowDowngrade = args.includes("--allow-downgrade");
const version = args.find((a) => !a.startsWith("--"));
if (!version) fail("usage: bump-version.mjs <semver> [--allow-downgrade]");
if (!SEMVER.test(version)) fail(`invalid semver ${JSON.stringify(version)}`);

const pkgPath = join(pluginRoot, "package.json");
const pkgText = readFileSync(pkgPath, "utf8");
const current = JSON.parse(pkgText).version;
if (typeof current === "string" && SEMVER.test(current) && compare(version, current) < 0 && !allowDowngrade) {
  fail(`refusing downgrade ${current} -> ${version} (use --allow-downgrade)`);
}

const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/;
const targets = [pkgPath, join(pluginRoot, ".claude-plugin", "plugin.json"), join(pluginRoot, "..", "..", ".claude-plugin", "marketplace.json")];
// Compute every edit first so a malformed file aborts before anything is written.
const edits = [];
for (const file of targets) {
  if (!existsSync(file)) continue;
  const text = file === pkgPath ? pkgText : readFileSync(file, "utf8");
  if (!VERSION_FIELD.test(text)) fail(`no "version" field in ${file}`);
  edits.push([file, text.replace(VERSION_FIELD, `$1${version}$2`)]);
}
for (const [file, text] of edits) {
  writeFileSync(file, text);
  process.stdout.write(`${file}: ${version}\n`);
}
