// U16 (S4): N independent MCP server processes (separate stdio clients) race START and the acknowledgement on the SAME candidate.
// Exactly one lineage is created, exactly one burn and one receipt happen, and every loser gets a typed answer (never an internal error).
// Stress is bounded: ROUNDS rounds of CLIENTS processes per race, every round on a fresh copy of a template world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTargetConsumed, readState } from "./store.testkit.js";
import {
  commitHigh, commitLow, consentArgs, copyWorld, lineageDirs, makeFakeReviewer, makeWorld, McpClient, RANGE, storeFiles, withClient, type Called, type FakeReviewer, type World,
} from "./harness.testkit.js";
import { relay, type Ack } from "./scenarios.testkit.js";

const CLIENTS = 6;
const ROUNDS = 3;

/** Spawns CLIENTS servers on a copy of `template`, fires `call` from all of them at once, closes them and returns the answers. */
async function race(template: World, fake: FakeReviewer, call: (w: World) => { tool: string; args: Record<string, unknown> }): Promise<{ w: World; answers: Called[] }> {
  const w = copyWorld(template);
  const clients = Array.from({ length: CLIENTS }, () => new McpClient({ fake, world: w }));
  try {
    await Promise.all(clients.map((c) => c.initialize()));
    const { tool, args } = call(w);
    const answers = await Promise.all(clients.map((c) => c.call(tool, args)));
    return { w, answers };
  } finally {
    for (const c of clients) {
      assert.equal(await c.close(), 0);
      assert.equal(c.stderr, "", "no server writes to stderr");
    }
  }
}

function assertNoDebris(w: World): void {
  const left = storeFiles(w.commonDir).filter((f) => f.includes(".atomic-"));
  assert.deepEqual(left, [], "no temp file survives a clean race");
}

const cleanups: (() => void)[] = [];
test.after(() => {
  for (const f of cleanups) f();
});

test(`${CLIENTS} clients START the same low-risk candidate at once: one lineage, one acknowledgement works, the rest are replays`, { timeout: 120_000 }, async () => {
  const w = makeWorld();
  const fake = makeFakeReviewer();
  cleanups.push(() => w.cleanup(), () => fake.cleanup());
  commitLow(w);
  for (let round = 0; round < ROUNDS; round++) {
    const { w: r, answers } = await race(w, fake, () => ({ tool: "review_start", args: { ...RANGE } }));
    try {
      for (const a of answers) assert.equal(a.isError, false, JSON.stringify(a.body).slice(0, 300));
      const lineages = lineageDirs(r.commonDir);
      assert.equal(lineages.length, 1, `round ${round}: one lineage, got ${lineages}`);
      const actions = answers.map((a) => a.body.action as string).sort();
      assert.ok(actions.every((x) => x === "closed" || x === "replayed"), `round ${round}: ${actions}`);
      assert.ok(actions.filter((x) => x === "closed").length >= 1, `round ${round}: someone created it`);
      assert.ok(new Set(answers.map((a) => a.body.lineage_id)).size === 1, "every client names the same lineage");
      assert.ok(new Set(answers.map((a) => a.body.target_identity)).size === 1);
      assert.equal(answers.filter((a) => a.body.acknowledgement !== undefined).length, 1, "the one-shot token is handed out exactly once");
      assertNoDebris(r);
    } finally {
      r.cleanup();
    }
  }
});

test(`${CLIENTS} clients answer the same consent at once: exactly one lineage for the candidate`, { timeout: 120_000 }, async () => {
  const w = makeWorld();
  const fake = makeFakeReviewer();
  cleanups.push(() => w.cleanup(), () => fake.cleanup());
  commitHigh(w);
  let args: Record<string, unknown> = {};
  await withClient({ fake, world: w }, async (c) => {
    args = { ...RANGE, ...consentArgs(await relay(c), "granted") };
  });
  for (let round = 0; round < ROUNDS; round++) {
    const { w: r, answers } = await race(w, fake, (cw) => ({ tool: "review_answer_consent", args: { ...args, cwd: cw.repo } }));
    try {
      for (const a of answers) assert.equal(a.isError, false, JSON.stringify(a.body).slice(0, 300));
      const lineages = lineageDirs(r.commonDir);
      assert.equal(lineages.length, 1, `round ${round}: one lineage, got ${lineages}`);
      const actions = answers.map((a) => a.body.action as string);
      assert.equal(actions.filter((x) => x === "created").length, 1, `round ${round}: exactly one creator: ${actions}`);
      assert.ok(actions.every((x) => x === "created" || x === "replayed"));
      assert.deepEqual([...new Set(answers.map((a) => a.body.lineage_id))], [lineages[0]]);
      assert.equal(readState(r.commonDir, lineages[0]!).state, "reviewing");
      assertNoDebris(r);
    } finally {
      r.cleanup();
    }
  }
});

