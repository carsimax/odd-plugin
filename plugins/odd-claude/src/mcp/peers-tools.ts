// The peers MCP tools (R07 P3): thin adapters over lib/peers (mailbox), lib/peer-grants (consent) and lib/peers-session (own id).
//
// Rules: input is validated against the tool's JSON schema before anything runs (violation = typed `invalid_input` result);
// arguments are copied into a null-prototype object and `__proto__`/`constructor`/`prototype` keys are rejected; send refuses
// (typed error, nothing written) unless the recipient granted THIS session; message contents are never logged, never echoed in
// an error and never part of a list; outputs are bounded; nothing is reported to anyone.
import { lstatSync, openSync, closeSync, fstatSync, readFileSync, statSync, constants } from "node:fs";
import { agentStatusPath, } from "../lib/agent-status.js";
import { isAllowed } from "../lib/peer-grants.js";
import { isValidSessionId, MAX_MESSAGE_BYTES, MAX_REASON_BYTES, MIN_REASON_BYTES, PeersError, send, type PeersOptions } from "../lib/peers.js";
import { resolveSessionId } from "../lib/peers-session.js";
import { listSessionIds, sessionStatePath } from "../lib/state.js";
import { validateSchema, type JsonSchema } from "./jsonschema.js";

export const MAX_LISTED = 50;
export const MAX_OUTPUT_BYTES = 64 * 1024;
const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9-]{7,63}$";
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface PeersToolContext {
  /** Data dir / env / clock for the stores. */
  opts: PeersOptions;
  /** Pid of this process's parent (the Claude Code process), the key of the SessionStart hook entry. */
  pid: number;
}

export interface PeersToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  run: (args: Record<string, unknown>, ctx: PeersToolContext) => ToolResult;
}

function ok(body: unknown): ToolResult {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) return fail("output_too_large", `the result is larger than ${MAX_OUTPUT_BYTES} bytes and was dropped`);
  return { content: [{ type: "text", text }] };
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message: message.slice(0, 500), ...extra } }) }], isError: true };
}

const UNKNOWN_GUIDANCE =
  "This session's id is not known to the peers server. Run `/odd-peers` (it shows the id) or restart the session so the SessionStart hook records it; the human then grants with `/odd-peers allow <id>` in the recipient session.";

// ---- list helpers ----

interface SessionInfo {
  session_id: string;
  cwd: string | null;
  last_seen: string | null;
  accepts_messages_from_you: boolean;
}

function readSmallJson(path: string): Record<string, unknown> | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(fd).size > 16 * 1024) return null;
      const v = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function describeSession(id: string, me: string | null, opts: PeersOptions): SessionInfo {
  let cwd: string | null = null;
  let lastSeen: string | null = null;
  const status = readSmallJson(agentStatusPath(id, opts));
  if (status !== null) {
    if (typeof status.cwd === "string") cwd = status.cwd.slice(0, 1024);
    if (typeof status.updatedAt === "string" && Number.isFinite(Date.parse(status.updatedAt))) lastSeen = new Date(Date.parse(status.updatedAt)).toISOString();
  }
  if (lastSeen === null) {
    try {
      lastSeen = new Date(statSync(sessionStatePath(id, opts)).mtimeMs).toISOString();
    } catch {
      lastSeen = null;
    }
  }
  return { session_id: id, cwd, last_seen: lastSeen, accepts_messages_from_you: me !== null && isAllowed(id, me, opts) };
}

// ---- tools ----

const NO_ARGS: JsonSchema & { type: "object" } = { type: "object", properties: {}, additionalProperties: false };

