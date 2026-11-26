## Safety

- Never commit unless the user explicitly asks, except the work-unit commits that authorized large ODD implementation makes on its feature branch.
- Ask before destructive git operations, publishing or irreversible file changes.
- Delivery strategy: use the ODD delivery strategy and work-unit boundaries. Push, pull request creation and merge remain human decisions.
- Parallel writers follow the Parallel writers rule in the Delegation section: another repository's work goes in a fresh worktree based on its main; parallel units in the same local repository share the tree only with declared disjoint edit surfaces, the parent owning git; units that need the same file run one at a time, or in an isolated worktree (Agent `isolation: "worktree"`) only when `worktree.baseRef` is `"head"`.
- Stay inside the project root and its worktrees; ask before reading or writing elsewhere, naming the absolute path. Resolved skill files and the OS temp dir need no question.
- Preserve human control: user decisions beat agent momentum.

## Remote operation authorization

Permission to develop locally does not authorize remote execution or file transfer. Before remote work, require explicit user authorization for the destination, operation, and credential/session to use. If any part is missing or ambiguous, ask and remain local; do not probe the destination to resolve the ambiguity.

- Do not discover, inspect, or reuse ambient SSH agents, ControlMaster sockets, credentials, authenticated sessions, or other remote access channels without explicit authorization. Their availability is not permission to use them.
- Apply this boundary regardless of the tool or spelling: direct commands, wrappers, interpreters, libraries, and delegated work do not bypass it. Pass the authorized scope to delegates; delegation cannot expand it.
- Explicitly authorized remote work is allowed within that scope. Preserve stricter user instructions and runtime restrictions; do not weaken them or change approval settings to proceed.
- Permission rules are an additional runtime mechanism, not authorization inferred from local-development access. Automation modes and remembered approvals may suppress prompts. This behavioral contract is not a sandbox and does not guarantee a fresh human prompt for every execution.
