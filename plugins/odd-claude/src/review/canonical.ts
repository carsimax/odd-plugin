// Canonical JSON and domain-separated hashing for the review engine (U1).
//
// ONE canonical form: object keys sorted by UTF-16 code unit, no whitespace, strings and numbers
// exactly as JSON.stringify emits them (JSON-spec numbers; -0 is "0"), UTF-8 on the wire.
// Anything that JSON cannot represent is rejected instead of silently dropped, because a silent
// drop would let two different inputs hash alike. Never hash JSON.stringify output of an unsorted
// object: always go through canonicalJson.
import { createHash } from "node:crypto";

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

function describe(path: string): string {
  return path === "" ? "value" : path;
}

function canonicalize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalError(`Canonical JSON rejects non-finite number at ${describe(path)}`);
      return JSON.stringify(value);
    case "undefined":
      throw new CanonicalError(`Canonical JSON rejects undefined at ${describe(path)}`);
    case "object":
      break;
    default:
      throw new CanonicalError(`Canonical JSON rejects ${typeof value} at ${describe(path)}`);
  }
  const obj = value as object;
  if (ancestors.has(obj)) throw new CanonicalError(`Canonical JSON rejects a cycle at ${describe(path)}`);
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) items.push(canonicalize(obj[i], `${path}[${i}]`, ancestors));
      return `[${items.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalError(`Canonical JSON rejects a non-plain object at ${describe(path)}`);
    }
    const record = obj as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, ancestors)}`);
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "", new Set());
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

const DOMAIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "sha256:" + hex(SHA-256("odd-claude.<domain>/v<version>\0" + canonicalJson(value))). */
export function domainHash(domain: string, version: number, value: unknown): string {
  if (!DOMAIN_RE.test(domain)) throw new CanonicalError("Canonical hash domain is invalid");
  if (!Number.isSafeInteger(version) || version < 1) throw new CanonicalError("Canonical hash version is invalid");
  const digest = createHash("sha256").update(`odd-claude.${domain}/v${version}\0${canonicalJson(value)}`, "utf8").digest("hex");
  return `sha256:${digest}`;
}
