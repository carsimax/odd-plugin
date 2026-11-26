// Session retro digest: a local, read-only summary of a Claude Code transcript (JSONL) for the `retro` skill.
// Reports counts, file paths, capped commands and 1-based line numbers only: prompt and tool-result bodies are never
// printed. Adapted in spirit from obra/superpowers `diagnosing-superpowers` (MIT). Every read is bounded (readTail).
import { cleanText, readTail, STATS_MAX_LINE_BYTES } from "./transcript-tail.js";

const MAX_STR = 160;
const MAX_ITEMS = 25;
const MAX_LINES_PER_ITEM = 12;
const EXEMPT = ["git status", "git diff", "ls", "pwd"];
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const FEATURE_DOC = /(^|[\\/])odd[\\/]tasks[\\/][^\\/]+\.md$/;
/** The worker agent; the legacy plugin-namespaced name is kept so old transcripts still analyze. */
const WORKERS = new Set(["odd-worker", "odd-claude:odd-worker"]);

export interface RetroDigest {
  schema: "odd-claude.retro/v1";
  /** Lines read, and the absolute 1-based line number (in the whole file) of the first one; every line number below is absolute. */
  lines: number;
  firstLine: number;
  bytesRead: number;
  truncated: boolean;
  prompts: { count: number; lines: number[] };
  tools: { name: string; count: number }[];
  errors: { count: number; items: { tool: string; line: number }[] };
  rereads: { file: string; count: number; lines: number[] }[];
  reedits: { file: string; count: number; lines: number[]; mainThread: boolean }[];
  repeatedCommands: { command: string; count: number; lines: number[] }[];
  agents: { line: number; subagentType: string; model: string; missingEditSurfaces: boolean }[];
  compactions: number[];
  firstSourceWrite: number | undefined;
  firstFeatureDoc: number | undefined;
}

const clean = (s: unknown): string => cleanText(s).slice(0, MAX_STR);
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function isHumanPrompt(entry: Record<string, any>, content: unknown): boolean {
  if (entry.isMeta === true || entry.isCompactSummary === true) return false;
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  if (content.some((b) => isObj(b) && b.type === "tool_result")) return false;
  return content.some((b) => isObj(b) && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

function grouped(map: Map<string, number[]>, min: number): { key: string; lines: number[] }[] {
  return [...map.entries()]
    .filter(([, l]) => l.length >= min)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_ITEMS)
    .map(([key, lines]) => ({ key, lines }));
}

const push = (m: Map<string, number[]>, k: string, line: number): void => {
  const l = m.get(k);
  if (l) l.push(line);
  else m.set(k, [line]);
};

/** Digest of the transcript tail; undefined when it cannot be read. Never throws. */
export function collectRetro(path: string, tailBytes?: number): RetroDigest | undefined {
  try {
    const tail = readTail(path, tailBytes);
    if (tail === undefined) return undefined;
    const lines = tail.text.split("\n");
    const prompts: number[] = [];
    const tools = new Map<string, number>();
    const names = new Map<string, string>();
    const seen = new Set<string>();
    const errors: { tool: string; line: number }[] = [];
    let errorCount = 0;
    const reads = new Map<string, number[]>();
    const edits = new Map<string, number[]>();
    const commands = new Map<string, number[]>();
    const agents: RetroDigest["agents"] = [];
    const compactions: number[] = [];
    let firstSourceWrite: number | undefined;
    let firstFeatureDoc: number | undefined;

    lines.forEach((text, i) => {
      const line = tail.firstLine + i;
      if (text === "" || text.length > STATS_MAX_LINE_BYTES) return;
      let entry: unknown;
      try {
        entry = JSON.parse(text);
      } catch {
        return;
      }
      if (!isObj(entry) || entry.isSidechain === true) return;
      if (entry.isCompactSummary === true || (entry.type === "system" && entry.subtype === "compact_boundary")) compactions.push(line);
      const content = isObj(entry.message) ? entry.message.content : undefined;
      if (entry.type === "user") {
        if (isHumanPrompt(entry, content)) prompts.push(line);
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!isObj(b) || b.type !== "tool_result" || b.is_error !== true) continue;
            errorCount++;
            if (errors.length < MAX_ITEMS) errors.push({ tool: (typeof b.tool_use_id === "string" && names.get(b.tool_use_id)) || "unknown", line });
          }
        }
        return;
      }
      if (entry.type !== "assistant" || !Array.isArray(content)) return;
      for (const b of content) {
        if (!isObj(b) || b.type !== "tool_use" || typeof b.name !== "string") continue;
        if (typeof b.id === "string") {
          if (seen.has(b.id)) continue; // streaming writes one message several times
          seen.add(b.id);
          names.set(b.id, clean(b.name));
        }
        const name = clean(b.name);
        tools.set(name, (tools.get(name) ?? 0) + 1);
        const input = isObj(b.input) ? b.input : {};
        const file = clean(input.file_path ?? input.notebook_path);
        if (name === "Read" && file !== "") push(reads, file, line);
        if (WRITE_TOOLS.has(name) && file !== "") {
          if (FEATURE_DOC.test(file)) firstFeatureDoc ??= line;
          else firstSourceWrite ??= line;
          push(edits, file, line);
        }
        if (name === "Bash" && typeof input.command === "string") {
          const cmd = clean(input.command.replace(/\s+/g, " "));
          if (cmd !== "" && !EXEMPT.some((e) => cmd === e || cmd.startsWith(`${e} `))) push(commands, cmd, line);
        }
        if (name === "Agent" || name === "Task") {
          const subagentType = clean(input.subagent_type);
          agents.push({
            line,
            subagentType,
            model: clean(input.model),
            missingEditSurfaces: WORKERS.has(subagentType) && !(typeof input.prompt === "string" && input.prompt.includes("## Allowed edit surfaces")),
          });
        }
      }
    });

    const cap = (l: number[]): number[] => l.slice(0, MAX_LINES_PER_ITEM);
    return {
      schema: "odd-claude.retro/v1",
      lines: lines.length,
      firstLine: tail.firstLine,
      bytesRead: tail.bytes,
      truncated: tail.truncated,
      prompts: { count: prompts.length, lines: cap(prompts) },
      tools: [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
      errors: { count: errorCount, items: errors },
      rereads: grouped(reads, 3).map((g) => ({ file: g.key, count: g.lines.length, lines: cap(g.lines) })),
      reedits: grouped(edits, 2).map((g) => ({ file: g.key, count: g.lines.length, lines: cap(g.lines), mainThread: true })),
      repeatedCommands: grouped(commands, 2).map((g) => ({ command: g.key, count: g.lines.length, lines: cap(g.lines) })),
      agents: agents.slice(0, MAX_ITEMS),
      compactions: cap(compactions),
      firstSourceWrite,
      firstFeatureDoc,
    };
  } catch {
    return undefined;
  }
}

