// Status line: settings.json points at the script shipped in the payload (<oddRoot>/statusline/statusline.sh).
import type { SettingsChange } from "./managed-settings.js";

export const STATUSLINE_PATH: string[] = ["statusLine"];

/** `oddRoot` is the `current` link (or any dir holding `statusline/statusline.sh`). */
export function statusLineChanges(oddRoot: string): SettingsChange[] {
  const root = oddRoot.replace(/\/+$/, "");
  return [{ path: STATUSLINE_PATH, value: { type: "command", command: `bash "${root}/statusline/statusline.sh"` } }];
}
