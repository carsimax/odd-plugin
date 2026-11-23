// The "unreviewed candidate" decision shared by the Stop settle reminder and the delivery notice: the same candidate
// the review entry rule would START, and only when the risk assessment says a review is due. Read-only; it may throw
// (SnapshotError), callers decide what a failure means (both stay silent).
import { assessCandidate } from "./risk.js";
import { runGit } from "./snapshot.js";
import { reviewStatus } from "./status.js";
/** Per git command bound inside the hooks (hooks.json gives each hook 30 s). */
export const GIT_MS = 5000;
const offersStart = (s) => s.next_transition.kind === "execute" && s.next_transition.execute?.operation === "review.start";
/** The committed range a clean worktree would review: the branch upstream, else the remote default branch; one merge base, non-empty. */
export function committedRangeBase(cwd) {
    const git = (...args) => {
        try {
            return runGit({ cwd, args, timeoutMs: GIT_MS }).stdout.toString("utf8").trim();
        }
        catch {
            return undefined;
        }
    };
    const head = git("rev-parse", "--verify", "HEAD^{commit}");
    if (!head)
        return undefined;
    const fromRef = (ref) => {
        if (!ref)
            return undefined;
        const bases = (git("merge-base", "--all", head, ref) ?? "").split(/\s+/).filter((x) => x !== "");
        if (bases.length !== 1 || bases[0] === head)
            return undefined;
        return Number(git("rev-list", "--count", `${bases[0]}..${head}`)) > 0 ? bases[0] : undefined;
    };
    return fromRef(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")) ?? fromRef(git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"));
}
function findCandidate(root) {
    const opts = { gitTimeoutMs: GIT_MS };
    const workspace = reviewStatus(root, opts);
    if (offersStart(workspace))
        return { target: { kind: "current-changes" }, status: workspace };
    // Only an EMPTY workspace falls back to the committed range; a candidate that is declined, consumed or under review stays silent.
    if (workspace.next_transition.reason_code !== "not_due")
        return undefined;
    const baseRef = committedRangeBase(root);
    if (baseRef === undefined)
        return undefined;
    const target = { kind: "base-diff", baseRef, committedOnly: true };
    const committed = reviewStatus(root, { ...opts, target });
    return offersStart(committed) ? { target, status: committed } : undefined;
}
/** The unreviewed candidate of a repository whose review is due (high risk), or undefined. */
export function findDueCandidate(root) {
    const found = findCandidate(root);
    if (found === undefined)
        return undefined;
    const assessed = assessCandidate(root, found.target, { gitTimeoutMs: GIT_MS });
    if (assessed.status !== "assessed" || assessed.targetIdentity !== found.status.target_identity)
        return undefined;
    return assessed.reviewDue ? found : undefined;
}
