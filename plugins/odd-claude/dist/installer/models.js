// Per-agent model selection. Defaults and persistence come from lib/profiles.ts; nothing is duplicated here.
import { CUSTOM_PROFILE, NATIVE_REVIEW_ROLES, PRESETS, PRESET_NAMES, PROFILE_MODELS, PROFILE_ROLES, readProfile, setRole, useProfile } from "../lib/profiles.js";
const isPreset = (n) => PRESET_NAMES.includes(n);
function presetRoles(name) {
    return Object.fromEntries(PROFILE_ROLES.map((role) => [role, PRESETS[name][role].model]));
}
/** A preset's selection (balanced by default); `custom` starts from balanced. */
export function defaultSelection(profile = "balanced") {
    return { profile, roles: presetRoles(profile === CUSTOM_PROFILE ? "balanced" : profile) };
}
/**
 * Preset plus per-role overrides. Throws on an unknown profile, role or model. An override that changes a role
 * turns a preset into `custom`.
 */
export function buildSelection(profile, overrides = {}) {
    if (profile !== CUSTOM_PROFILE && !isPreset(profile))
        throw new Error(`invalid profile ${JSON.stringify(profile)}; available profiles: ${[...PRESET_NAMES, CUSTOM_PROFILE].join(", ")}`);
    const sel = defaultSelection(profile);
    for (const [role, model] of Object.entries(overrides)) {
        if (!PROFILE_ROLES.includes(role))
            throw new Error(`invalid role ${JSON.stringify(role)}; available roles: ${PROFILE_ROLES.join(", ")}`);
        if (!PROFILE_MODELS.includes(model))
            throw new Error(`invalid model ${JSON.stringify(model)}; available models: ${PROFILE_MODELS.join(", ")}`);
        if (sel.roles[role] !== model) {
            sel.roles[role] = model;
            sel.profile = CUSTOM_PROFILE;
        }
    }
    return sel;
}
/** The selection currently persisted in the data dir (balanced when nothing valid is stored). */
export function readSelection(dataDir) {
    const p = readProfile({ dataDir });
    return { profile: p.active, roles: Object.fromEntries(PROFILE_ROLES.map((role) => [role, p.routing[role].model])) };
}
/** Persists through the profiles state API so the SessionStart line matches the installed agent files. */
export function writeProfileState(dataDir, selection) {
    const opts = { dataDir };
    const base = selection.profile === CUSTOM_PROFILE ? "balanced" : selection.profile;
    const preset = presetRoles(base);
    const differing = PROFILE_ROLES.filter((role) => selection.roles[role] !== undefined && selection.roles[role] !== preset[role]);
    if (selection.profile !== CUSTOM_PROFILE && differing.length === 0) {
        useProfile(selection.profile, opts);
        return;
    }
    useProfile(base, opts);
    for (const role of selection.profile === CUSTOM_PROFILE ? PROFILE_ROLES : differing) {
        setRole(role, selection.roles[role] ?? preset[role], PRESETS[base][role].effort, opts);
    }
}
/** Agent file name for a role. */
export const agentFileForRole = (role) => `${role}.md`;
/** Roles routed by the profile that ship no agent file (always the native review roles) and agent files no role routes. */
export function roleCoverage(agentFiles) {
    const files = new Set(agentFiles);
    const roles = new Set(PROFILE_ROLES);
    return {
        rolesWithoutAgentFile: [...PROFILE_ROLES.filter((r) => !files.has(agentFileForRole(r))), ...NATIVE_REVIEW_ROLES],
        unroutedAgentFiles: agentFiles.filter((f) => !f.endsWith(".md") || !roles.has(f.slice(0, -3))),
    };
}
/** Sets or replaces `model:` in the agent frontmatter, leaving every other byte untouched. */
export function applyAgentModel(markdown, model) {
    const m = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
    if (!m)
        throw new Error("agent file has no frontmatter");
    const eol = m[1];
    const body = m[2];
    const line = /^model:.*$/m;
    const next = line.test(body) ? body.replace(line, () => `model: ${model}`) : `${body}${eol}model: ${model}`;
    return `---${eol}${next}${m[3]}---${markdown.slice(m[0].length)}`;
}
/** The effort the profile gives a role (a `custom` selection starts from balanced, as writeProfileState does); undefined when it has none or the role's model is haiku (which never carries an effort, as in review/reviewer-model.ts). */
export function roleEffort(selection, role) {
    if (selection.roles[role] === "haiku")
        return undefined;
    const base = selection.profile === CUSTOM_PROFILE ? "balanced" : selection.profile;
    return PRESETS[base][role]?.effort;
}
/** Sets or replaces `effort:` in the agent frontmatter (inserted right after `model:` when present), leaving every other byte untouched. */
export function applyAgentEffort(markdown, effort) {
    const m = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
    if (!m)
        throw new Error("agent file has no frontmatter");
    const eol = m[1];
    const body = m[2];
    const line = /^effort:.*$/m;
    const model = /^model:.*$/m;
    const next = line.test(body)
        ? body.replace(line, () => `effort: ${effort}`)
        : model.test(body)
            ? body.replace(model, (l) => `${l.replace(/\r$/, "")}${eol}effort: ${effort}`)
            : `${body}${eol}effort: ${effort}`;
    return `---${eol}${next}${m[3]}---${markdown.slice(m[0].length)}`;
}
