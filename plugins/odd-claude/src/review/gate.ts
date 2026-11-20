// RDD delivery gate (U14): decides whether a Bash command that delivers work (`git push`, `gh pr create|merge`)
// may run. Decision S3: this and the Stop settle reminder are the only blocks the plugin may emit, and only while
// RDD is on. The module is read-only: it never starts a review, never answers consent and never writes authority.
//
// Reference: the upstream shell's delivery preflight and its command recognizer (`review-delivery-preflight`,
// `recognizeReviewDeliveryActions`; see docs/research/rdd-engine-map.md section 7). Written new; the policies below
// follow it unless stated.
//
// DETECTION (lexical, like the reference; not a shell interpreter):
//  - command position only: quoted text, `echo`/`grep` arguments, comments, heredoc bodies (quoted delimiter, or
//    unquoted with only its `$(..)`/backtick substitutions scanned) and `git pushx` are never deliveries.
//  - recognised heads: assignments, `env sudo command exec nohup timeout xargs time nice builtin setsid stdbuf`,
//    reserved words, `git [-C d] [-c k=v] [--no-pager ...] push`, `gh [-R r] pr create|merge`, `sh|bash|zsh|dash|ksh
//    -c <payload>`, `eval`, `$(..)`, backticks, `( )`, `{ }`, pipes, `&&`, `||`, `;`, `&`, newlines.
//  - exempt (reference): `git push` with --dry-run/-n/--delete/-d. Only `gh pr create|merge` are `gh` deliveries.
//  - routing the lexer cannot resolve (`cd $X`, a `cd` that is not a leading `cd d &&` chain, `pushd`, `GIT_DIR=..`,
//    `--git-dir`, `env -C`, `export GIT_DIR=..`, `-C "$v"`): the delivery is `unresolved`.
//  - nesting deeper than 8 levels: the reference drops it; here it is an opaque (unresolved) delivery when the text
//    names git+push or gh+pr, so depth cannot launder a delivery.
//  - a detection exception (it is total on the hostile corpus in gate.spec) would read as "no delivery".
//
// POLICY once RDD is on for the repository the delivery reaches (any off wins, `mode.ts`):
//  - a chain that also changes the candidate (commit, merge, rebase, reset, checkout, switch, cherry-pick, revert,
//    am, pull, update-ref) is refused whatever the risk: the range being delivered does not exist yet (reference).
//    A delivery in the background is still assessed: the check runs before the command (this differs from the
//    reference, which refuses it, without weakening the gate).
//  - an unresolved repository is refused (reference) when the session's repository has RDD on; with RDD off there
//    it is allowed (S3: blocking only with RDD on). When the session cwd is not a repository at all, the GLOBAL
//    switch decides (on: refused, off: allowed).
//  - a review of the WORKSPACE (current-changes) does not authorize delivering a committed range: the candidate
//    identity includes the snapshot kind (as upstream), and there is deliberately no "reviewed delivery must be one
//    commit" rule (upstream only declares ErrReviewedDeliveryNotOneCommit; its gates act on reviewDue + decline).
//    Deliver by reviewing the committed range (committed-only) or by declining it.
//  - the candidate is the COMMITTED range merge-base(HEAD, base)..HEAD (base-diff, committed-only, never the
//    workspace or untracked files). The base: for `git push`, the destination's remote-tracking branch (explicit
//    remote/refspec), else `@{push}`/`@{upstream}`, else `<remote>/HEAD`, else `origin/HEAD`; for `gh pr`,
//    `origin/<--base>`, else `origin/HEAD`, else `@{upstream}`. No resolvable base: refused (reference: "select the
//    actual committed range"). A pushed refspec whose source is a branch/commit other than HEAD, and `--all` /
//    `--mirror`, cannot be assessed against HEAD and are refused. A pushed TAG is assessed as the HEAD range only if
//    it is HEAD or an ancestor of HEAD (`merge-base --is-ancestor`, strict; a tag that is not a commit counts as
//    outside); any other tag ships commits the HEAD range does not contain: `unassessable_ref`. `--tags` is
//    refused if ANY local tag is outside HEAD's history (`for-each-ref --no-merged HEAD refs/tags`; conservative:
//    it cannot know which tags the remote already has); `--follow-tags` needs no check (it only sends tags
//    reachable from the pushed history). Residual: a name that is both a branch and a tag is read as the tag.
//  - allow: empty range (HEAD already in the base), not due (low/medium risk; due = high, `assessCandidate`), a
//    valid receipt for the exact candidate identity (consumed; after a validated correction the lineage's target
//    IS the corrected identity, so the corrected range is the consumed one), or an explicit decline of that exact
//    identity. Unknown consumption (unreadable lineage, missing receipt) is NOT consumed.
//  - FAIL CLOSED (reference): with RDD on and a delivery detected, any internal error, blown time budget or
//    ambiguity refuses with a reason that names the off switch. Before RDD is known to be on nothing can refuse: a
//    repository or mode that cannot be read is "off" (mode.ts), and a non-repository directory is allowed.
//  - ONE RULE when git cannot resolve the repository (failure, timeout) or does not trust it (`untrusted_repository`:
//    exit 128 + `fatal: detected dubious ownership`/`unsafe repository` AND the safe.directory hint, as upstream):
//    mode.ts reads the clone override DIRECTLY from the nearest `.git` (a directory; a `.git` file is followed through
//    `gitdir:` and `commondir`, read with O_NOFOLLOW, regular files, size-capped; a symlink to a directory is
//    resolved). The nearest `.git` decides, so a nested repository never borrows a parent's off. Off: allowed (also
//    for an unresolved delivery). Otherwise, or if the `.git` cannot be followed (never assumed off), the GLOBAL
//    switch decides: on denies (`check_failed`, or `unresolved_directory` for an unresolved delivery), off is silent.
//    An untrusted repository is therefore NOT waved through: a `-c safe.directory` or GIT_CONFIG_* override in the
//    command would make git work, so with global on and no readable off the delivery is denied.
//
// TIME: every git call is bounded one by one (default 5 s) AND the whole check by a hard deadline (default 20 s):
// `checkDelivery` fixes `deadlineAt = start + budget` and threads it (SnapshotOptions.deadlineAt, ModeOptions.deadlineAt,
// GitCall.deadlineAt) into EVERY git invocation, including those of resolveRepository, readReviewMode and the candidate
// assessment, so each call gets min(per-call bound, time left) and none starts once the budget is spent. A spent
// budget with RDD on is `check_failed`; the mode is always read first, and a mode read that runs out of budget falls
// back to the direct `.git` override read and then the global switch (RDD off never denies). Why it must be hard:
// Claude Code treats a hook that exceeds its `timeout` (hooks.json: 30 s) as a non-blocking error and LETS the
// command run, which would be fail-open exactly when git is slow. Arithmetic: 30 s hook timeout - 20 s budget = 10 s
// of margin for Node startup, the lexer, fs reads, a git child that needs a moment to die after SIGKILL, and writing
// the decision. A test pins budget + margin < the hooks.json timeout.
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StateOptions } from "../lib/state.js";
import { isTargetConsumed } from "./ack.js";
import { readDecline, shellQuote } from "./consent.js";
import { readReviewMode } from "./mode.js";
import { assessCandidate } from "./risk.js";
import { resolveRepository, runGit, SnapshotError } from "./snapshot.js";

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

