import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "ink-testing-library";
import { App } from "./app.js";
import { PROFILES, builtinSelection, cycleRole, pickProfile, profileOf, profileSummary } from "./logic.js";
import { ROUTES, backward, forward, path, type Flow } from "./router.js";
import type { RunRequest, Services } from "./services.js";
import { defaultSelection } from "../../src/installer/models.js";
import { resolveInstallPaths } from "../../src/installer/paths.js";
import type { Detection, StepResult } from "../../src/installer/orchestrate.js";

const ENTER = "\r";
const DOWN = "\u001B[B";
const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const ESC = "\u001B";
const wait = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

const detection = (over: Partial<Detection> = {}): Detection => ({
  node: { version: "22.4.0", ok: true },
  claude: { present: true, version: "2.1.0" },
  gh: { present: true, authenticated: true },
  deps: { engram: false, codegraph: true, brew: true, npm: true },
  installedVersion: "5.2.0",
  updateAvailable: "5.3.0",
  pluginIds: ["odd-claude@odd-claude"],
  selection: defaultSelection(),
  paths: resolveInstallPaths({}, "/nonexistent-home"),
  ...over,
});

interface Fake {
  services: Services;
  planned: RunRequest[];
  ran: RunRequest[];
}

function fake(over: { det?: Partial<Detection>; builtins?: { id: string; protected: boolean }[]; steps?: StepResult[]; backups?: { id: string; files: string[] }[] } = {}): Fake {
  const planned: RunRequest[] = [];
  const ran: RunRequest[] = [];
  const steps = over.steps ?? [
    { id: "install", label: "Install files, models and manifest", status: "ok" as const, detail: "v5.3.0: 40 files written" },
    { id: "deps", label: "External dependencies", status: "warning" as const, detail: "engram: failed" },
  ];
  const services: Services = {
    detect: async () => detection(over.det),
    builtins: async () => ({ ok: true, plugins: (over.builtins ?? []).map((b) => ({ ...b, scope: "user", enabled: true })) }),
    plan: async (req) => {
      planned.push(req);
      return { ok: true, dryRun: true, version: "5.3.0", steps: [{ id: "install", label: "Install files, models and manifest", status: "ok", detail: "would install v5.3.0" }], summary: "file: 40 create\nprofile: 1 create" };
    },
    run: async (req, onStep) => {
      ran.push(req);
      for (const s of steps) onStep(s);
      return { ok: true, dryRun: false, version: "5.3.0", steps };
    },
    backups: () => (over.backups ?? []).map((b) => ({ ...b, dir: `/x/${b.id}` })),
  };
  return { services, planned, ran };
}

async function boot(f: Fake): Promise<ReturnType<typeof render> & { exits: number[]; press: (k: string, n?: number) => Promise<void>; frame: () => string }> {
  const exits: number[] = [];
  const r = render(<App services={f.services} initial={{}} onExit={(c) => exits.push(c)} />);
  await wait();
  return {
    ...r,
    exits,
    press: async (k, n = 1) => {
      for (let i = 0; i < n; i++) {
        r.stdin.write(k);
        await wait();
      }
    },
    frame: () => r.lastFrame() ?? "",
  };
}

describe("route table", () => {
  it("install runs Welcome -> Detection -> Profile -> Models -> Extras -> Dependencies -> Review -> Installing -> Complete", () => {
    assert.deepEqual(path("install"), ["welcome", "detection", "profile", "models", "extras", "deps", "review", "installing", "complete"]);
  });
  it("Backward undoes Forward on every input screen of every flow", () => {
    for (const flow of Object.keys(ROUTES) as Flow[]) {
      for (const [screen, route] of Object.entries(ROUTES[flow])) {
        if (route?.forward && route.forward !== "installing" && route.forward !== "complete" && screen !== "welcome") assert.equal(backward(flow, route.forward), screen, `${flow}: back from ${route.forward}`);
      }
    }
    assert.equal(backward("install", "welcome"), undefined);
    assert.equal(backward("install", "installing"), undefined);
    assert.equal(forward("install", "complete"), undefined);
  });
});

