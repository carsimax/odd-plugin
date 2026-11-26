// Presentational screens. Colors are restrained: one accent (cyan) for the cursor and the title, green/yellow/red only
// for status, everything else default foreground or dim, so it reads on light and dark terminals.
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { PROFILE_MODELS, PROFILE_ROLES } from "../../src/lib/profiles.js";
import type { BuiltinPlugin } from "../../src/installer/builtin-plugins.js";
import type { DepAction } from "../../src/installer/deps.js";
import type { ModelSelection } from "../../src/installer/models.js";
import type { Detection, FullResult, StepResult } from "../../src/installer/orchestrate.js";
import type { BackupInfo } from "../../src/installer/backup.js";
import { PROFILES, profileSummary, pickProfile, roleLabel } from "./logic.js";
import type { Flow, Screen } from "./router.js";

export const TITLES: Record<Screen, string> = {
  welcome: "Welcome",
  detection: "Detection",
  profile: "Profile",
  models: "Models",
  extras: "Extras",
  deps: "Dependencies",
  review: "Review",
  confirm: "Uninstall",
  backups: "Backups",
  installing: "Working",
  complete: "Complete",
};

export const HINTS: Record<Screen, string> = {
  welcome: "up/down move  enter select  q quit",
  detection: "enter continue  esc back  q quit",
  profile: "up/down move  enter choose  esc back  q quit",
  models: "up/down role  left/right model  enter continue  esc back  q quit",
  extras: "up/down move  space toggle  enter continue  esc back  q quit",
  deps: "space toggle  enter continue  esc back  q quit",
  review: "enter run  esc back  q quit",
  confirm: "space toggle purge  enter uninstall  esc back  q quit",
  backups: "up/down move  enter restore  esc back  q quit",
  installing: "working, please wait",
  complete: "enter back to the menu  q quit",
};

const STATUS: Record<StepResult["status"], { mark: string; color?: string }> = {
  ok: { mark: "ok  ", color: "green" },
  skipped: { mark: "skip", },
  warning: { mark: "warn", color: "yellow" },
  failed: { mark: "FAIL", color: "red" },
};

export function Frame(props: { screen: Screen; flow: Flow; step?: string; children: ReactNode }): ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">odd-claude</Text>
        <Text dimColor> | </Text>
        <Text bold>{TITLES[props.screen]}</Text>
        {props.step ? <Text dimColor>  {props.step}</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>{props.children}</Box>
      <Box marginTop={1}>
        <Text dimColor>{HINTS[props.screen]}</Text>
      </Box>
    </Box>
  );
}

const Pointer = ({ on }: { on: boolean }): ReactNode => <Text color="cyan">{on ? "> " : "  "}</Text>;

