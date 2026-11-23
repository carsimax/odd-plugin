// The "unreviewed candidate" decision shared by the Stop settle reminder and the delivery notice: the same candidate
// the review entry rule would START, and only when the risk assessment says a review is due. Read-only; it may throw
// (SnapshotError), callers decide what a failure means (both stay silent).
import { readEscalation } from "./escalation.js";
import { assessCandidate } from "./risk.js";
import { resolveRepository, runGit } from "./snapshot.js";
import type { StartTarget } from "./start.js";
import { reviewStatus, type StatusEnvelope } from "./status.js";

/** Per git command bound inside the hooks (hooks.json gives each hook 30 s). */
export const GIT_MS = 5000;

export interface Candidate {
  target: StartTarget;
  status: StatusEnvelope;
}

const offersStart = (s: StatusEnvelope): boolean => s.next_transition.kind === "execute" && s.next_transition.execute?.operation === "review.start";

/** The committed range a clean worktree would review: the branch upstream, else the remote default branch; one merge base, non-empty. */
export function committedRangeBase(cwd: string): string | undefined {
  const git = (...args: string[]): string | undefined => {
    try {
      return runGit({ cwd, args, timeoutMs: GIT_MS }).stdout.toString("utf8").trim();
    } catch {
      return undefined;
    }
  };
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  if (!head) return undefined;
  const fromRef = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    const bases = (git("merge-base", "--all", head, ref) ?? "").split(/\s+/).filter((x) => x !== "");
    if (bases.length !== 1 || bases[0] === head) return undefined;
    return Number(git("rev-list", "--count", `${bases[0]}..${head}`)) > 0 ? bases[0] : undefined;
  };
  return fromRef(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")) ?? fromRef(git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"));
}

function findCandidate(root: string): Candidate | undefined {
  const opts = { gitTimeoutMs: GIT_MS };
  const workspace = reviewStatus(root, opts);
  if (offersStart(workspace)) return { target: { kind: "current-changes" }, status: workspace };
  // Only an EMPTY workspace falls back to the committed range; a candidate that is declined, consumed or under review stays silent.
  if (workspace.next_transition.reason_code !== "not_due") return undefined;
  const baseRef = committedRangeBase(root);
  if (baseRef === undefined) return undefined;
  const target: StartTarget = { kind: "base-diff", baseRef, committedOnly: true };
  const committed = reviewStatus(root, { ...opts, target });
  return offersStart(committed) ? { target, status: committed } : undefined;
}

/** The unreviewed candidate of a repository whose review is due (high risk, or an agent escalation bound to this exact candidate), or undefined. */
export function findDueCandidate(root: string): Candidate | undefined {
  const found = findCandidate(root);
  if (found === undefined) return undefined;
  const assessed = assessCandidate(root, found.target, { gitTimeoutMs: GIT_MS });
  if (assessed.status !== "assessed" || assessed.targetIdentity !== found.status.target_identity) return undefined;
  if (assessed.reviewDue) return found;
  // An escalation is bound to the candidate identity: a changed candidate has another identity, so it no longer applies.
  return readEscalation(resolveRepository(root, { gitTimeoutMs: GIT_MS }).commonDir, assessed.targetIdentity) === undefined ? undefined : found;
}
