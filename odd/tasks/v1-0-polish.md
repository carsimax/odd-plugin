# v1.0 polish: cosmetic and small items (Phase 7)
Goal: close v1.0 with the low-value, low-effort extras: advisory hooks, scratch, themes and the final docs. Branch: `feat/v1.0-polish`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `claude plugin validate`.

## Specs

### S1 Roadmap Phase 7 (docs/roadmap.md, "### Phase 7: Cosmetic and small items")

- **Goal:** low-value, low-effort extras.
- **Matrix IDs:** R35, R54, R56, R57, R62, R63, R64, R70, A50
- **Deliverables:** `--fallback-model` guidance + hook `odd-stop-failure` (R35, same-provider only); themes `odd-*` (R54, A50); `/odd-claude:scratch` + hooks (R56); notification/audio hooks reusing A26 WAVs (R57; `$.audio` mod variant optional); terminal-title hook (R62); star prompt (R63, only if the project decides to keep an outward-facing nudge); resume hint (R64); agent status file hooks (R70).
- **Dependencies / gates:** Phase 1; A26 from Phase 2; Q1 only for the optional audio mod.
- **Exit criteria:** each hook runs without output errors on macOS (and is a no-op where `afplay`/`paplay` is missing); themes load in `claude plugin validate`; scratch dir is created at SessionStart and removed at SessionEnd.
- **Risk:** low. R35 cross-provider fallback is not possible (Anthropic models only). R63 is outward-facing; needs an explicit keep/drop decision.

### S2 Project decisions (user, verbatim)

- "El proyecto se llamara odd-claude no gentle-ai o gentle-shell"
- "ignora completamente otros proyectos como gentle-py tomaremos todo 100% del upstream de este repo"
- "no usaremos nada de prefijo gentle- o gentle-ai todo sera odd-claude nuestro plugin entonces el prefijo sera odd"
- "y sin nada de telemetria"
- Message: "Por cierto se me olvido mencionar no quiero el tema del deny, se que es riesgoso pero así lo requiero que dejemos permisible el bloque de denegaciones que tiene originalmente gentle-shell"
- Question: "¿Qué hacemos con los comandos que hoy se deniegan (rm -rf /, git reset --hard, etc.)?" Answer: "Quitar el guard: todo permitido"
- Question: "¿Aplica también a los subagentes (child guard), que hoy niegan todo lo destructivo sin override?" Answer: "Sí, mismo criterio que el hilo principal"
- Question: "¿Y el guard de rutas sensibles (T2: secretos, .env, .ssh, keychains)?" Answer: "Igual: sin deny"
- Question: "Quedan otros dos mecanismos de la Fase 3 que también responden 'deny', aunque no por seguridad del sistema sino por disciplina ODD. ¿Los mantenemos?" Answer: "Ninguno: ni T3 ni T4". Option text: "Cero deny en el plugin. Admisión y coordinator quedan solo como reglas de texto en el prompt."
- Effect: the plugin contains no hook that returns deny/ask/block (v0.5 S6, kept as a project decision; `src/lib/no-deny.test.ts`). No new hook (StopFailure, Stop, SessionEnd included) may return a block decision or `continue:false`, and a Stop hook never forces continuation.

### S3 Phase 7 decisions (user, verbatim)

