// Persona modes (R02). Stored as plugin-wide state `persona` ({ mode }) under the data dir.
import { readPluginState, writePluginState, type StateOptions } from "./state.js";

export const PERSONA_MODES = ["neutral"] as const;
export type PersonaMode = (typeof PERSONA_MODES)[number];
export const DEFAULT_PERSONA: PersonaMode = "neutral";

export function isPersonaMode(v: unknown): v is PersonaMode {
  return typeof v === "string" && (PERSONA_MODES as readonly string[]).includes(v);
}

/** Stored persona, or the default when missing, corrupt, unknown or without a data dir. */
export function readPersona(opts: StateOptions = {}): PersonaMode {
  try {
    const mode = readPluginState("persona", opts).mode;
    return isPersonaMode(mode) ? mode : DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
}

/** Validates then stores; throws on an invalid mode without touching the stored value. */
export function writePersona(mode: string, opts: StateOptions = {}): PersonaMode {
  if (!isPersonaMode(mode)) {
    throw new Error(`invalid persona ${JSON.stringify(mode)}; available modes: ${PERSONA_MODES.join(", ")}`);
  }
  writePluginState("persona", { mode }, opts);
  return mode;
}

const COMMON = `- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.`;

/** Spanish is always neutral. */
const SPANISH_RULE = `- When the user writes Spanish, use neutral/professional Spanish. Do NOT use voseo or any regional conjugations: use tú or usted forms, never vos forms (tienes, not tenés; ajustas, not ajustás; mira, not mirá; haz, not hacé).`;

const TEXT: Record<PersonaMode, string> = {
  neutral: `- Be direct, technical, concise, warm, and professional.
- Do not use slang or regional expressions.
${SPANISH_RULE}
${COMMON}`,
};

export function personaText(mode: PersonaMode): string {
  return TEXT[mode];
}