describe("model selection logic", () => {
  it("cycles a role and the profile follows", () => {
    const s = cycleRole(defaultSelection(), "odd-explore", 1);
    assert.equal(s.roles["odd-explore"], "sonnet");
    assert.equal(s.profile, "custom");
    assert.equal(cycleRole(s, "odd-explore", -1).profile, "balanced");
    assert.equal(cycleRole(defaultSelection(), "odd-explore", -1).roles["odd-explore"], "opus");
  });
  it("presets replace every role, custom keeps them", () => {
    const eco = pickProfile("economy", defaultSelection());
    assert.equal(eco.profile, "economy");
    assert.equal(pickProfile("custom", eco).roles["odd-worker"], eco.roles["odd-worker"]);
    assert.equal(profileOf(defaultSelection("max").roles), "max");
    assert.deepEqual(PROFILES, ["balanced", "economy", "max", "custom"]);
    assert.match(profileSummary(defaultSelection()), /haiku x1, sonnet x\d+, opus x\d+/);
  });
  it("builtin selection: all, subset, keep; protected never count", () => {
    const b = [
      { id: "a@builtin", protected: false },
      { id: "b@builtin", protected: false },
      { id: "p@builtin", protected: true },
    ];
    assert.deepEqual(builtinSelection(b, new Set(["a@builtin", "b@builtin"])), { mode: "all" });
    assert.deepEqual(builtinSelection(b, new Set(["a@builtin", "p@builtin"])), { mode: "subset", ids: ["a@builtin"] });
    assert.deepEqual(builtinSelection(b, new Set()), { mode: "keep" });
  });
});

describe("Welcome", () => {
  it("renders the menu, the installed version and the cached update", async () => {
    const t = await boot(fake());
    const f = t.frame();
    for (const item of ["Install", "Update", "Configure models", "Manage backups", "Uninstall", "Quit"]) assert.ok(f.includes(item), `menu misses ${item}`);
    assert.match(f, /v5\.2\.0/);
    assert.match(f, /update available: v5\.3\.0/);
    t.unmount();
  });

  it("shows not installed when there is no version", async () => {
    const t = await boot(fake({ det: { installedVersion: null, updateAvailable: null } }));
    assert.match(t.frame(), /not installed/);
    assert.doesNotMatch(t.frame(), /update available/);
    t.unmount();
  });

  it("q quits with code 0", async () => {
    const t = await boot(fake());
    await t.press("q");
    assert.deepEqual(t.exits, [0]);
    t.unmount();
  });

  it("Quit in the menu exits too", async () => {
    const t = await boot(fake());
    await t.press(DOWN, 5);
    await t.press(ENTER);
    assert.deepEqual(t.exits, [0]);
    t.unmount();
  });
});

describe("Install flow navigation", () => {
  it("goes forward through the screens and Esc goes back", async () => {
    const t = await boot(fake());
    await t.press(ENTER);
    assert.match(t.frame(), /Detection/);
    assert.match(t.frame(), /Engram/);
    assert.match(t.frame(), /plugin/i);
    await t.press(ENTER);
    assert.match(t.frame(), /Profile/);
    await t.press(ENTER);
    assert.match(t.frame(), /Models/);
    await t.press(ENTER);
    assert.match(t.frame(), /Extras/);
    await t.press(ENTER);
    assert.match(t.frame(), /Dependencies/);
    await t.press(ENTER);
    assert.match(t.frame(), /Review/);
    await t.press(ESC);
    assert.match(t.frame(), /Dependencies/);
    await t.press(ESC, 5);
    assert.match(t.frame(), /Quit/);
    assert.match(t.frame(), /Welcome/);
    t.unmount();
  });

  it("the Profile screen lists the four profiles and a preset pick replaces the models", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 2);
    for (const p of ["balanced", "economy", "max", "custom"]) assert.ok(t.frame().includes(p), `profile list misses ${p}`);
    await t.press(DOWN);
    await t.press(ENTER);
    assert.match(t.frame(), /Models/);
    assert.match(t.frame(), /economy/);
    t.unmount();
  });

  it("cycling a model with left/right changes the selection that reaches the plan and the run", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 3);
    assert.match(t.frame(), /explore/);
    assert.match(t.frame(), /balanced/);
    await t.press(RIGHT);
    assert.match(t.frame(), /custom/);
    await t.press(ENTER, 3);
    assert.match(t.frame(), /Review/);
    assert.equal(f.planned[0]!.selection.roles["odd-explore"], "sonnet");
    assert.equal(f.planned[0]!.selection.profile, "custom");
    await t.press(ENTER);
    await wait(80);
    assert.equal(f.ran[0]!.selection.roles["odd-explore"], "sonnet");
    t.unmount();
  });

  it("defaults are the balanced models (haiku explore, opus verify)", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 3);
    const frame = t.frame();
    assert.match(frame, /explore\s.*haiku/);
    assert.match(frame, /verify\s.*opus/);
    await t.press(LEFT);
    assert.match(t.frame(), /explore\s.*opus/);
    t.unmount();
  });

  it("Review shows the plan", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 6);
    assert.match(t.frame(), /Review/);
    assert.match(t.frame(), /would install v5\.3\.0/);
    assert.match(t.frame(), /file: 40 create/);
    assert.equal(f.planned.length, 1);
    assert.equal(f.ran.length, 0, "review writes nothing");
    t.unmount();
  });

  it("Installing lists the steps and Complete gives the next steps", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 7);
    await wait(120);
    const frame = t.frame();
    assert.match(frame, /Complete/);
    assert.match(frame, /Install files, models and manifest/);
    assert.match(frame, /v5\.3\.0: 40 files written/);
    assert.match(frame, /engram: failed/);
    assert.match(frame, /Restart Claude Code/);
    assert.match(frame, /odd/);
    await t.press(ENTER);
    assert.match(t.frame(), /Welcome/);
    t.unmount();
  });
});

