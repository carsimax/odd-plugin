// Controller: owns the state, the key handling and the transitions (via the route table). The screens are pure views.
import { Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PROFILE_ROLES } from "../../src/lib/profiles.js";
import type { BackupInfo } from "../../src/installer/backup.js";
import type { BuiltinPlugin } from "../../src/installer/builtin-plugins.js";
import { planDeps } from "../../src/installer/deps.js";
import { DEFAULT_EXTRAS, type ExtrasOptions } from "../../src/installer/extras.js";
import type { ModelSelection } from "../../src/installer/models.js";
import type { Detection, FullResult, StepResult } from "../../src/installer/orchestrate.js";
import { PROFILES, builtinSelection, cycleRole, pickProfile } from "./logic.js";
import { backward, forward, path, type Flow, type Screen } from "./router.js";
import { BackupsView, CompleteView, ConfirmView, DepsView, DetectionView, ExtrasView, Frame, ModelsView, ProfileView, ReviewView, StepList, Welcome, type ExtraRow } from "./screens.js";
import type { RunRequest, Services } from "./services.js";

const MENU: { label: string; flow?: Flow }[] = [
  { label: "Install", flow: "install" },
  { label: "Update", flow: "update" },
  { label: "Configure models", flow: "models" },
  { label: "Manage backups", flow: "backups" },
  { label: "Uninstall", flow: "uninstall" },
  { label: "Quit" },
];

