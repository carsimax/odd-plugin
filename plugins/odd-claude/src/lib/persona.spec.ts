import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA, PERSONA_MODES, isPersonaMode, personaText, readPersona, writePersona } from "./persona.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-persona-"));
}

test("default persona when nothing is stored, no data dir needed", () => {
  const dir = tmp();
  try {
    assert.equal(readPersona({ dataDir: dir }), DEFAULT_PERSONA);
    assert.equal(readPersona({ env: {} }), DEFAULT_PERSONA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set then get round-trips every mode", () => {
  const dir = tmp();
  try {
    for (const mode of PERSONA_MODES) {
      assert.equal(writePersona(mode, { dataDir: dir }), mode);
      assert.equal(readPersona({ dataDir: dir }), mode);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid mode throws and leaves the stored persona unchanged", () => {
  const dir = tmp();
  try {
    writePersona("neutral", { dataDir: dir });
    for (const bad of ["", "Neutral", "gentleman", "neutral; rm", "../x"]) {
      assert.throws(() => writePersona(bad, { dataDir: dir }), /invalid persona/);
      assert.equal(isPersonaMode(bad), false);
    }
    assert.equal(readPersona({ dataDir: dir }), "neutral");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or unknown stored mode falls back to the default", () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.json"), "{oops");
    assert.equal(readPersona({ dataDir: dir }), DEFAULT_PERSONA);
    writeFileSync(join(dir, "persona.json"), JSON.stringify({ version: 1, sessionId: "persona", data: { mode: "zzz" } }));
    assert.equal(readPersona({ dataDir: dir }), DEFAULT_PERSONA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neutral is the only persona and the default", () => {
  assert.deepEqual([...PERSONA_MODES], ["neutral"]);
  assert.equal(DEFAULT_PERSONA, "neutral");
  assert.equal(isPersonaMode("mentor"), false);
});

test("stored mentor reads as neutral; writing mentor throws and leaves state untouched", () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.json"), JSON.stringify({ version: 1, sessionId: "persona", data: { mode: "mentor" } }));
    assert.equal(readPersona({ dataDir: dir }), "neutral");
    const before = readFileSync(join(dir, "persona.json"), "utf8");
    assert.throws(() => writePersona("mentor", { dataDir: dir }), /invalid persona "mentor"; available modes: neutral$/);
    assert.equal(readFileSync(join(dir, "persona.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persona text is neutral Spanish and mentions no mentor mode", () => {
  const text = personaText("neutral");
  assert.match(text, /Do NOT use voseo/);
  assert.doesNotMatch(text, /Rioplatense|mentor/i);
});
