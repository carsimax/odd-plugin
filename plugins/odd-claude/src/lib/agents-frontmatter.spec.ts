import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS, PRESET_NAMES, PROFILE_ROLES } from "./profiles.js";

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

test("PROFILE_ROLES lists exactly the agent files in agents/ and every preset routes each of them", () => {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.deepEqual([...PROFILE_ROLES].sort(), files);
  for (const name of PRESET_NAMES) for (const role of PROFILE_ROLES) assert.ok(PRESETS[name][role], `${name} lacks ${role}`);
});