export interface AppProps {
  services: Services;
  initial: { selection?: ModelSelection; extras?: ExtrasOptions };
  onExit: (code: number) => void;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function App({ services, initial, onExit }: AppProps): ReactNode {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("welcome");
  const [flow, setFlow] = useState<Flow>("install");
  const [cursor, setCursor] = useState(0);
  const [det, setDet] = useState<Detection | null>(null);
  const [selection, setSelection] = useState<ModelSelection | null>(initial.selection ?? null);
  const base = initial.extras ?? DEFAULT_EXTRAS;
  const [statusLine, setStatusLine] = useState(base.statusLine);
  const [ai, setAi] = useState(base.claudeAi);
  const [builtins, setBuiltins] = useState<BuiltinPlugin[] | null>(null);
  const [builtinError, setBuiltinError] = useState<string | undefined>();
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [depsOn, setDepsOn] = useState(true);
  const [purge, setPurge] = useState(false);
  const [plan, setPlan] = useState<FullResult | null>(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [result, setResult] = useState<FullResult | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const runId = useRef(0);
  const chosenBackup = useRef<string | undefined>(undefined);

  const sel: ModelSelection = selection ?? det?.selection ?? { profile: "balanced", roles: {} };

  const request = useCallback((): RunRequest => {
    const builtin = builtins === null ? base.builtin : builtinSelection(builtins, disabled);
    const wantsDeps = depsOn && det !== null && planDeps(det.deps).some((a) => a.status === "install");
    return { flow, selection: sel, extras: { statusLine, claudeAi: ai, builtin }, deps: wantsDeps, purge, backupId: flow === "backups" ? chosenBackup.current : undefined };
  }, [flow, sel, statusLine, ai, builtins, disabled, depsOn, det, purge, base.builtin]);

  const go = useCallback((next: Screen): void => {
    setScreen(next);
    setCursor(0);
  }, []);

  const quit = useCallback((code = 0): void => {
    onExit(code);
    exit();
  }, [exit, onExit]);

  // Detection on mount and whenever the menu or the Detection screen shows.
  useEffect(() => {
    if (screen !== "welcome" && screen !== "detection") return;
    let live = true;
    services.detect().then((d) => live && setDet(d), () => live && setDet(null));
    return () => {
      live = false;
    };
  }, [screen, services]);

  // Builtin discovery once, when the Extras screen first shows.
  useEffect(() => {
    if (screen !== "extras" || builtins !== null || builtinError !== undefined) return;
    services.builtins().then(
      (r) => {
        if (r.ok) {
          setBuiltins(r.plugins);
          setDisabled(new Set(r.plugins.filter((p) => !p.protected).map((p) => p.id)));
        } else setBuiltinError(r.error);
      },
      (e) => setBuiltinError(errMsg(e)),
    );
  }, [screen, builtins, builtinError, services]);

  // Planning for the Review screen: a dry run, nothing is written.
  useEffect(() => {
    if (screen !== "review") return;
    setPlan(null);
    if (flow === "models") return;
    let live = true;
    services.plan(request()).then(
      (p) => live && setPlan(p),
      (e) => live && setPlan({ ok: false, dryRun: true, version: null, steps: [{ id: "plan", label: "Plan", status: "failed", detail: errMsg(e) }] }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // The run itself: live steps from onStep, then Complete.
  useEffect(() => {
    if (screen !== "installing") return;
    const id = ++runId.current;
    setSteps([]);
    setResult(null);
    services
      .run(request(), (s) => id === runId.current && setSteps((cur) => [...cur, s]))
      .catch((e): FullResult => ({ ok: false, dryRun: false, version: null, steps: [{ id: "run", label: "Run", status: "failed", detail: errMsg(e) }] }))
      .then((r) => {
        if (id !== runId.current) return;
        setResult(r);
        go(forward(flow, "installing") ?? "complete");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    if (screen === "backups") setBackups(services.backups());
  }, [screen, services]);

  const extraRows: ExtraRow[] = [
    { id: "statusline", label: "Status line (with the odd version)", checked: statusLine },
    { id: "ai-connectors", label: "Disable claude.ai connectors", checked: ai.connectors },
    { id: "ai-skills", label: "Disable claude.ai skills sync", checked: ai.skills },
    { id: "ai-plugins", label: "Disable claude.ai plugins sync", checked: ai.plugins },
    ...(builtins ?? []).map((b): ExtraRow => ({ id: b.id, label: `Disable ${b.id}`, checked: !b.protected && disabled.has(b.id), disabled: b.protected ? "protected" : undefined })),
  ];

  const rowsFor = (s: Screen): number => {
    switch (s) {
      case "welcome": return MENU.length;
      case "profile": return PROFILES.length;
      case "models": return PROFILE_ROLES.length;
      case "extras": return extraRows.length;
      case "backups": return backups.length;
      default: return 1;
    }
  };

  const enter = (): void => {
    switch (screen) {
      case "welcome": {
        const item = MENU[cursor]!;
        if (!item.flow) return quit(0);
        setFlow(item.flow);
        setSelection(initial.selection ?? det?.selection ?? null);
        setPurge(false);
        go(forward(item.flow, "welcome")!);
        return;
      }
      case "profile": {
        setSelection(pickProfile(PROFILES[cursor]!, sel));
        go(forward(flow, "profile")!);
        return;
      }
      case "review":
        if (flow !== "models" && plan !== null && !plan.ok) return;
        if (flow !== "models" && plan === null) return;
        return go("installing");
      case "backups": {
        const chosen = [...backups].reverse()[cursor];
        if (!chosen) return;
        chosenBackup.current = chosen.id;
        return go("installing");
      }
      case "installing":
        return;
      case "complete": {
        const back = backward(flow, "complete") ?? "welcome";
        if (back === "welcome") setFlow("install");
        return go(back);
      }
      default: {
        const next = forward(flow, screen);
        if (next) go(next);
      }
    }
  };

  const toggle = (): void => {
    if (screen === "extras") {
      const row = extraRows[cursor];
      if (!row || row.disabled) return;
      if (row.id === "statusline") setStatusLine((v) => !v);
      else if (row.id === "ai-connectors") setAi((v) => ({ ...v, connectors: !v.connectors }));
      else if (row.id === "ai-skills") setAi((v) => ({ ...v, skills: !v.skills }));
      else if (row.id === "ai-plugins") setAi((v) => ({ ...v, plugins: !v.plugins }));
      else setDisabled((cur) => {
        const next = new Set(cur);
        if (!next.delete(row.id)) next.add(row.id);
        return next;
      });
    } else if (screen === "deps") setDepsOn((v) => !v);
    else if (screen === "confirm") setPurge((v) => !v);
  };

  useInput((input, key) => {
    if (screen === "installing") return;
    if (input === "q") return quit(0);
    if (key.escape) {
      const back = backward(flow, screen);
      if (back) go(back);
      return;
    }
    if (key.return) return enter();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(rowsFor(screen) - 1, c + 1));
    if (input === " ") return toggle();
    if (screen === "models" && (key.leftArrow || key.rightArrow)) {
      const role = PROFILE_ROLES[cursor]!;
      setSelection(cycleRole(sel, role, key.rightArrow ? 1 : -1));
    }
  });

  const flowPath = path(flow);
  const stepNo = flowPath.indexOf(screen);
  const step = stepNo > 0 && flow === "install" ? `${stepNo}/${flowPath.length - 3}` : undefined;
  const deps = det ? planDeps(det.deps) : [];

  let body: ReactNode;
  switch (screen) {
    case "welcome": body = <Welcome det={det} cursor={cursor} items={MENU.map((m) => m.label)} />; break;
    case "detection": body = <DetectionView det={det} />; break;
    case "profile": body = <ProfileView cursor={cursor} current={sel} />; break;
    case "models": body = <ModelsView selection={sel} cursor={cursor} />; break;
    case "extras": body = <ExtrasView rows={extraRows} cursor={cursor} builtinError={builtinError} builtinsLoaded={builtins !== null} />; break;
    case "deps": body = <DepsView actions={deps} on={depsOn} />; break;
    case "review": body = <ReviewView flow={flow} plan={plan} selection={sel} />; break;
    case "confirm": body = <ConfirmView purge={purge} />; break;
    case "backups": body = <BackupsView backups={backups} cursor={cursor} />; break;
    case "installing": body = <StepList steps={steps} pending />; break;
    case "complete": body = <CompleteView flow={flow} result={result} />; break;
    default: body = <Text>?</Text>;
  }
  return (
    <Frame screen={screen} flow={flow} step={step}>
      {body}
    </Frame>
  );
}

