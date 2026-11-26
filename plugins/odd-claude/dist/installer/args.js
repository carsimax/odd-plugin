// Command line of the installer: subcommands, flag specs (the single source for parsing and for --help) and the
// mapping from flags to the options the flows take. Every TUI choice has a flag here.
import { CUSTOM_PROFILE, PROFILE_ROLES } from "../lib/profiles.js";
import { DEFAULT_EXTRAS } from "./extras.js";
import { buildSelection } from "./models.js";
export const COMMANDS = ["install", "update", "uninstall", "rollback", "models", "backups", "status"];
/** Internal: run by `update` from the newly staged version; accepted by the parser but not listed in --help. */
const INTERNAL_COMMANDS = ["reapply"];
export const FLAG_SPECS = [
    { name: "source", value: "<dir>", description: "install from a local checkout (the plugins/odd-claude tree) instead of the latest GitHub release" },
    { name: "profile", value: "balanced|economy|max|custom", description: "model preset for the agents (default: the stored one, balanced on a fresh install)" },
    { name: "model", value: "<role>=<model>", repeatable: true, description: "override one agent, e.g. worker=opus (roles: odd-<name> or <name>; models: haiku, sonnet, opus); makes the profile custom" },
    { name: "dry-run", description: "show what would change; writes nothing and mutates nothing" },
    { name: "yes", description: "non-interactive: accept the defaults and confirm the dependency installs" },
    { name: "no-deps", description: "do not install Engram or codegraph" },
    { name: "no-statusline", description: "do not install the status line" },
    { name: "keep-claude-ai-connectors", description: "do not disable the claude.ai connectors (disableClaudeAiConnectors)" },
    { name: "keep-claude-ai-skills", description: "do not disable the claude.ai skills sync (syncClaudeAiSkills)" },
    { name: "keep-claude-ai-plugins", description: "do not disable the claude.ai plugins sync (syncClaudeAiPlugins)" },
    { name: "keep-builtin-plugins", description: "do not disable any @builtin plugin" },
    { name: "disable-builtin", value: "<id>", repeatable: true, description: "disable only this @builtin plugin (repeatable); default: all discovered, protected ones excepted" },
    { name: "purge", description: "uninstall: also delete the data dir and the backups" },
    { name: "force", description: "update: skip the 6h cache of the release check and reinstall the same version" },
    { name: "to", value: "<version>", description: "rollback: target an installed version (default: the previous one)" },
    { name: "restore", value: "<id>", description: "backups: restore the backup with this id" },
    { name: "json", description: "machine-readable output (one JSON document)" },
    { name: "help", description: "show this help" },
    { name: "version", description: "show the version" },
];
export function parseArgs(argv) {
    const a = {
        models: [],
        dryRun: false,
        yes: false,
        deps: true,
        statusLine: true,
        claudeAi: { connectors: true, skills: true, plugins: true },
        keepBuiltin: false,
        disableBuiltin: [],
        purge: false,
        force: false,
        json: false,
        help: false,
        version: false,
    };
    const specs = new Map(FLAG_SPECS.map((f) => [f.name, f]));
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (tok === "-h") {
            a.help = true;
            continue;
        }
        if (!tok.startsWith("--")) {
            if (a.command !== undefined)
                return { ok: false, error: `unexpected argument ${tok}` };
            if (![...COMMANDS, ...INTERNAL_COMMANDS].includes(tok))
                return { ok: false, error: `unknown command ${tok}` };
            a.command = tok;
            continue;
        }
        const eq = tok.indexOf("=");
        const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
        const spec = specs.get(name);
        if (!spec)
            return { ok: false, error: `unknown flag --${name}` };
        let value;
        if (spec.value) {
            value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
            if (value === undefined || (eq === -1 && value.startsWith("--")))
                return { ok: false, error: `--${name} requires a value` };
        }
        else if (eq !== -1)
            return { ok: false, error: `--${name} does not take a value` };
        switch (name) {
            case "source":
                a.source = value;
                break;
            case "profile":
                a.profile = value;
                break;
            case "model":
                a.models.push(value);
                break;
            case "dry-run":
                a.dryRun = true;
                break;
            case "yes":
                a.yes = true;
                break;
            case "no-deps":
                a.deps = false;
                break;
            case "no-statusline":
                a.statusLine = false;
                break;
            case "keep-claude-ai-connectors":
                a.claudeAi.connectors = false;
                break;
            case "keep-claude-ai-skills":
                a.claudeAi.skills = false;
                break;
            case "keep-claude-ai-plugins":
                a.claudeAi.plugins = false;
                break;
            case "keep-builtin-plugins":
                a.keepBuiltin = true;
                break;
            case "disable-builtin":
                a.disableBuiltin.push(value);
                break;
            case "purge":
                a.purge = true;
                break;
            case "force":
                a.force = true;
                break;
            case "to":
                a.to = value;
                break;
            case "restore":
                a.restore = value;
                break;
            case "json":
                a.json = true;
                break;
            case "help":
                a.help = true;
                break;
            case "version":
                a.version = true;
                break;
        }
    }
    return { ok: true, args: a };
}
/** `--profile` and `--model` as a validated selection; undefined when neither is given. Throws with the available values. */
export function selectionFromArgs(a) {
    if (a.profile === undefined && a.models.length === 0)
        return undefined;
    const overrides = {};
    for (const m of a.models) {
        const eq = m.indexOf("=");
        if (eq <= 0 || eq === m.length - 1)
            throw new Error(`--model expects <role>=<model>, got ${JSON.stringify(m)}`);
        const raw = m.slice(0, eq);
        const role = PROFILE_ROLES.includes(raw) || PROFILE_ROLES.includes(`odd-${raw}`) ? (raw.startsWith("odd-") ? raw : `odd-${raw}`) : raw;
        overrides[role] = m.slice(eq + 1);
    }
    return buildSelection(a.profile ?? "balanced", overrides);
}
export function extrasFromArgs(a) {
    return {
        ...DEFAULT_EXTRAS,
        statusLine: a.statusLine,
        claudeAi: { ...a.claudeAi },
        builtin: a.keepBuiltin ? { mode: "keep" } : a.disableBuiltin.length > 0 ? { mode: "subset", ids: [...a.disableBuiltin] } : { mode: "all" },
    };
}
const COMMAND_HELP = {
    install: "install odd-claude globally (files, models, hooks, output style, MCP, extras, dependencies)",
    update: "update from the latest GitHub release (keeps models and extras)",
    uninstall: "remove what odd-claude installed and restore your previous settings",
    rollback: "switch back to the previous installed version",
    models: "apply a model selection (--profile / --model) to the installed version",
    backups: "list the backups, or restore one with --restore <id>",
    status: "show the detected environment and the installed version",
};
export function usage() {
    const lines = ["Usage: odd-claude [command] [flags]", "", "Without a command it opens the interactive installer (needs a terminal).", "", "Commands:"];
    for (const c of COMMANDS)
        lines.push(`  ${c.padEnd(10)} ${COMMAND_HELP[c]}`);
    lines.push("", "Flags:");
    for (const f of FLAG_SPECS) {
        const head = `--${f.name}${f.value ? ` ${f.value}` : ""}`;
        lines.push(`  ${head.padEnd(40)} ${f.description}${f.repeatable ? " (repeatable)" : ""}`);
    }
    lines.push("", `Profiles: balanced, economy, max, ${CUSTOM_PROFILE}.`, "Exit codes: 0 ok, 1 a step failed, 2 usage error.");
    return lines.join("\n") + "\n";
}