test(`${CLIENTS} clients acknowledge the same approval with the same token at once: exactly one burn, one receipt, typed refusals for the rest`, { timeout: 120_000 }, async () => {
  const w = makeWorld();
  const fake = makeFakeReviewer();
  cleanups.push(() => w.cleanup(), () => fake.cleanup());
  commitLow(w);
  let ack: Ack | undefined;
  await withClient({ fake, world: w }, async (c) => {
    ack = (await relay(c)).acknowledgement;
  });
  for (let round = 0; round < ROUNDS; round++) {
    const { w: r, answers } = await race(w, fake, (cw) => ({ tool: "review_acknowledge_approved", args: { ...ack, cwd: cw.repo } }));
    try {
      const ok = answers.filter((a) => !a.isError);
      assert.equal(ok.length, 1, `round ${round}: exactly one burn, got ${ok.length}: ${JSON.stringify(answers.map((a) => a.body.error?.code ?? a.body.outcome))}`);
      for (const a of answers.filter((x) => x.isError)) {
        assert.ok(["target_already_acknowledged", "concurrent_update"].includes(a.body.error.code), `round ${round}: refusal ${JSON.stringify(a.body.error)}`);
      }
      assert.equal(ok[0]!.body.burned, true);
      const lineages = lineageDirs(r.commonDir);
      assert.equal(lineages.length, 1);
      const rec = readState(r.commonDir, lineages[0]!);
      assert.equal(rec.burned, true);
      assert.equal(isTargetConsumed(r.commonDir, rec.target_identity).status, "consumed");
      assert.equal(storeFiles(r.commonDir).filter((f) => f.endsWith("review-receipt.json")).length, 1, "one receipt");
      assertNoDebris(r);
    } finally {
      r.cleanup();
    }
  }
});

test(`START and acknowledge race on one low-risk candidate: a loser of the START never invalidates the winner's burn`, { timeout: 120_000 }, async () => {
  const w = makeWorld();
  const fake = makeFakeReviewer();
  cleanups.push(() => w.cleanup(), () => fake.cleanup());
  commitLow(w);
  let ack: Ack | undefined;
  await withClient({ fake, world: w }, async (c) => {
    ack = (await relay(c)).acknowledgement;
  });
  for (let round = 0; round < ROUNDS; round++) {
    const r = copyWorld(w);
    const clients = Array.from({ length: CLIENTS }, () => new McpClient({ fake, world: r }));
    try {
      await Promise.all(clients.map((c) => c.initialize()));
      const answers = await Promise.all(clients.map((c, i) => (i % 2 === 0 ? c.call("review_acknowledge_approved", { ...ack, cwd: r.repo }) : c.call("review_start", { ...RANGE }))));
      const burns = answers.filter((a, i) => i % 2 === 0 && !a.isError);
      assert.equal(burns.length, 1, `round ${round}: exactly one burn`);
      const lineages = lineageDirs(r.commonDir);
      assert.equal(lineages.length, 1, `round ${round}: START never opens a second lineage for a candidate that has one (${lineages})`);
      for (const [i, a] of answers.entries()) {
        if (i % 2 === 1 && a.isError) assert.equal(a.body.error.code, "target_already_acknowledged", `round ${round}: START refusal ${JSON.stringify(a.body.error)}`);
      }
      assert.equal(isTargetConsumed(r.commonDir, readState(r.commonDir, lineages[0]!).target_identity).status, "consumed");
      assertNoDebris(r);
    } finally {
      for (const c of clients) assert.equal(await c.close(), 0);
      r.cleanup();
    }
  }
});
