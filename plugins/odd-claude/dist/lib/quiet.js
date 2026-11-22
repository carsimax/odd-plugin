// R51 quiet tool rendering. Upstream (extensions/quiet-tools.ts, lib/quiet-tools-config.ts) re-registers the built-in
// tool renderers with compact ones, behind an on/off config. Here it is an optional mod feature (hooks/register.ts,
// `ui.render` on ToolResult): when ON, long Bash/Read/Grep/Glob results draw as one summary line. Render-only: what the
// model sees never changes. OFF by default (upstream's rows stay as they are until the user opts in); the flag is plugin
// state `quiet.json` which the mod reads through $.fs. With mods off the flag is stored and has no visible effect.
import { readPluginState, writePluginState } from "./state.js";
export function quietEnabled(opts = {}) {
    try {
        return readPluginState("quiet", opts).enabled === true;
    }
    catch {
        return false;
    }
}
export function setQuietEnabled(enabled, opts = {}) {
    writePluginState("quiet", { enabled }, opts);
}
export const QUIET_MODS_NOTE = "Quiet rendering is drawn by the ui.render mod; when mods are off (or in -p / safe mode) the setting is stored and has no visible effect.";
