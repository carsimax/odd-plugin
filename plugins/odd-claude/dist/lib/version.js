import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleRoot } from "./root.js";
/** odd-claude version, read from the `package.json` of the install root (single source of truth). */
export function pluginVersion(root = moduleRoot()) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof manifest.version !== "string") {
        throw new Error("package.json has no string `version`");
    }
    return manifest.version;
}
