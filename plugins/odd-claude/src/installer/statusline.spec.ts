import { test } from "node:test";
import assert from "node:assert/strict";
import { PAYLOAD_ITEMS } from "./payload.js";
import { statusLineChanges } from "./statusline.js";

test("statusLineChanges points settings.json at the installed script", () => {
  assert.deepEqual(statusLineChanges("/h/.odd-claude/current"), [{ path: ["statusLine"], value: { type: "command", command: 'bash "/h/.odd-claude/current/statusline/statusline.sh"' } }]);
});

test("the statusline directory ships in the payload", () => {
  assert.ok((PAYLOAD_ITEMS as readonly string[]).includes("statusline"));
});
