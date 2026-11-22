# Simplify: remove banner, themes, mods, statusline and the agents/changes/quiet commands
Objective: start a simplification pass by removing the startup banner, the themes, the visual mods (the `hooks/register.ts` module), the statusline and the text fallbacks of those mods; the `odd` output style stays. Branch: `feat/simplify` (from `main` 35d523c, release 2.3.0). Delivery: `ask-on-risk`. Runner: `node:test` (`npx tsc -p tsconfig.test.json` then `node --test dist-test/...`) inside `plugins/odd-claude` + `npm run check`; node tests run inside docker.

## Specs

- **S1** User request (verbatim): "Ok podemos eliminar completamente - El banner de inicio - Los temas - los Mods visuales la idea es empezar con un proceso de simplificacion, dejalo para un feature despues de eesto de los perfiles"
- **S2** Decisions taken through the question tool, recorded as the user's choices: `agent.spawn` -> "Eliminar también agent.spawn"; the text fallbacks `/odd-claude:agents`, `/odd-claude:changes`, `/odd-claude:quiet` -> "Quitarlos tambien".
- **S3** User request (verbatim): "Y si eliminemos tambien el statusline y los output style" with the user's decision "Quitar statusline, conservar el output style (recomendado)": the `odd` output style stays.
- **S4** Docs, help and tests reflect the removals; nothing else is removed; profiles keep working through the SessionStart context line (no `agent.spawn`).

## Tasks

- T1 | S1,S2,S4 | writer | pending — remove the mod (`hooks/register.ts`, its tests, the `modules` entry of `hooks/hooks.json`) and the agents / changes / quiet commands (CLI, lib, skills, dist), their docs and specs; add guards.
- T2 | S1,S3,S4 | writer | pending — remove the banner, the themes and the statusline (`/odd-claude:setup statusline`, `statusline.ts`), their docs and tests; the `odd` output style stays.

Risk: item 3 (removes commands and a mod that other users may rely on).

## Log

- L1: user request: "Ok podemos eliminar completamente - El banner de inicio - Los temas - los Mods visuales la idea es empezar con un proceso de simplificacion, dejalo para un feature despues de eesto de los perfiles"
- L2: user decisions (question tool): agent.spawn -> "Eliminar también agent.spawn"; text fallbacks /odd-claude:agents, /odd-claude:changes, /odd-claude:quiet -> "Quitarlos tambien".
- L3: user request: "Y si eliminemos tambien el statusline y los output style"; decision: "Quitar statusline, conservar el output style (recomendado)".
- L4: T1 evidence (S1, S2, S4). RED observed: `simplify.spec` 5 of 6 failing before the removals (hooks.json `modules`, `hooks/register.ts`, skills agents/changes/quiet, CLI/lib/dist files, README, `profiles.ts` comments). Then the 21 paths were `git rm`-ed by the parent and the rest edited: README (mods UX section, commands, interactive checks), `profiles.ts` / `cli/profiles.ts` / `skills/profiles/SKILL.md` (profiles apply through the SessionStart context line), `status.ts` `ROADMAP_PHASE` = "v2.3: simplification in progress (mods removed)", `docs/roadmap.md` and `docs/README.md` (removal noted, history rows kept), `no-deny.spec`, `subagents.ts/.spec`. Decision: `src/lib/subagents.ts`, `src/hooks/subagents.ts` and the SubagentStart/SubagentStop recording are kept (stats reads them); only `renderSubagents` and `AGENTS_SCHEMA` were removed with the agents command. GREEN: docker full suite 1189 tests, 1185 pass, 0 fail (4 skipped/todo), `simplify.spec` 6/6; host tsc (both configs) exit 0, `npm run check` ok, `claude plugin validate` passed (icon warning only), `claude plugin test` reports "no hooks module to load" (expected, exit 1, no mod tests left). No dist file of a removed source remains. Banner hint text still names the removed commands (left for T2). Risk: item 3.
