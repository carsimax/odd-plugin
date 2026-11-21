# Peer orchestrators (R07): inter-session messaging by file mailbox + hooks
Goal: let one Claude Code session on this machine send a short message to another live session, with human-granted consent per session, delivered by hooks, with no dependency on mods. Branch: `chore/review-maintenance` (docs only so far).
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check`. Docs only in this document; the P0 spike comes first and implementation (P1..P4) waits for its findings.

## Specs

### S1 User request (verbatim)

- "podemos trabajar en todos los pendientes que mencionas"
- The pending item: "Orquestadores pares (R07): fue lo que acordamos hacer después del RDD. Es una feature nueva, con su propio documento."

### S2 Earlier user decisions on record (verbatim)

- v2 question "¿Los orquestadores pares (R07) entran en esta v2?" → "Después del RDD, con $.store"
- Roadmap Q5: "Inter-session messaging → v2"
- The "$.store" part is superseded by S3 (first decision below).

### S3 User decisions 2026-11-21 (question → chosen option, verbatim)

- "En v2 decidiste orquestadores pares \"con $.store\", pero $.store es API de mods (opcionales) y el principio 2 del plugin dice que ninguna conducta depende de mods. ¿Qué canal usamos?" → "Buzón en archivos + hooks (recomendado)". Option text: "Mensajes en CLAUDE_PLUGIN_DATA/peers/, entregados por hooks; funciona sin mods." This SUPERSEDES the "$.store" part of S2.
- "¿Quién autoriza que una sesión reciba mensajes de otra?" → "allow manual por sesión (recomendado)". Option text: "El humano corre /odd-claude:peers allow <id>; el modelo no puede concederlo; cerrado por defecto."
- "¿Qué herramientas incluye la primera versión?" → "Núcleo de 3 (recomendado)". Option text: "session_id, list y send_message."
- "¿Cómo llega un mensaje a la otra sesión, y hacemos antes un spike?" → "Pull en el siguiente prompt + spike primero (recomendado)". Option text: "Se entrega al siguiente prompt o SessionStart; antes un spike real de escribir en una sesión y leer en otra. TTL 24 h, tope 50."

### S4 Design notes (parent's notes from the read-only research; not user words)

- **Upstream reference (read-only, do not copy code):** `upstream/gentle-shell` `extensions/gentle-agents.ts`: `orchestrator_session_id` (~3069), `orchestrator_list` (~3185), `orchestrator_send_message` (~3266: message ≤ 8192 bytes, reason 8–512 bytes, result is "accepted, not a read receipt"). `lib/session-messaging-grants.ts`: per-session interactive consent, fails closed without UI, cleared on session change. `lib/agents-session-transport.ts`: sockets + presence registry, NOT ported (R08 is out of scope).
- **odd-claude base:** session state lives in `CLAUDE_PLUGIN_DATA` via `plugins/odd-claude/src/lib/state.ts` (`sessions/<id>.json`, `atomicWriteFile`, `listSessionIds`); hooks SessionStart, UserPromptSubmit, SessionEnd; MCP servers declared in `.mcp.json`. Reuse these helpers; do not re-implement atomic writes.
- **Tool names:** `odd_orchestrator_session_id`, `odd_orchestrator_list`, `odd_orchestrator_send_message`. `agents-guard.spec.ts` (~91) forbids `odd_review`, `gentle-review` and `review_scope`, not these.
- **Delivery:** UserPromptSubmit and SessionStart read the session's mailbox and return `additionalContext` wrapped in tags marked untrusted / non-authoritative, then delete the delivered messages. Never block: no deny/block hooks (the RDD exception does not cover this).
- **Storage:** `CLAUDE_PLUGIN_DATA/peers/<recipient>/`, atomic writes, TTL 24 h, cap 50 per mailbox, per-sender rate limit, path confinement of ids.
- **Consent:** `/odd-claude:peers allow|revoke|list`, a slash command run by the human; the model cannot grant; closed by default.
- **Constraints:** no telemetry; never put secrets in messages; Windows out of scope; prefix `odd`, no gentle identifiers in shipped plugin files (this document is not shipped).
- **Unknowns the spike must settle (P0):** (a) whether `additionalContext` from a UserPromptSubmit hook reliably reaches the model in another live session; (b) session_id availability and stability in hook input; (c) concurrency of two sessions writing one mailbox.

## Tasks

Route `writer` unless noted; commit pending for all.

- P0 | S3,S4 | spike (user-assisted) | done (spike run by parent with claude -p; /clear and live idle session untested) — Spike: two real Claude Code sessions on this machine; session A writes a mailbox file for B via a throwaway script; B's next prompt receives it through a UserPromptSubmit hook `additionalContext`; record findings (session_id in hook input, latency, ordering, concurrency) in `docs/research/spikes/r07-mailbox.md`. Needs the user to drive two interactive sessions.
- P1 | S3,S4 | writer | commit pending (ready) — Mailbox store (`lib/peers.ts`): send/receive/ack, TTL, cap, rate limit, atomic writes under a lock, path confinement; tests including concurrency.
- P2 | S3,S4 | writer | commit pending (ready) — Consent: `/odd-claude:peers allow|revoke|list` command + grant store; closed by default; the model cannot grant; tests.
- P3 | S3,S4 | writer | commit pending (ready) — MCP tools `odd_orchestrator_session_id`, `odd_orchestrator_list`, `odd_orchestrator_send_message` (send refuses without the recipient's grant).
- P4 | S3,S4 | writer | commit pending (blocked by P1,P2) — Delivery via UserPromptSubmit + SessionStart hooks (`additionalContext`, untrusted wrapper, delete after delivery, never block); tests.
- P5 | S1 | writer | commit pending (blocked by P3,P4) — Docs: README section, roadmap update; version bump decision left to the user.

## Log

- L1: user's request (S1): "podemos trabajar en todos los pendientes que mencionas" (pending item: "Orquestadores pares (R07): fue lo que acordamos hacer después del RDD. Es una feature nueva, con su propio documento.")
- L2: earlier decisions (S2): "¿Los orquestadores pares (R07) entran en esta v2?" → "Después del RDD, con $.store"; roadmap Q5 "Inter-session messaging → v2".
- L3: user decisions 2026-11-21 (S3): "Buzón en archivos + hooks (recomendado)" (supersedes "$.store"); "allow manual por sesión (recomendado)"; "Núcleo de 3 (recomendado)"; "Pull en el siguiente prompt + spike primero (recomendado)".
- L4: Parent: P0 spike first; implementation waits for its findings.
- L5: P0 tooling built (S3, S4; unknown (a)-(c) still open): `spikes/r07-mailbox/` (throwaway plugin `odd-r07-spike`, `send.mjs`, README in Spanish, `node --test` suite 6/6 passing, `claude plugin validate` passed) and findings template `docs/research/spikes/r07-mailbox.md`. Waiting for the user to run the two-session spike.
- L6: P0 spike run by the parent (S3, S4) on 2026-11-21 with real `claude -p` sessions (Claude Code 2.1.330; `--session-id`, `--resume`, `--continue`; temp dirs). User's permission, verbatim: "Te doy permiso que ejecutes tu todo lo que me pides no estoy en mi maquoina". Unknowns: (a) the model saw all messages in order as untrusted data and refused the injection; (b) `session_id` present and stable across resume/continue; (c) concurrent sends got distinct seq, none lost; delivery at the earliest of SessionStart/UserPromptSubmit, no duplicates. NOT tested: `/clear`, compact, live idle interactive session, Windows, two different users. Findings and implications for P1-P4 in `docs/research/spikes/r07-mailbox.md`.
- L7: P1 done (S3, S4): `plugins/odd-claude/src/lib/peers.ts` (`send`, `take`, `peek`, `count`, `sessionIds`, typed `PeersError` codes `invalid_session_id|invalid_message|invalid_reason|mailbox_full|rate_limited|unsafe_path|lock_timeout`), `peers.spec.ts` (16 tests) and `peers-child.testkit.ts`. Decisions: `take` deletes delivered and expired messages (no `delivered/` log); message 1-8192 B, reason 8-512 B (UTF-8, trimmed), TTL 24 h, 50 queued, 10 sends/min per sender->recipient (a rejected send does not consume budget); per-mailbox lock `peers/.locks/<id>.lock` via `lib/lock.ts`, seq from `.seq` hint recovered from the files; ids `^[A-Za-z0-9][A-Za-z0-9-]{7,63}$`; symlinked peers/mailbox/.locks refused (`unsafe_path`), message files read via lstat+O_NOFOLLOW, 128 KiB cap. Tests cover limits, TTL with injected clock, cap, rate limit, ordering, confinement, corrupt files, crash leftovers, and child-process concurrency (20 sends, 3 concurrent takes, sends racing a take). Verified: `npm test` 1052 tests, 1050 pass, 0 fail; `npm run check` ok. Note: tests were written after the implementation (no RED run observed).
- L8: P2 done (S3 "allow manual por sesión (recomendado)" / "el modelo no puede concederlo; cerrado por defecto", S4 consent note): grants are written ONLY by the UserPromptSubmit hook from the human's own prompt (`input.prompt` trimmed exactly `/odd-claude:peers allow <id>` | `revoke <id>` | `revoke --all`; the grant is for `input.session_id`, confirmation returned as `additionalContext`, invalid ids refused visibly with no write). `lib/peer-grants.ts` (`allow`, `revoke`, `revokeAll`, `listGrants`, `isAllowed(recipient, sender)` fail-closed for P3; `peers/.grants/<recipient>.json`, atomic 0600, lock, cap 100, symlinks refused, size-capped reads). Lifetime: until revoked or SessionEnd (any reason) clears it. `cli/peers.ts` is list/status only (anything else exits 2 without writing); skill `skills/peers` has `disable-model-invocation: true`. Tests: `peer-grants.spec.ts` (7), `hooks/peers-consent.spec.ts` (9), `cli/peers.spec.ts` (4); RED observed as a failed build (`Cannot find module` for the new modules) before implementation; exact-match mutation (dropping `^`/`$` from the command regex) made the near-miss test fail. Residual limit: a model writing files directly with Bash is outside this design (permission system).
- L9: P3 done (S3 "Núcleo de 3", S4 tool names/limits/"accepted, not a read receipt"): server `peers` (`src/mcp/peers-server.ts`, tools in `peers-tools.ts`, shared stdio plumbing factored into `server-core.ts`; `review-server.ts` now imports it, behavior unchanged) registered in `.mcp.json`. Tools: `odd_orchestrator_session_id` (id + source, or `session_id:null` with guidance), `odd_orchestrator_list` (other sessions, max 50: id, cwd, last_seen, `accepts_messages_from_you` via `isAllowed(recipient, me)`), `odd_orchestrator_send_message` (refuses typed `not_granted|session_unknown|self_recipient|invalid_input` before writing; then `lib/peers.send`; lib errors pass through typed: `rate_limited`, `mailbox_full`, `invalid_message`...). Arguments copied into a null-prototype object, `__proto__|constructor|prototype` rejected; contents never logged or echoed. Own session id: env `CLAUDE_SESSION_ID` if valid, else `<data>/peers/.current/<claude-pid>.json` written by SessionStart (`lib/peers-session.ts`, atomic 0600, symlinks refused, pruned by age 7 d / dead pid / cap 50), keyed by `process.ppid`. UNVERIFIED for the real claude: that the hook's ppid and the MCP server's ppid are the same pid (verified only with a fake-parent node test; the hook runs through `sh -c`, so the real ppid may be the shell) — the parent must check e2e. Tests: `peers-server.spec.ts` (18), `peers-session.spec.ts` (8); written after the implementation (no RED run observed). Known: `review-server.spec.ts` line 749 asserts the exact key list `["codegraph","review"]` and needs `["codegraph","peers","review"]` (outside this unit's surfaces).
