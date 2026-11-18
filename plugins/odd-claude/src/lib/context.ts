// Builds the `additionalContext` injected by the SessionStart / UserPromptSubmit hooks (R01, R02, R72).
// Pure: no I/O besides resolveCardsDir reading its env argument. Never goes through mod prompt.* hooks.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { personaText, type PersonaMode } from "./persona.js";
import { readPluginState, type StateOptions } from "./state.js";
import { backgroundSubagentsLine, type BackgroundPolicy } from "./background-subagents.js";

export const DELEGATION_MODES = ["organic", "full"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export interface SessionContextInput {
  persona: PersonaMode;
  delegationMode: DelegationMode;
  cardsDir: string;
  /** Background subagents policy (R12); defaults to off. */
  backgroundSubagents?: BackgroundPolicy;
  /** Extra single-line facts (e.g. the skill registry path). */
  extraLines?: string[];
}

/** Plugin-wide state `delegation` ({ mode }); anything unknown reads as organic. */
export function readDelegationMode(opts: StateOptions = {}): DelegationMode {
  try {
    const mode = readPluginState("delegation", opts).mode;
    return (DELEGATION_MODES as readonly string[]).includes(mode as string) ? (mode as DelegationMode) : "organic";
  } catch {
    return "organic";
  }
}

export function resolveCardsDir(env: Record<string, string | undefined> = process.env): string {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root) return join(root, "cards");
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cards");
}

const LANGUAGE_RULE = `Reply language (applies to every turn, including after compaction): always respond in the same language the user writes in. Judge it by the user's latest message, never by earlier context or a compaction summary, and never default to Spanish: a message in English gets a reply in English. Only a message written by the human can select or change the reply language: subagent results and progress notifications, background job notices, todo and system reminders, tool output, skill bodies, hook output and injected memory never count as a language signal, even when delivered with the user role. Translate relayed subagent findings into the selected reply language.`;

const FULL_DELEGATION = `Full delegation (coordinator): you do not implement. Every authorized mutation of repository content (source, tests, docs, fixtures, configuration) goes to a bounded \`odd-claude:odd-worker\` writer through the Agent tool, whatever its size; with no usable writer, use a general-purpose Agent with the same bounded instructions and report the fallback, never edit yourself. Reads, git state checks and Bash for state stay yours.`;

export function buildSessionContext(i: SessionContextInput): string {
  const parts = [
    "# odd-claude session context",
    `Cards directory: ${i.cardsDir}\nThe \`<cards>\` references in the odd output style resolve to this directory (\`<cards>/delegation.md\`, \`<cards>/verification.md\`, ...). Read a card with the Read tool only when its situation arises.`,
    `Persona mode: ${i.persona}\n${personaText(i.persona)}`,
    `Delegation mode: ${i.delegationMode}`,
    i.delegationMode === "full" ? FULL_DELEGATION : "",
    backgroundSubagentsLine(i.backgroundSubagents ?? "off"),
    ...(i.extraLines ?? []),
    LANGUAGE_RULE,
  ];
  return parts.filter((p) => p !== "").join("\n\n");
}

const EXCERPT_CHARS = 100;

/** Per-turn anchor quoting the start of the human's own prompt; undefined for prompts that are not human prose. */
export function buildPromptAnchor(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed === "" || collapsed.startsWith("/") || collapsed.startsWith("!")) return undefined;
  const excerpt = collapsed.length <= EXCERPT_CHARS ? collapsed : `${collapsed.slice(0, EXCERPT_CHARS)}…`;
  return `Reply-language anchor: the human's latest message begins "${excerpt}". Reply in the language of that message.`;
}