export function Menu(props: { items: string[]; cursor: number; detail?: (i: number) => string | undefined }): ReactNode {
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <Box key={item}>
          <Pointer on={i === props.cursor} />
          <Text bold={i === props.cursor}>{item}</Text>
          {props.detail?.(i) ? <Text dimColor>  {props.detail(i)}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

export function Welcome(props: { det: Detection | null; cursor: number; items: string[] }): ReactNode {
  const { det } = props;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        {det === null ? (
          <Text dimColor>checking the installation...</Text>
        ) : det.installedVersion ? (
          <Text>
            installed v{det.installedVersion}
            {det.updateAvailable ? <Text color="yellow">  update available: v{det.updateAvailable}</Text> : null}
          </Text>
        ) : (
          <Text dimColor>not installed</Text>
        )}
      </Box>
      <Menu items={props.items} cursor={props.cursor} />
    </Box>
  );
}

const Mark = ({ ok, warn }: { ok: boolean; warn?: boolean }): ReactNode => <Text color={ok ? "green" : warn ? "yellow" : "red"}>{ok ? "ok  " : warn ? "warn" : "miss"} </Text>;

export function DetectionView({ det }: { det: Detection | null }): ReactNode {
  if (det === null) return <Text dimColor>detecting...</Text>;
  const row = (label: string, mark: ReactNode, text: string): ReactNode => (
    <Box>
      {mark}
      <Box width={22}><Text>{label}</Text></Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column">
      {row("Node", <Mark ok={det.node.ok} />, `v${det.node.version}${det.node.ok ? "" : " (needs >= 22)"}`)}
      {row("Claude Code", <Mark ok={det.claude.present} warn />, det.claude.present ? det.claude.version ?? "found" : "not found: MCP registration and plugin migration are skipped")}
      {row("GitHub CLI (gh)", <Mark ok={det.gh.present && det.gh.authenticated} warn />, det.gh.present ? (det.gh.authenticated ? "authenticated" : "not authenticated: run gh auth login") : "not found: needed to download releases")}
      {row("Engram", <Mark ok={det.deps.engram} warn />, det.deps.engram ? "found" : "missing")}
      {row("codegraph", <Mark ok={det.deps.codegraph} warn />, det.deps.codegraph ? "found" : "missing")}
      {row("odd-claude", <Mark ok={det.installedVersion !== null} warn />, det.installedVersion ? `v${det.installedVersion}` : "not installed")}
      {det.pluginIds && det.pluginIds.length > 0
        ? row("Claude Code plugin", <Mark ok={false} warn />, `${det.pluginIds.join(", ")} found: it is uninstalled first and its state is migrated`)
        : row("Claude Code plugin", <Mark ok />, "none found")}
    </Box>
  );
}

export function ProfileView(props: { cursor: number; current: ModelSelection }): ReactNode {
  return (
    <Box flexDirection="column">
      {PROFILES.map((p, i) => (
        <Box key={p}>
          <Pointer on={i === props.cursor} />
          <Box width={11}><Text bold={i === props.cursor}>{p}</Text></Box>
          <Text dimColor>{p === "custom" ? "keep the current models and edit each one" : profileSummary(pickProfile(p, props.current))}{p === "balanced" ? "  (default)" : ""}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ModelsView(props: { selection: ModelSelection; cursor: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>profile </Text>
        <Text bold>{props.selection.profile}</Text>
      </Box>
      {PROFILE_ROLES.map((role, i) => {
        const on = i === props.cursor;
        return (
          <Box key={role}>
            <Pointer on={on} />
            <Box width={22}><Text bold={on}>{roleLabel(role)}</Text></Box>
            {(PROFILE_MODELS as readonly string[]).map((m) => (
              <Box key={m} width={9}>
                <Text bold={props.selection.roles[role] === m} dimColor={props.selection.roles[role] !== m} color={props.selection.roles[role] === m ? "cyan" : undefined}>
                  {props.selection.roles[role] === m ? `[${m}]` : ` ${m} `}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

export interface ExtraRow {
  id: string;
  label: string;
  checked: boolean;
  disabled?: string;
}

export function ExtrasView(props: { rows: ExtraRow[]; cursor: number; builtinError?: string; builtinsLoaded: boolean }): ReactNode {
  return (
    <Box flexDirection="column">
      {props.rows.map((r, i) => (
        <Box key={r.id}>
          <Pointer on={i === props.cursor} />
          <Text color={r.disabled ? undefined : r.checked ? "green" : undefined} dimColor={Boolean(r.disabled)}>{r.checked ? "[x] " : "[ ] "}</Text>
          <Text bold={i === props.cursor} dimColor={Boolean(r.disabled)}>{r.label}</Text>
          {r.disabled ? <Text dimColor>  ({r.disabled})</Text> : null}
        </Box>
      ))}
      {props.builtinError ? <Text color="yellow">builtin plugins unavailable: {props.builtinError}</Text> : !props.builtinsLoaded ? <Text dimColor>discovering builtin plugins...</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>checked = disabled by odd-claude; the previous values are restored on uninstall</Text>
      </Box>
    </Box>
  );
}

export function DepsView(props: { actions: DepAction[]; on: boolean }): ReactNode {
  const installable = props.actions.some((a) => a.status === "install");
  return (
    <Box flexDirection="column">
      {props.actions.map((a) => (
        <Box key={a.name} flexDirection="column">
          <Box>
            <Mark ok={a.status === "present"} warn={a.status !== "present"} />
            <Box width={12}><Text>{a.name === "engram" ? "Engram" : "codegraph"}</Text></Box>
            <Text dimColor>{a.status === "present" ? "found" : a.status === "install" ? `missing: ${a.steps.map((s) => [s.cmd, ...s.args].join(" ")).join("; ")}` : "missing"}</Text>
          </Box>
          {a.status === "manual" ? <Text color="yellow">   {a.instructions}</Text> : null}
        </Box>
      ))}
      {installable ? (
        <Box marginTop={1}>
          <Pointer on />
          <Text color={props.on ? "green" : undefined}>{props.on ? "[x] " : "[ ] "}</Text>
          <Text bold>Install the missing dependencies</Text>
        </Box>
      ) : (
        <Box marginTop={1}><Text dimColor>nothing to install</Text></Box>
      )}
    </Box>
  );
}

export function StepList({ steps, pending }: { steps: StepResult[]; pending?: boolean }): ReactNode {
  return (
    <Box flexDirection="column">
      {steps.map((s) => {
        const st = STATUS[s.status];
        return (
          <Box key={s.id}>
            <Text color={st.color} dimColor={!st.color}>{st.mark} </Text>
            <Box width={44} flexShrink={0}><Text wrap="truncate-end">{s.label}</Text></Box>
            <Box flexGrow={1}><Text dimColor wrap="truncate-end">{s.detail}</Text></Box>
          </Box>
        );
      })}
      {pending ? <Text dimColor>...</Text> : null}
    </Box>
  );
}

export function ReviewView(props: { flow: Flow; plan: FullResult | null; selection: ModelSelection }): ReactNode {
  return (
    <Box flexDirection="column">
      {props.flow === "models" ? (
        <Box flexDirection="column">
          <Text>apply profile <Text bold>{props.selection.profile}</Text> to the installed version:</Text>
          {PROFILE_ROLES.map((r) => (
            <Text key={r} dimColor>  {roleLabel(r).padEnd(20)} {props.selection.roles[r]}</Text>
          ))}
        </Box>
      ) : props.plan === null ? (
        <Text dimColor>planning (nothing is written)...</Text>
      ) : (
        <Box flexDirection="column">
          <StepList steps={props.plan.steps} />
          {props.plan.summary ? (
            <Box flexDirection="column" marginTop={1}>
              {props.plan.summary.split("\n").map((l) => (
                <Text key={l} dimColor wrap="truncate-end">{l}</Text>
              ))}
            </Box>
          ) : null}
          {!props.plan.ok ? <Text color="red">the plan failed; fix the failed step and go back</Text> : null}
        </Box>
      )}
      {props.flow === "install" && props.selection ? (
        <Box marginTop={1}>
          <Text dimColor>profile </Text>
          <Text bold>{props.selection.profile}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ConfirmView({ purge }: { purge: boolean }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>This removes the files odd-claude installed (only those still unchanged), its hooks, MCP servers and extras, and restores your previous settings.json values.</Text>
      <Text dimColor>Engram and codegraph are left as they are.</Text>
      <Box marginTop={1}>
        <Pointer on />
        <Text color={purge ? "red" : undefined}>{purge ? "[x] " : "[ ] "}</Text>
        <Text bold>Also delete the data dir and the backups (purge)</Text>
      </Box>
    </Box>
  );
}

export function BackupsView(props: { backups: BackupInfo[]; cursor: number }): ReactNode {
  if (props.backups.length === 0) return <Text dimColor>No backups yet. They are made before odd-claude changes a file.</Text>;
  return (
    <Box flexDirection="column">
      {[...props.backups].reverse().map((b, i) => (
        <Box key={b.id}>
          <Pointer on={i === props.cursor} />
          <Text bold={i === props.cursor}>{b.id}</Text>
          <Text dimColor>  {b.files.length} files</Text>
        </Box>
      ))}
    </Box>
  );
}

export function CompleteView({ flow, result }: { flow: Flow; result: FullResult | null }): ReactNode {
  if (result === null) return <Text dimColor>...</Text>;
  const failed = result.steps.filter((s) => s.status === "failed").length;
  const warned = result.steps.filter((s) => s.status === "warning").length;
  const headline = !result.ok || failed > 0 ? <Text color="red" bold>Finished with errors</Text> : warned > 0 ? <Text color="yellow" bold>Done, with warnings</Text> : <Text color="green" bold>Done</Text>;
  return (
    <Box flexDirection="column">
      {headline}
      <Box marginTop={1} flexDirection="column"><StepList steps={result.steps} /></Box>
      <Box marginTop={1} flexDirection="column">
        {!result.ok ? (
          <Text>Nothing else was changed after the failed step. Fix it and run again; your files are in the backups.</Text>
        ) : flow === "uninstall" ? (
          <Text>Restart Claude Code to drop the hooks and the odd output style.</Text>
        ) : flow === "backups" ? (
          <Text>Restart Claude Code to pick up the restored files.</Text>
        ) : (
          <>
            <Text>Restart Claude Code so the hooks, agents and MCP servers load.</Text>
            <Text dimColor>The odd output style is already set in settings.json; there is no need to run /output-style.</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