- Question: "Star prompt (R63): el upstream pide una estrella en GitHub después de cierto uso. odd-claude todavía no tiene repo público. ¿Qué hacemos?" Answer: "Descartarlo (Recomendado)". Effect: R63 dropped.
- Question: "Notificaciones con sonido (R57): al terminar un turno, cuando hay un error o cuando algo requiere tu atención. ¿Encendidas por defecto?" Answer (user's own): "No implementarlo". Effect: R57 dropped.

## Tasks

- T1 | S1,S2 | writer | done (commit 6200171) — Hooks R35 (`StopFailure` advisory quota recovery + `--fallback-model` guidance in `cards/quota-recovery.md`), R56 (per-session scratch + `/odd-claude:scratch`), R62 (terminal title via `terminalSequence`), R64 (resume hint on SessionEnd), R70 (agent status file), through `src/hooks/run.ts` + `hooks/hooks.json`; no-deny test extended to the new events.
- T2 | S1 | parallel writer | done (commit 76f2b19) — Themes R54/A50 (`plugins/odd-claude/themes/**`, `.claude-plugin/plugin.json`).
- T3 | S1,S3 | parent/writer | done-pending-commit — Close: plugin README, roadmap (Phase 7 done; R57 and R63 dropped by user decision, IDs kept and marked dropped; v1.0 milestone reached), validate.

## Log

- L1: user's original request: "ok" (reply to "¿Sigo con la Fase 7 para cerrar v1.0?").
- L2: T1 covers S1 (R35, R56, R62, R64, R70) and S2 (no-deny extended: StopFailure/Stop/SessionEnd/SessionStart/UserPromptSubmit outputs carry no decision, block, reason or continue). S3 means R57 and R63 are not implemented. Test-first: new tests written first, RED = `npm run build:test` failing with TS2307 on the missing modules (`quota`, `scratch`, `agent-status`, `terminal`, `cli/scratch`); GREEN after implementation: `npm test` 239 pass, 0 fail.
- L3: Verified in the binary (claude 2.1.327): `StopFailure` is fire-and-forget (output and exit code ignored; input `error`, `error_details`, `last_assistant_message`), so the hook only logs and arms one advisory for the next UserPromptSubmit (state `quotaFailure`, shown once while the 30 min exhausted / 2 min transient cooldown runs). `terminalSequence` is a top-level hook output field limited to OSC 0/1/2/9/99/777 and BEL; the title is a plain OSC 0. `Stop` output with `additionalContext` makes the conversation continue, so the Stop hook output is always empty.
- L4: R56 port is the minimal safe subset: `<data>/scratch/<session>` (0700) created at SessionStart (path injected in context, `/odd-claude:scratch` shows it), removed at SessionEnd only if root and dir are real directories and the realpath is exactly `<realroot>/<session>`; symlinks are refused and never followed. The upstream artifact ledger (recorded clones/worktrees, crashed-session sweep) is not ported.
- L5: R70 file `<data>/status/<session>.json` (`schema odd-claude.agent-status/v1`, session, cwd, state idle/working/ended, updatedAt; 0600, atomic). SessionEnd writes `ended` instead of deleting (upstream deletes). Stale after 30 s.
- L6: E2E (`claude -p --model haiku --plugin-dir plugins/odd-claude "say hi" --output-format stream-json --verbose --include-hook-events`, temp cwd, exit 0): the scratch dir appeared during the run (poll) and was gone after exit; status file ended `state: ended`; SessionStart output carried `terminalSequence` `ESC]0;odd-claude · <project> BEL` with no allowlist rejection; Stop outputs empty; no decision/block outputs. SessionEnd hook output is not shown in the `-p` stream, so the resume hint (R64) is invisible there: it is also logged to `hooks.log`; interactive visibility is not verified. StopFailure was not triggered live (needs a real API error); covered by tests.
- L8: T3 (docs only) covers S1 (Phase 7 done, v1.0 milestone reached, README sections for themes, lifecycle hooks and "What's in v1.0", plugin.json 1.0.0) and S3 (R57 and R63 marked "dropped by user decision 2026-11-18" in roadmap and README, IDs kept). S2 kept: README retains the no-deny statement. T1 commit 6200171, T2 commit 76f2b19.

- L8: T3 (docs only) covers S1 (Phase 7 done, v1.0 milestone reached, README sections for themes, lifecycle hooks and "What's in v1.0", plugin.json 1.0.0) and S3 (R57 and R63 marked "dropped by user decision 2026-11-18" in roadmap and README, IDs kept). S2 kept: README retains the no-deny statement. T1 commit 6200171, T2 commit 76f2b19.
- L7: Temp dir cleanup blocked: `rm -r` was refused by the child safety policy; the `mktemp -d` dir named in /tmp/odd-e2e-path (`/tmp/odd-e2e-*`) and `/tmp/odd-claude-strings.txt` are left for the parent to remove. The E2E session left `status/<session>.json` under `~/.claude/plugins/data/odd-claude-inline`.
- L9: T3 alignment to v1.0.0 covers S1: marketplace.json entry, package.json and package-lock.json (root and packages[""]) set to 1.0.0; `ROADMAP_PHASE` now "v1.0: parity reached; next v1.1 mods UX". Test-first: `status.test.ts` expectation changed first, RED = `npm test` failing on the roadmap assertion (old "Phase 1"), GREEN after the change. Log order fixed (L7 before L8).
- L10: Independent verification of 6200171: S1/S2 met, advisories only. Follow-up hardening covers S1 (R56 scratch) and keeps S2 (no new deny). A1: `resolveDataDir` now throws "data dir must be an absolute path" for a relative `dataDir`/`CLAUDE_PLUGIN_DATA` (callers already treated a throw as fail-open/logged); the repro (`CLAUDE_PLUGIN_DATA=.` + SessionEnd) no longer deletes `scratch/sess-2`. A2: `removeSessionScratch` renames the session dir to a unique tombstone `.rm-<pid>-<ts>-<id>` inside the verified real root, re-verifies (not symlink, directory, realpath under the real root) and only then `rmSync`; any mismatch aborts, logs and returns `refused`. Residual risk (documented, not fixed): a same-user attacker can still swap the root itself between the realpath and the rename; Node has no fd-based `unlinkat`. A3: `safeSegment` collisions are theoretical with UUID session ids (unchanged); bidi override/isolate chars (U+202A-U+202E, U+2066-U+2069) are now stripped from the terminal title. Test-first: RED = new tests failing (relative dir accepted, bidi kept); GREEN `npm test` 245 pass, 0 fail; verifier regressions (hostile ids, symlinked root/dir, inner symlinks, relative dir) added to `scratch.test.ts`, plus `terminal.test.ts`. `npm run check` ok; `claude plugin validate plugins/odd-claude` passed with warnings; dist rebuilt. Temp dir cleanup blocked: `rm -r` refused by child safety policy.