interface Word {
  op: false;
  value: string;
  /** No quote or escape in the raw word. */
  plain: boolean;
  /** Command substitution bodies found inside the word. */
  subs: string[];
}
interface Op {
  op: true;
  raw: string;
}
type Tok = Word | Op;

const MAX_DEPTH = 8;

/** `s[start..]` follows `$(`; returns the body up to the matching `)` and the index after it. */
function captureParen(s: string, start: number): { body: string; end: number } {
  let depth = 1;
  let i = start;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { body: s.slice(start, i), end: i + 1 };
    i++;
  }
  return { body: s.slice(start), end: s.length };
}

/** `s[start..]` follows an opening backtick. */
function captureBacktick(s: string, start: number): { body: string; end: number } {
  let i = start;
  while (i < s.length && s[i] !== "`") i += s[i] === "\\" ? 2 : 1;
  const body = s.slice(start, Math.min(i, s.length)).replace(/\\([\\$`])/g, "$1");
  return { body, end: Math.min(i + 1, s.length) };
}

/** Substitutions of an unquoted heredoc body: the only part of it the shell executes. */
function substitutionsOf(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") i++;
    else if (c === "$" && text[i + 1] === "(") {
      const cap = captureParen(text, i + 2);
      out.push(cap.body);
      i = cap.end - 1;
    } else if (c === "`") {
      const cap = captureBacktick(text, i + 1);
      out.push(cap.body);
      i = cap.end - 1;
    }
  }
  return out;
}

const REDIRECT_OP = /^(?:<<<|<<-?|<>|<&|>&|>\||>>|>|<)/;

function lex(s: string): { tokens: Tok[]; loose: string[] } {
  const tokens: Tok[] = [];
  const loose: string[] = [];
  const pending: { name: string; dash: boolean; quoted: boolean }[] = [];
  let value = "";
  let plain = true;
  let has = false;
  let subs: string[] = [];
  let dropNext = false;
  const flush = (): void => {
    if (!has) return;
    if (dropNext) {
      loose.push(...subs);
      dropNext = false;
    } else tokens.push({ op: false, value, plain, subs });
    value = "";
    plain = true;
    has = false;
    subs = [];
  };
  const op = (raw: string): void => {
    flush();
    dropNext = false;
    tokens.push({ op: true, raw });
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
    } else if (c === "\\") {
      if (s[i + 1] === "\n") i += 2;
      else if (i + 1 < n) {
        value += s[i + 1];
        has = true;
        plain = false;
        i += 2;
      } else i++;
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      const stop = e < 0 ? n : e;
      value += s.slice(i + 1, stop);
      has = true;
      plain = false;
      i = stop + 1;
    } else if (c === '"') {
      has = true;
      plain = false;
      i++;
      while (i < n && s[i] !== '"') {
        const d = s[i]!;
        if (d === "\\" && i + 1 < n) {
          const e = s[i + 1]!;
          if (e !== "\n") value += '"\\$`'.includes(e) ? e : d + e;
          i += 2;
        } else if (d === "$" && s[i + 1] === "(") {
          const cap = captureParen(s, i + 2);
          subs.push(cap.body);
          i = cap.end;
        } else if (d === "`") {
          const cap = captureBacktick(s, i + 1);
          subs.push(cap.body);
          i = cap.end;
        } else {
          value += d;
          i++;
        }
      }
      i++;
    } else if (c === "$" && s[i + 1] === "(") {
      const cap = captureParen(s, i + 2);
      subs.push(cap.body);
      has = true;
      plain = false;
      i = cap.end;
    } else if (c === "`") {
      const cap = captureBacktick(s, i + 1);
      subs.push(cap.body);
      has = true;
      plain = false;
      i = cap.end;
    } else if (c === "#" && !has) {
      while (i < n && s[i] !== "\n") i++;
    } else if (c === "\n") {
      op("\n");
      i++;
      // heredoc bodies start after the line that declared them
      while (pending.length > 0) {
        const h = pending.shift()!;
        let body = "";
        while (i < n) {
          const nl = s.indexOf("\n", i);
          const end = nl < 0 ? n : nl;
          let line = s.slice(i, end).replace(/\r$/, "");
          i = nl < 0 ? n : nl + 1;
          if (h.dash) line = line.replace(/^\t+/, "");
          if (line === h.name) break;
          body += line + "\n";
        }
        if (!h.quoted) loose.push(...substitutionsOf(body));
      }
    } else if (c === ";") {
      op(";");
      i += s[i + 1] === ";" ? 2 : 1;
    } else if (c === "&") {
      if (s[i + 1] === "&") {
        op("&&");
        i += 2;
      } else if (s[i + 1] === ">") {
        flush();
        i += s[i + 2] === ">" ? 3 : 2;
        dropNext = true;
      } else {
        op("&");
        i++;
      }
    } else if (c === "|") {
      if (s[i + 1] === "|") {
        op("||");
        i += 2;
      } else {
        op("|");
        i += s[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === "(" || c === ")") {
      op(c);
      i++;
    } else if (c === "<" || c === ">") {
      if (s[i + 1] === "(") {
        op("(");
        i += 2;
        continue;
      }
      if (has && plain && /^\d+$/.test(value)) {
        value = "";
        has = false;
        subs = [];
      } else flush();
      const m = REDIRECT_OP.exec(s.slice(i, i + 3))![0];
      i += m.length;
      if (m === "<<" || m === "<<-") {
        while (s[i] === " " || s[i] === "\t") i++;
        const raw = /^[^\s;&|()<>]+/.exec(s.slice(i))?.[0] ?? "";
        i += raw.length;
        pending.push({ name: raw.replace(/['"\\]/g, ""), dash: m === "<<-", quoted: /['"\\]/.test(raw) });
      } else dropNext = true;
    } else {
      value += c;
      has = true;
      i++;
    }
  }
  flush();
  return { tokens, loose };
}

// ---------------------------------------------------------------------------------------------
// recognition
// ---------------------------------------------------------------------------------------------

export interface DeliveryAction {
  kind: "change" | "delivery";
  tool?: "git-push" | "gh-pr";
  /** Arguments after `push` / after `pr create|merge`. */
  args: string[];
  /** Directories to enter, in order, relative to the session cwd (leading `cd d &&` chain, then `-C d`). */
  directories: string[];
  /** The repository the command reaches cannot be established from the text. */
  unresolved: boolean;
  /** Reached through nesting deeper than the bound. */
  opaque?: boolean;
}

interface Ctx {
  directories: string[];
  unresolved: boolean;
}

const WRAPPERS = ["env", "sudo", "command", "exec", "nohup", "timeout", "xargs", "time", "nice", "builtin", "setsid", "stdbuf"];
const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-C", "--chdir"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "--user", "--group", "--host", "--prompt", "--chdir"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-n", "-I", "-P", "--max-args", "--replace", "--max-procs"],
  nice: ["-n", "--adjustment"],
  time: ["-f", "-o", "--format", "--output"],
  stdbuf: ["-i", "-o", "-e"],
};
const RESERVED = new Set(["then", "else", "elif", "do", "{", "!", "if", "while", "until"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const CHANGES = new Set(["commit", "merge", "rebase", "reset", "checkout", "switch", "cherry-pick", "revert", "am", "pull", "update-ref"]);
const base = (v: string): string => (v.split("/").at(-1) ?? v).replace(/\.exe$/i, "");
const badDir = (w: Word): boolean => /[\n\r$`~]/.test(w.value) || w.subs.length > 0;
const DRY_OR_DELETE = (a: string): boolean => a === "--dry-run" || a === "-n" || a === "--delete" || a === "-d" || /^-[fnduqv46]*[nd][fnduqv46]*$/.test(a);
const PUSH_VALUE_OPTIONS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

/** A dry run or a ref removal. The value of -o/--push-option/--receive-pack/--exec/--repo is a value, and `--` ends the options. */
function pushIsExempt(rest: readonly string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") return false;
    if (PUSH_VALUE_OPTIONS.has(a)) i++;
    else if (DRY_OR_DELETE(a)) return true;
  }
  return false;
}

/** Index of the executable after reserved words, assignments and familiar wrappers. */
function headCursor(words: readonly Word[], onRouting: () => void): number {
  let cursor = 0;
  while (cursor < words.length && words[cursor]!.plain && RESERVED.has(words[cursor]!.value)) cursor++;
  while (cursor < words.length) {
    const value = words[cursor]!.value;
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
      if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE)=/.test(value)) onRouting();
      cursor++;
      continue;
    }
    const name = base(value);
    if (!WRAPPERS.includes(name)) break;
    cursor++;
    while (cursor < words.length && words[cursor]!.value.startsWith("-")) {
      const flag = words[cursor++]!.value;
      if (flag === "--") break;
      if (name === "env" && /^(?:-C.*|--chdir(?:=|$))/.test(flag)) onRouting();
      if (name === "sudo" && /^(?:-D.*|--chdir(?:=|$))/.test(flag)) onRouting();
      if (WRAPPER_VALUE_OPTIONS[name]?.includes(flag)) cursor++;
    }
    if (name === "timeout") cursor++;
  }
  return cursor;
}

function analyze(command: string, depth: number, inherited: Ctx): DeliveryAction[] {
  if (depth > MAX_DEPTH) {
    const named = (command.includes("git") && command.includes("push")) || (command.includes("gh") && command.includes("pr"));
    return named ? [{ kind: "delivery", tool: "git-push", args: [], directories: [...inherited.directories], unresolved: true, opaque: true }] : [];
  }
  const { tokens, loose } = lex(command);
  const out: DeliveryAction[] = [];
  const ambiguousCd = tokens.some((t) => t.op && !["&&", "||", "|"].includes(t.raw));
  const dirs: string[] = [];
  let unresolved = false;
  let leadingCd = true;

  const segs: { words: Word[]; before?: string; after?: string }[] = [];
  let cur: { words: Word[]; before?: string; after?: string } = { words: [] };
  for (const t of tokens) {
    if (t.op) {
      cur.after = t.raw;
      segs.push(cur);
      cur = { words: [], before: t.raw };
    } else cur.words.push(t);
  }
  segs.push(cur);

  for (const seg of segs) {
    if (seg.before === "||" && dirs.length > 0) unresolved = true;
    const words = seg.words;
    if (words.length === 0) continue;
    let unresolvedPrefix = false;
    const cursor = headCursor(words, () => {
      unresolvedPrefix = true;
    });
    const name = words[cursor] === undefined ? "" : base(words[cursor]!.value);
    const args = words.slice(cursor + 1);
    const argv = args.map((w) => w.value);
    if (name === "export" && argv.some((a) => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE)(?:=|$)/.test(a))) unresolved = true;
    if (name === "cd") {
      const a = args[0];
      if (leadingCd && !ambiguousCd && (seg.before === undefined || seg.before === "&&") && cursor === 0 && seg.after === "&&" && args.length === 1 && a !== undefined && !badDir(a) && !a.value.startsWith("-")) dirs.push(a.value);
      else unresolved = true;
    }
    if (name === "pushd" || name === "popd") unresolved = true;
    if (name !== "cd") leadingCd = false;
    const ctx: Ctx = { directories: [...inherited.directories, ...dirs], unresolved: inherited.unresolved || unresolved || unresolvedPrefix };

    for (const w of words) for (const sub of w.subs) out.push(...analyze(sub, depth + 1, ctx));

    if (name === "git") {
      let idx = 0;
      const gitDirs: string[] = [];
      let unresolvedGit = false;
      while (idx < args.length && argv[idx]!.startsWith("-")) {
        const a = argv[idx]!;
        if (a === "-C") {
          const next = args[idx + 1];
          if (next === undefined || badDir(next)) unresolvedGit = true;
          else gitDirs.push(next.value);
          idx += 2;
        } else if (a.startsWith("-C") && a.length > 2) {
          if (badDir(args[idx]!)) unresolvedGit = true;
          else gitDirs.push(a.slice(2));
          idx++;
        } else if (a === "-c") idx += 2;
        else if (["--git-dir", "--work-tree", "--namespace"].includes(a)) {
          unresolvedGit = true;
          idx += 2;
        } else if (/^--(?:git-dir|work-tree|namespace)=/.test(a)) {
          unresolvedGit = true;
          idx++;
        } else idx++;
      }
      const sub = argv[idx];
      if (sub === "push") {
        const rest = argv.slice(idx + 1);
        if (pushIsExempt(rest)) continue;
        out.push({ kind: "delivery", tool: "git-push", args: rest, directories: [...ctx.directories, ...gitDirs], unresolved: ctx.unresolved || unresolvedGit });
      } else if (sub !== undefined && CHANGES.has(sub)) out.push({ kind: "change", args: [], directories: [], unresolved: false });
    } else if (name === "gh") {
      let idx = 0;
      while (idx < argv.length && argv[idx]!.startsWith("-")) idx += ["-R", "--repo"].includes(argv[idx]!) ? 2 : 1;
      if (argv[idx] === "pr" && (argv[idx + 1] === "create" || argv[idx + 1] === "merge")) {
        out.push({ kind: "delivery", tool: "gh-pr", args: argv.slice(idx + 2), directories: [...ctx.directories], unresolved: ctx.unresolved });
      }
    } else if (SHELLS.has(name) || name === "eval") {
      const flag = argv.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const payload = name === "eval" ? (argv[0] === "--" ? argv.slice(1) : argv).join(" ") : flag >= 0 ? argv[flag + 1] : undefined;
      if (payload) out.push(...analyze(payload, depth + 1, ctx));
    }
  }
  const tail: Ctx = { directories: [...inherited.directories, ...dirs], unresolved: inherited.unresolved || unresolved };
  for (const sub of loose) out.push(...analyze(sub, depth + 1, tail));
  return out;
}

/** Deliveries and candidate-changing commands of a Bash command line, in text order (nested forms last). */
export function recognizeDeliveryActions(command: string): DeliveryAction[] {
  return analyze(command, 0, { directories: [], unresolved: false });
}

// ---------------------------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------------------------

export interface GateOptions extends StateOptions {
  /** Per git command bound (default 5 s). */
  gitTimeoutMs?: number;
  /** Whole-check budget in ms (default 20 s); a negative value is already spent (test seam). */
  deadlineMs?: number;
  /** Candidate assessment (test seam; defaults to `assessCandidate`). */
  assess?: typeof assessCandidate;
  /** git runner (test seam; defaults to `runGit`). */
  git?: typeof runGit;
}

export type GateAllow = "no_delivery" | "rdd_off" | "not_a_repository" | "empty_range" | "not_due" | "consumed" | "declined";
export type GateCode = "mixed_chain" | "unresolved_directory" | "no_base" | "unassessable_ref" | "review_due" | "check_failed";
export type GateResult = { allowed: true; reason: GateAllow } | { allowed: false; code: GateCode; reason: string };

export const DEFAULT_GIT_MS = 5000;
export const DEFAULT_BUDGET_MS = 20_000;

function pluginRoot(opts: StateOptions): string {
  const fromEnv = (opts.env ?? process.env).CLAUDE_PLUGIN_ROOT;
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : join(fileURLToPath(import.meta.url), "..", "..", "..");
}

function offText(root: string, opts: StateOptions): string {
  const cmd = (verb: string): string => `node ${shellQuote(join(pluginRoot(opts), "dist", "cli", "review-mode.js"))} ${verb}`;
  return `To turn review-driven development off, the human can run: ${cmd("disable")} (user-wide), or ${cmd(`disable --scope clone --cwd ${shellQuote(root)}`)} (this repository only).`;
}

const NOT_RUN = "This delivery command was not run.";
const unresolvedRefusal = (root: string, opts: StateOptions): GateResult =>
  refusal(
    "unresolved_directory",
    root,
    opts,
    "the delivery repository cannot be resolved from this directory or from a Git/environment redirect in the command.",
    "Run delivery inside its repository or use a literal cd or git -C so the committed range can be assessed.",
  );
const refusal = (code: GateCode, root: string, opts: StateOptions, ...lines: string[]): GateResult => ({
  allowed: false,
  code,
  reason: [`RDD pre-delivery: ${lines[0]!}`, ...lines.slice(1), NOT_RUN, offText(root, opts)].join("\n"),
});

interface PushSpec {
  remote?: string;
  refspecs: string[];
  all: boolean;
  tags: boolean;
}

function parsePush(args: readonly string[]): PushSpec {
  const positional: string[] = [];
  let all = false;
  let tags = false;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!literal && a === "--") literal = true;
    else if (!literal && a.startsWith("-") && a !== "-") {
      if (a === "--all" || a === "--mirror") all = true;
      if (a === "--tags") tags = true;
      if (PUSH_VALUE_OPTIONS.has(a)) i++;
    } else positional.push(a);
  }
  return { ...(positional[0] !== undefined ? { remote: positional[0] } : {}), refspecs: positional.slice(1), all, tags };
}

function optionValue(args: readonly string[], long: string, short: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === long || a === short) return args[i + 1];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
  }
  return undefined;
}

type Base = { kind: "range"; base: string } | { kind: "empty" } | { kind: "none" };

/** Evaluates one repository: returns a result (allow or refuse) for it. */
function evaluateRoot(root: string, items: readonly DeliveryAction[], hasChange: boolean, unresolved: boolean, opts: GateOptions, expired: () => boolean, bounded: { gitTimeoutMs: number; deadlineAt: number }): GateResult {
  if (expired()) return refusal("check_failed", root, opts, "the bounded delivery check ran out of its time budget (it fails closed once RDD is on).");
  if (hasChange) {
    return refusal(
      "mixed_chain",
      root,
      opts,
      "this command changes the candidate (a candidate-changing git command) and delivers it in the same line, so the committed range being delivered cannot be assessed.",
      "Finish the candidate-changing commands separately, then issue the delivery on its own so the resulting commits can be assessed.",
    );
  }
  if (unresolved) return unresolvedRefusal(root, opts);
  const run = opts.git ?? runGit;
  const gitMs = bounded.gitTimeoutMs;
  const deadlineAt = bounded.deadlineAt;
  const text = (out: ReturnType<typeof runGit>): string | undefined => {
    if (out.exitCode !== 0) return undefined;
    const t = out.stdout.toString("utf8").trim();
    return t === "" ? undefined : t;
  };
  // STRICT: exit 0 is an answer, exit 1 is a plain "no" (unborn HEAD, detached, unset, no common ancestor); any other
  // failure, a timeout or a missing git throws, so the caller fails closed instead of reading it as "nothing to deliver".
  const strict = (...args: string[]): string | undefined => text(run({ cwd: root, args, timeoutMs: gitMs, deadlineAt, okExit: [0, 1] }));
  // LENIENT, only for probing refs that may legitimately not exist (`@{push}` without an upstream dies with 128):
  // a nonzero exit is "absent"; a timeout, a missing git or an output overflow still throws.
  const lenient = (...args: string[]): string | undefined => {
    try {
      return text(run({ cwd: root, args, timeoutMs: gitMs, deadlineAt }));
    } catch (err) {
      if (err instanceof SnapshotError && err.code === "git_failed") return undefined;
      throw err;
    }
  };
  const probe = (rev: string): string[] => ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`];
  const commit = (rev: string): string | undefined => lenient(...probe(rev));
  const head = strict(...probe("HEAD"));
  if (head === undefined) return { allowed: true, reason: "empty_range" }; // unborn HEAD: nothing to deliver
  const git = strict;
  const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");

  const fromRefs = (refs: readonly string[]): Base => {
    for (const ref of refs) {
      const sha = commit(ref);
      if (sha === undefined) continue;
      const mb = git("merge-base", head, sha);
      if (mb === undefined) continue;
      if (mb === head) return { kind: "empty" };
      const counted = text(run({ cwd: root, args: ["rev-list", "--count", `${mb}..${head}`], timeoutMs: gitMs, deadlineAt }));
      if (counted === undefined || !/^\d+$/.test(counted)) throw new Error("git rev-list --count gave no usable answer");
      const count = Number(counted);
      return count > 0 ? { kind: "range", base: mb } : { kind: "empty" };
    }
    return { kind: "none" };
  };

  const bases: Base[] = [];
  for (const item of items) {
    if (item.tool === "gh-pr") {
      const wanted = optionValue(item.args, "--base", "-B");
      bases.push(fromRefs([...(wanted ? [`refs/remotes/origin/${wanted}`] : []), "refs/remotes/origin/HEAD", "@{upstream}"]));
      continue;
    }
    const spec = parsePush(item.args);
    if (spec.all) {
      return refusal("unassessable_ref", root, opts, "this push (--all or --mirror) sends refs other than HEAD, which cannot be assessed as the committed range HEAD is on.", "Push the checked-out branch by name instead.");
    }
    if (spec.tags && git("for-each-ref", "--count=1", "--no-merged", head, "--format=%(refname)", "refs/tags") !== undefined) {
      return refusal("unassessable_ref", root, opts, "this push (--tags) sends a tag outside the history of HEAD, which cannot be assessed as the committed range HEAD is on.", "Push the tags that point into HEAD's history by name, or check out what the tag points at.");
    }
    const remote = spec.remote ?? (branch ? git("config", "--get", `branch.${branch}.remote`) : undefined);
    const remoteUsable = remote !== undefined && remote !== "." ? remote : undefined;
    const specs = spec.refspecs.length > 0 ? spec.refspecs : [""];
    for (const raw of specs) {
      const s = raw.replace(/^\+/, "");
      const colon = s.indexOf(":");
      const src = colon < 0 ? s : s.slice(0, colon);
      const dst = colon < 0 ? "" : s.slice(colon + 1);
      const tagRef = src.startsWith("refs/tags/") ? src : `refs/tags/${src}`;
      const isTag = src.startsWith("refs/tags/") || (src !== "" && src !== "HEAD" && git("rev-parse", "--verify", "--quiet", tagRef) !== undefined) || s === "tag";
      if (isTag && s !== "tag") {
        // a tag is assessed as the HEAD range only if it is HEAD or in HEAD's history (then nothing outside it ships)
        const tagged = git("rev-parse", "--verify", "--quiet", "--end-of-options", `${tagRef}^{commit}`);
        const inHistory = tagged !== undefined && (tagged === head || run({ cwd: root, args: ["merge-base", "--is-ancestor", tagged, head], timeoutMs: gitMs, deadlineAt, okExit: [0, 1] }).exitCode === 0);
        if (!inHistory) {
          return refusal("unassessable_ref", root, opts, `this push sends the tag ${src}, which is neither HEAD nor in the history of HEAD (or is not a commit), so it cannot be assessed as the committed range HEAD is on.`, "Check out the commit the tag points at, then deliver it.");
        }
      }
      if (src !== "" && src !== "HEAD" && !isTag) {
        const sha = commit(src);
        if (sha !== undefined && sha !== head) {
          return refusal("unassessable_ref", root, opts, `this push sends ${src}, a ref other than HEAD, so it cannot be assessed against the committed range HEAD is on.`, "Check out the branch being pushed, then deliver it.");
        }
      }
      const strip = (r: string): string => r.replace(/^refs\/heads\//, "");
      const name = dst !== "" && !dst.startsWith("refs/") ? dst : dst.startsWith("refs/heads/") ? strip(dst) : src !== "" && src !== "HEAD" && !isTag ? strip(src) : branch;
      const refs: string[] = [];
      if (remoteUsable !== undefined && name) refs.push(`refs/remotes/${remoteUsable}/${name}`);
      if (spec.refspecs.length === 0) refs.push("@{push}", "@{upstream}");
      else if (dst === "" && branch === undefined) refs.push("@{upstream}");
      if (remoteUsable !== undefined) refs.push(`refs/remotes/${remoteUsable}/HEAD`);
      refs.push("refs/remotes/origin/HEAD");
      bases.push(fromRefs(refs));
    }
  }

  const distinct = new Map<string, string>();
  let ranges = 0;
  for (const b of bases) {
    if (b.kind === "none") {
      return refusal(
        "no_base",
        root,
        opts,
        "no base was found to derive the committed range being delivered (no remote-tracking branch for the push target, no upstream and no origin/HEAD).",
        "Fetch the remote or set the branch upstream / origin/HEAD (git remote set-head origin -a) so the committed range can be assessed.",
      );
    }
    if (b.kind === "range") {
      distinct.set(b.base, b.base);
      ranges++;
    }
  }
  if (ranges === 0) return { allowed: true, reason: "empty_range" };

  const assess = opts.assess ?? assessCandidate;
  const repo = resolveRepository(root, bounded);
  let last: GateAllow = "empty_range";
  for (const baseSha of distinct.values()) {
    if (expired()) return refusal("check_failed", root, opts, "the bounded delivery check ran out of its time budget (it fails closed once RDD is on).");
    const a = assess(root, { kind: "base-diff", baseRef: baseSha }, bounded);
    if (a.status === "not_due") {
      last = "empty_range";
      continue;
    }
    if (!a.reviewDue) {
      last = "not_due";
      continue;
    }
    if (readDecline(repo.commonDir, a.targetIdentity) !== undefined) {
      last = "declined";
      continue;
    }
    const scan = isTargetConsumed(repo.commonDir, a.targetIdentity);
    if (scan.consumed) {
      last = "consumed";
      continue;
    }
    const why =
      scan.status === "unknown"
        ? `A prior review of it could not be verified (${scan.problems.map((p) => p.code).join(", ") || "authority unreadable"}), which counts as not reviewed.`
        : scan.truncated
          ? "The review store scan was truncated, so a prior review could not be confirmed."
          : "";
    return refusal(
      "review_due",
      root,
      opts,
      `the committed range ${baseSha.slice(0, 12)}..HEAD (base ${baseSha}) is high risk (${a.reasons.map((r) => r.code).join(", ") || "see the review"}) and has not been reviewed: no approved review of candidate ${a.targetIdentity} exists.${why ? ` ${why}` : ""}`,
      `Route to the review before delivering: with the plugin's review tools, call review_status for this repository with target base-diff, base_ref ${baseSha}, committed_only true, and follow only the next_transition it returns. The review_start it offers always relays consent: call it unchanged. If it returns a consent question, relay it to the human losslessly: this hook never starts a review and never answers consent (only the human's explicit answer goes to review_answer_consent).`,
      "After the review closes for this exact candidate (or the human declines it), issue the delivery again.",
    );
  }
  return { allowed: true, reason: last };
}

/**
 * Gate for one Bash command. Never throws, never writes. With RDD off (or unknown) for the repository the command
 * reaches, always allowed; with it on, see the policy in the module header.
 */
export function checkDelivery(input: { cwd: string; command: string }, opts: GateOptions = {}): GateResult {
  let actions: DeliveryAction[];
  try {
    actions = recognizeDeliveryActions(input.command);
  } catch {
    return { allowed: true, reason: "no_delivery" };
  }
  const deliveries = actions.filter((a) => a.kind === "delivery");
  if (deliveries.length === 0) return { allowed: true, reason: "no_delivery" };
  const hasChange = actions.some((a) => a.kind === "change");
  // The budget is a HARD deadline for the whole check, enforced by the gate's own clock: every git call anywhere below
  // (repository resolution, the mode reads, the base probes, the candidate assessment) gets min(its own bound, time
  // left) through `deadlineAt` and none starts once it is spent, so the sum of many slow calls can never outlive it.
  const started = Date.now();
  const budget = opts.deadlineMs ?? DEFAULT_BUDGET_MS;
  const deadlineAt = started + budget;
  const expired = (): boolean => Date.now() >= deadlineAt;
  const gitMs = opts.gitTimeoutMs ?? DEFAULT_GIT_MS;
  const bounded = { gitTimeoutMs: gitMs, deadlineAt };

  const groups = new Map<string, { items: DeliveryAction[]; unresolved: boolean }>();
  for (const d of deliveries) {
    const dir = d.unresolved ? input.cwd : d.directories.reduce((b, x) => resolve(b, x), input.cwd);
    const modeOn = (where: string): boolean => {
      try {
        return readReviewMode(where, { ...opts, ...bounded }).effective === "on";
      } catch {
        return false; // a mode that cannot be read is off (mode.ts)
      }
    };
    let root: string;
    try {
      root = resolveRepository(dir, bounded).root;
    } catch (err) {
      const code = err instanceof SnapshotError ? err.code : undefined;
      if (code === "not_a_repository" || code === "bare_repository") {
        // Not a repository: the delivery itself would fail. Unless its target is unknowable (cd/GIT_DIR/--git-dir),
        // where the mode decides (the clone override is read directly if a .git exists, else the user-wide switch).
        if (d.unresolved && modeOn(dir)) return unresolvedRefusal(dir, opts);
        continue;
      }
      if (code === "untrusted_repository") {
        // git refuses to work here (dubious ownership), but the command may override safe.directory (`-c`, GIT_CONFIG_*),
        // so the committed range cannot be ruled out: the clone override is read directly (an off wins), otherwise the
        // GLOBAL switch decides (on: deny).
        if (!modeOn(dir)) continue;
        if (d.unresolved) return unresolvedRefusal(dir, opts);
        return refusal("check_failed", dir, opts, "git does not trust the delivery repository (dubious ownership), so the committed range cannot be assessed; the check fails closed while RDD is on.", "Mark it safe (git config --global --add safe.directory <path>) and deliver again, or turn RDD off for it.");
      }
      // git misbehaved (not "not a repository"): the repository is unknown, so the mode at that directory decides.
      if (modeOn(dir)) return refusal("check_failed", dir, opts, `the delivery repository could not be resolved (${err instanceof Error ? err.message : String(err)}); the check fails closed while RDD is on.`);
      continue;
    }
    const g = groups.get(root) ?? { items: [], unresolved: false };
    g.items.push(d);
    g.unresolved ||= d.unresolved;
    groups.set(root, g);
  }
  if (groups.size === 0) return { allowed: true, reason: "not_a_repository" };

  let verdict: GateResult = { allowed: true, reason: "rdd_off" };
  for (const [root, g] of groups) {
    let on = false;
    try {
      on = readReviewMode(root, { ...opts, ...bounded }).effective === "on";
    } catch {
      on = false; // a mode that cannot be read is off (mode.ts)
    }
    if (!on) continue;
    let result: GateResult;
    try {
      result = evaluateRoot(root, g.items, hasChange, g.unresolved, opts, expired, bounded);
    } catch (err) {
      result = refusal("check_failed", root, opts, `the delivery check is unavailable (${err instanceof Error ? err.message : String(err)}); it fails closed while RDD is on.`);
    }
    if (!result.allowed) return result;
    verdict = result;
  }
  return verdict;
}
