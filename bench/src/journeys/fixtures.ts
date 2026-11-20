// Subject-neutral repository fixtures: the same files for every subject, so a low/medium/high-risk change is one thing in the
// journey vocabulary. How risky a subject finds each change is the subject's own classifier; these are the shapes both are asked about.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EditKind, FixtureSpec, Risk } from "../journey.js";
import type { Sandbox } from "../sandbox.js";

interface ChangeFile { path: string; content: string }

/** One tracked-or-staged file per tier: docs only (low), plain source (medium), an auth path (high). */
export const CHANGE: Record<Risk, ChangeFile> = {
  low: { path: "README.md", content: "# sandbox\nA second line of documentation.\n" },
  medium: { path: "src/util.ts", content: "export const add = (a: number, b: number): number => a + b;\n" },
  high: { path: "src/auth/login.ts", content: "export const login = (user: string): boolean => user.length > 0;\n" },
};
/** A different high-risk file, for a workspace change next to a committed one. */
export const EXTRA_WORKSPACE: ChangeFile = { path: "src/auth/session.ts", content: "export const session = (token: string): boolean => token.length > 8;\n" };

function write(sandbox: Sandbox, file: ChangeFile): void {
  const full = join(sandbox.repo, file.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, file.content);
}

/** Writes the fixture's change (staged, so it is part of the working-tree candidate); commits it when the placement is `committed`. Uncounted setup. */
export function applyFixture(sandbox: Sandbox, fixture: FixtureSpec): void {
  if (fixture.change === "none") return;
  write(sandbox, CHANGE[fixture.change]);
  sandbox.git(["add", "-A"]);
  if (fixture.placement === "committed") {
    sandbox.git(["commit", "-q", "-m", `bench: ${fixture.change}-risk change`]);
    if (fixture.extraWorkspace) {
      write(sandbox, EXTRA_WORKSPACE);
      sandbox.git(["add", "-A"]);
    }
  }
}

/** The file a correction or drift edits: the workspace change under review (the extra one when a committed change sits under it). */
export function editedFile(fixture: FixtureSpec): ChangeFile {
  if (fixture.change === "none") throw new Error("the fixture has no change to edit");
  return fixture.extraWorkspace === true ? EXTRA_WORKSPACE : CHANGE[fixture.change];
}

/** Applies an edit between steps. `noop` leaves the repository as it is. */
export function applyEdit(sandbox: Sandbox, fixture: FixtureSpec, edit: EditKind): void {
  if (edit === "noop") return;
  const file = editedFile(fixture);
  write(sandbox, { path: file.path, content: `${file.content}// bench: ${edit === "fix" ? "corrected" : "drifted"}\n` });
}
