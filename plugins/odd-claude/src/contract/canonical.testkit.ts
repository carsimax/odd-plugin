// Test-only reference canonical JSON and domain hash, derived independently of any implementation (sorted keys in UTF-16 code unit
// order, no whitespace, JSON.stringify for scalars; hash = sha256 of "odd-claude.<domain>/v<version>\0<canonical text>").
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const domainHash = (domain: string, version: number, v: unknown): string =>
  `sha256:${createHash("sha256").update(`odd-claude.${domain}/v${version}\0${canonicalJson(v)}`, "utf8").digest("hex")}`;
