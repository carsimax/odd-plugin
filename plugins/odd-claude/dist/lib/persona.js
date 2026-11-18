// Persona modes (R02). Stored as plugin-wide state `persona` ({ mode }) under the data dir.
import { readPluginState, writePluginState } from "./state.js";
export const PERSONA_MODES = ["mentor", "neutral"];
export const DEFAULT_PERSONA = "mentor";
export function isPersonaMode(v) {
    return typeof v === "string" && PERSONA_MODES.includes(v);
}
/** Stored persona, or the default when missing, corrupt, unknown or without a data dir. */
export function readPersona(opts = {}) {
    try {
        const mode = readPluginState("persona", opts).mode;
        return isPersonaMode(mode) ? mode : DEFAULT_PERSONA;
    }
    catch {
        return DEFAULT_PERSONA;
    }
}
/** Validates then stores; throws on an invalid mode without touching the stored value. */
export function writePersona(mode, opts = {}) {
    if (!isPersonaMode(mode)) {
        throw new Error(`invalid persona ${JSON.stringify(mode)}; available modes: ${PERSONA_MODES.join(", ")}`);
    }
    writePluginState("persona", { mode }, opts);
    return mode;
}
const COMMON = `- Always respond in the same language the user writes in (reply-language rule in the session context).
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.`;
const TEXT = {
    mentor: `- Be direct, technical, and concise.
- When the user writes Spanish, answer in natural Rioplatense Spanish with voseo.
${COMMON}`,
    neutral: `- Be direct, technical, concise, warm, and professional.
- Do not use slang or regional expressions.
- When the user writes Spanish, use neutral/professional Spanish. Do NOT use voseo or any regional conjugations: use tú or usted forms, never vos forms (tienes, not tenés; ajustas, not ajustás; mira, not mirá; haz, not hacé).
${COMMON}`,
};
export function personaText(mode) {
    return TEXT[mode];
}