describe("Extras and Dependencies", () => {
  it("lists the builtin plugins as checkboxes, protected ones disabled, and the toggle reaches the request", async () => {
    const f = fake({ builtins: [{ id: "alpha@builtin", protected: false }, { id: "beta@builtin", protected: false }, { id: "cc-plugin-sec-default@builtin", protected: true }] });
    const t = await boot(f);
    await t.press(ENTER, 4);
    const frame = t.frame();
    assert.match(frame, /Status line/);
    assert.match(frame, /claude\.ai connectors/);
    assert.match(frame, /alpha@builtin/);
    assert.match(frame, /cc-plugin-sec-default@builtin.*protected/);
    await t.press(DOWN, 4);
    await t.press(" ");
    await t.press(ENTER, 2);
    assert.deepEqual(f.planned[0]!.extras.builtin, { mode: "subset", ids: ["beta@builtin"] });
    assert.equal(f.planned[0]!.extras.statusLine, true);
    t.unmount();
  });

  it("unchecking the status line and a claude.ai option reaches the request", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 4);
    await t.press(" ");
    await t.press(DOWN);
    await t.press(" ");
    await t.press(ENTER, 2);
    assert.equal(f.planned[0]!.extras.statusLine, false);
    assert.equal(f.planned[0]!.extras.claudeAi.connectors, false);
    assert.equal(f.planned[0]!.extras.claudeAi.skills, true);
    t.unmount();
  });

  it("shows the missing dependency and lets the user decline the install", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(ENTER, 5);
    assert.match(t.frame(), /Engram.*missing/s);
    assert.match(t.frame(), /codegraph.*found/s);
    await t.press(" ");
    await t.press(ENTER);
    assert.equal(f.planned[0]!.deps, false);
    t.unmount();
  });
});

describe("other flows", () => {
  it("Configure models goes Profile -> Models -> Review -> Installing and applies the selection", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(DOWN, 2);
    await t.press(ENTER);
    assert.match(t.frame(), /Profile/);
    await t.press(ENTER);
    assert.match(t.frame(), /Models/);
    await t.press(RIGHT);
    await t.press(ENTER);
    assert.match(t.frame(), /Review/);
    await t.press(ENTER);
    await wait(100);
    assert.equal(f.ran[0]!.flow, "models");
    assert.equal(f.ran[0]!.selection.roles["odd-explore"], "sonnet");
    t.unmount();
  });

  it("Uninstall asks for confirmation, offers purge and never touches the dependencies", async () => {
    const f = fake();
    const t = await boot(f);
    await t.press(DOWN, 4);
    await t.press(ENTER);
    assert.match(t.frame(), /Uninstall/);
    assert.match(t.frame(), /Engram and codegraph are left as they are/);
    await t.press(" ");
    await t.press(ENTER);
    await wait(100);
    assert.equal(f.ran[0]!.flow, "uninstall");
    assert.equal(f.ran[0]!.purge, true);
    t.unmount();
  });

  it("Backups lists them and restores the chosen one", async () => {
    const f = fake({ backups: [{ id: "2026-01-01T00-00-00-000Z", files: ["settings.json", "agents/odd-worker.md"] }] });
    const t = await boot(f);
    await t.press(DOWN, 3);
    await t.press(ENTER);
    assert.match(t.frame(), /2026-01-01T00-00-00-000Z/);
    assert.match(t.frame(), /2 files/);
    await t.press(ENTER);
    await wait(100);
    assert.equal(f.ran[0]!.flow, "backups");
    assert.equal(f.ran[0]!.backupId, "2026-01-01T00-00-00-000Z");
    t.unmount();
  });

  it("Backups with none says so", async () => {
    const t = await boot(fake());
    await t.press(DOWN, 3);
    await t.press(ENTER);
    assert.match(t.frame(), /No backups/);
    t.unmount();
  });
});
