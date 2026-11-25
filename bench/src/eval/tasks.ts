import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalTask {
  id: string;
  kind: "bugfix" | "feature" | "refactor";
  size: "small" | "medium";
  prompt: string;
  /** Shell command run in the workspace root after the hidden tests are copied in; exit 0 = pass. */
  grade: string;
  timeout_s: number;
  /** Optional extra allowed tools on top of the defaults. */
  allowed_tools?: string[];
  dir: string;
}

const KINDS = ["bugfix", "feature", "refactor"], SIZES = ["small", "medium"];

export function loadTask(tasksDir: string, id: string): EvalTask {
  const dir = join(tasksDir, id);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Record<string, unknown>; } catch (e) { throw new Error(`task ${id}: cannot read task.json (${(e as Error).message})`); }
  const bad = (m: string): never => { throw new Error(`task ${id}: ${m}`); };
  if (raw.id !== id) bad(`task.json id ${JSON.stringify(raw.id)} does not match its directory`);
  if (!KINDS.includes(raw.kind as string)) bad(`kind must be one of ${KINDS.join("|")}`);
  if (!SIZES.includes(raw.size as string)) bad(`size must be one of ${SIZES.join("|")}`);
  if (typeof raw.prompt !== "string" || raw.prompt === "") bad("prompt must be a non-empty string");
  if (typeof raw.grade !== "string" || raw.grade === "") bad("grade must be a non-empty string");
  if (typeof raw.timeout_s !== "number" || !(raw.timeout_s > 0)) bad("timeout_s must be a positive number");
  if (raw.allowed_tools !== undefined && !(Array.isArray(raw.allowed_tools) && raw.allowed_tools.every((t) => typeof t === "string"))) bad("allowed_tools must be a string array");
  for (const sub of ["repo", "hidden"]) if (!existsSync(join(dir, sub))) bad(`missing ${sub}/ directory`);
  return { ...(raw as unknown as EvalTask), dir };
}

/** Loads the selected tasks (all subdirectories with a task.json when `ids` is undefined), sorted by id. Unknown ids throw. */
export function loadTasks(tasksDir: string, ids?: readonly string[]): EvalTask[] {
  if (!existsSync(tasksDir)) throw new Error(`tasks dir not found: ${tasksDir}`);
  const all = readdirSync(tasksDir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(tasksDir, d.name, "task.json"))).map((d) => d.name).sort();
  const wanted = ids ?? all;
  for (const id of wanted) if (!all.includes(id)) throw new Error(`unknown task ${JSON.stringify(id)}; available: ${all.join(", ") || "(none)"}`);
  if (wanted.length === 0) throw new Error(`no tasks found in ${tasksDir}`);
  return wanted.map((id) => loadTask(tasksDir, id));
}
