export const STATUSLINE_PATH = ["statusLine"];
/** `oddRoot` is the `current` link (or any dir holding `statusline/statusline.sh`). */
export function statusLineChanges(oddRoot) {
    const root = oddRoot.replace(/\/+$/, "");
    return [{ path: STATUSLINE_PATH, value: { type: "command", command: `bash "${root}/statusline/statusline.sh"` } }];
}
