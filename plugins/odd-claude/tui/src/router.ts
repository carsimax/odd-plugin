// Route table: every screen of every flow with its Forward and Backward neighbor (Esc = Backward, Enter on the
// last input of a screen = Forward). A linear route table, one per flow.
export type Screen = "welcome" | "detection" | "profile" | "models" | "extras" | "deps" | "review" | "confirm" | "backups" | "installing" | "complete";
export type Flow = "install" | "update" | "models" | "uninstall" | "backups";

export interface Route {
  forward?: Screen;
  backward?: Screen;
}

export const ROUTES: Record<Flow, Partial<Record<Screen, Route>>> = {
  install: {
    welcome: { forward: "detection" },
    detection: { forward: "profile", backward: "welcome" },
    profile: { forward: "models", backward: "detection" },
    models: { forward: "extras", backward: "profile" },
    extras: { forward: "deps", backward: "models" },
    deps: { forward: "review", backward: "extras" },
    review: { forward: "installing", backward: "deps" },
    installing: { forward: "complete" },
    complete: { backward: "welcome" },
  },
  models: {
    welcome: { forward: "profile" },
    profile: { forward: "models", backward: "welcome" },
    models: { forward: "review", backward: "profile" },
    review: { forward: "installing", backward: "models" },
    installing: { forward: "complete" },
    complete: { backward: "welcome" },
  },
  update: {
    welcome: { forward: "review" },
    review: { forward: "installing", backward: "welcome" },
    installing: { forward: "complete" },
    complete: { backward: "welcome" },
  },
  uninstall: {
    welcome: { forward: "confirm" },
    confirm: { forward: "installing", backward: "welcome" },
    installing: { forward: "complete" },
    complete: { backward: "welcome" },
  },
  backups: {
    welcome: { forward: "backups" },
    backups: { forward: "installing", backward: "welcome" },
    installing: { forward: "complete" },
    complete: { backward: "backups" },
  },
};

export const forward = (flow: Flow, screen: Screen): Screen | undefined => ROUTES[flow][screen]?.forward;
export const backward = (flow: Flow, screen: Screen): Screen | undefined => ROUTES[flow][screen]?.backward;

/** Screens of a flow in forward order, from the welcome menu. */
export function path(flow: Flow): Screen[] {
  const out: Screen[] = ["welcome"];
  for (let s = forward(flow, "welcome"); s && !out.includes(s); s = forward(flow, s)) out.push(s);
  return out;
}
