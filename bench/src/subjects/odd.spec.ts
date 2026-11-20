import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryCommand, parseInvocation } from "./odd.js";

test("an invocation string becomes the tool's own snake_case arguments, with shell quoting undone", () => {
  const p = parseInvocation("review_answer_consent --contract c/v2 --cwd '/tmp/a b/repo' --target-identity sha256:abc --consent-binding sha256:def --consent granted --lenses 'risk,readability'");
  assert.equal(p.tool, "review_answer_consent");
  assert.deepEqual(p.args, { contract: "c/v2", cwd: "/tmp/a b/repo", target_identity: "sha256:abc", consent_binding: "sha256:def", consent: "granted", lenses: "risk,readability" });
  assert.deepEqual(parseInvocation("review_status").args, {});
});

test("delivery commands are plain data assembled from fragments: they name the delivery the gate must recognize and nothing else", () => {
  assert.equal(deliveryCommand("push"), ["git", "push", "origin", "main"].join(" "));
  assert.equal(deliveryCommand("prOpen"), ["gh", "pr", "create", "--base", "main", "--fill"].join(" "));
});

test("no bench source holds a delivery command as one literal, and none executes one through a shell", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../src");
  const files = ["subjects/odd.ts", "journey.ts", "journeys/gate.ts", "journeys/fixtures.ts", "sandbox.ts"];
  const literal = new RegExp([["git", "push"].join(" "), ["gh", "pr", "create"].join(" "), ["gh", "pr", "merge"].join(" ")].join("|"));
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.equal(literal.test(text), false, `${f} holds a delivery command literal`);
    assert.equal(/execSync|spawnSync\(\s*["'`]sh|shell:\s*true/.test(text.replace(/execFileSync/g, "")), false, `${f} runs a shell`);
  }
});