const at = (l: number[]): string => l.join(", ");

export function renderRetro(d: RetroDigest): string {
  const out = ["odd-claude retro (local transcript digest)"];
  out.push(`lines      ${d.lines} read`);
  out.push(`first line read  ${d.firstLine} (all line numbers are absolute in the transcript file)`);
  out.push(`prompts    ${d.prompts.count}${d.prompts.count > 0 ? ` (lines ${at(d.prompts.lines)})` : ""}`);
  out.push(`tools      ${d.tools.length === 0 ? "none" : d.tools.map((t) => `${t.name} ${t.count}`).join(" · ")}`);
  out.push(`errors     ${d.errors.count}${d.errors.items.length > 0 ? ` · ${d.errors.items.map((e) => `${e.tool} @${e.line}`).join(", ")}` : ""}`);
  for (const r of d.rereads) out.push(`reread     ${r.file} x${r.count} (lines ${at(r.lines)})`);
  for (const r of d.reedits) out.push(`reedit     ${r.file} x${r.count} (lines ${at(r.lines)})${r.mainThread ? " main thread" : ""}`);
  for (const r of d.repeatedCommands) out.push(`repeat     ${r.command} x${r.count} (lines ${at(r.lines)})`);
  for (const a of d.agents) out.push(`agent      ${a.subagentType || "(no type)"}${a.model !== "" ? ` · ${a.model}` : ""} @${a.line}${a.missingEditSurfaces ? " · MISSING ## Allowed edit surfaces" : ""}`);
  if (d.compactions.length > 0) out.push(`compact    lines ${at(d.compactions)}`);
  out.push(`first source write  ${d.firstSourceWrite ?? "none"}`);
  out.push(`first feature doc   ${d.firstFeatureDoc ?? "none"}`);
  if (d.truncated) out.push(`(partial: only the last ${(d.bytesRead / (1024 * 1024)).toFixed(1)} MiB of the transcript was read)`);
  return out.join("\n");
}