export const PEERS_TOOLS: readonly PeersToolDefinition[] = [
  {
    name: "odd_orchestrator_session_id",
    description: "Returns this session's id (the one other sessions use to address it and the human uses in `/odd-peers allow <id>`), or session_id null with guidance when it is not known.",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (_args, ctx) => {
      const me = resolveSessionId(ctx.pid, ctx.opts);
      return me === null ? ok({ session_id: null, source: "unknown", guidance: UNKNOWN_GUIDANCE }) : ok({ session_id: me.session_id, source: me.source });
    },
  },
  {
    name: "odd_orchestrator_list",
    description: `Lists up to ${MAX_LISTED} other known sessions on this machine: id, cwd, last seen and whether each accepts messages from this session (the human's grant). Closed by default.`,
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (_args, ctx) => {
      const me = resolveSessionId(ctx.pid, ctx.opts)?.session_id ?? null;
      const all = listSessionIds(ctx.opts).filter((id) => isValidSessionId(id) && id !== me);
      const sessions = all.slice(0, MAX_LISTED).map((id) => describeSession(id, me, ctx.opts));
      return ok({
        self: me,
        sessions,
        truncated: all.length > MAX_LISTED,
        ...(me === null ? { note: UNKNOWN_GUIDANCE } : {}),
      });
    },
  },
  {
    name: "odd_orchestrator_send_message",
    description: `Queues a short message for another session; it is delivered on that session's next prompt as untrusted data. Refused unless the recipient's human granted this session. Message at most ${MAX_MESSAGE_BYTES} bytes, reason ${MIN_REASON_BYTES}-${MAX_REASON_BYTES} bytes. Never include secrets. "accepted" is not a read receipt.`,
    inputSchema: {
      type: "object",
      properties: {
        recipient_session_id: { type: "string", pattern: ID_PATTERN, description: "Id of the recipient session (from odd_orchestrator_list)." },
        message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_BYTES, description: `The message, at most ${MAX_MESSAGE_BYTES} bytes (UTF-8).` },
        reason: { type: "string", minLength: 3, maxLength: MAX_REASON_BYTES, description: `Why you are sending it, ${MIN_REASON_BYTES}-${MAX_REASON_BYTES} bytes (UTF-8).` },
      },
      required: ["recipient_session_id", "message", "reason"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => {
      const recipient = args.recipient_session_id as string;
      const message = args.message as string;
      const reason = args.reason as string;
      const me = resolveSessionId(ctx.pid, ctx.opts)?.session_id ?? null;
      if (me === null) return fail("session_unknown", "this session's id is not known, so consent cannot be checked", { guidance: UNKNOWN_GUIDANCE });
      if (recipient === me) return fail("self_recipient", "the recipient is this session");
      if (!isAllowed(recipient, me, ctx.opts)) {
        return fail("not_granted", "the recipient has not granted this session; ask the human to run `/odd-peers allow <id>` in the recipient session with this session's id", { sender: me });
      }
      try {
        const r = send(recipient, { from: me, reason, message }, ctx.opts);
        return ok({ accepted: true, seq: r.seq, note: "accepted, not a read receipt" });
      } catch (e) {
        if (e instanceof PeersError) return fail(e.code, e.message);
        throw e;
      }
    },
  },
];

export const PEERS_TOOL_BY_NAME: ReadonlyMap<string, PeersToolDefinition> = new Map(PEERS_TOOLS.map((t) => [t.name, t]));

/** Copies the arguments into a null-prototype object; returns the rejected key when a forbidden one is present. */
export function coerceArguments(raw: Record<string, unknown>): { args: Record<string, unknown> } | { forbidden: string } {
  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key)) return { forbidden: key };
    args[key] = raw[key];
  }
  return { args };
}

export function callPeersTool(tool: PeersToolDefinition, raw: Record<string, unknown>, ctx: PeersToolContext): ToolResult {
  const c = coerceArguments(raw);
  if ("forbidden" in c) return fail("invalid_input", `forbidden argument name: ${c.forbidden}`);
  const errors = validateSchema(tool.inputSchema, c.args);
  if (errors.length > 0) return fail("invalid_input", "the arguments do not match the tool's input schema", { problems: errors });
  return tool.run(c.args, ctx);
}
