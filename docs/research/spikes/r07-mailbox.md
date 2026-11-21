# Spike R07: buzón en archivos + hooks

Spec: `odd/tasks/r07-peers.md`, P0 (S3, S4). Herramienta: `spikes/r07-mailbox/` (guía en su README).

## Verificado offline (sin sesiones reales de Claude Code)

- `node --test spikes/r07-mailbox/test/`: 6 pruebas OK. Cubren: forma de `hooks.json`/`plugin.json`; SessionStart registra el stdin completo; `send.mjs --list`; UserPromptSubmit devuelve `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<untrusted-peer-messages ...>"}}` (misma forma que `plugins/odd-claude/src/hooks/user-prompt-submit.ts` y `session-start.ts`), en orden, y mueve a `delivered/` sin duplicados; id ausente o inseguro (`../x`) no lee buzones; 8 envíos concurrentes obtienen `seq` distintos (reserva atómica con `link()`).
- `claude plugin validate spikes/r07-mailbox/plugin`: Validation passed.
- NO verificado: que el modelo reciba realmente el `additionalContext`; todo lo de abajo.

## Preguntas abiertas (rellenar tras correr el spike)

| Pregunta | Resultado |
| --- | --- |
| (a) ¿El modelo de B vio el texto de los mensajes? | _pendiente_ |
| ¿Lo trató como datos no confiables o como instrucciones? | _pendiente_ |
| (b) ¿`session_id` presente en la entrada de SessionStart / UserPromptSubmit? | _pendiente_ |
| ¿Estable tras `/clear`? | _pendiente_ |
| ¿Estable tras `--resume` / `--continue`? | _pendiente_ |
| Otros campos de la entrada (cwd, transcript_path, ...) | _pendiente_ |
| Latencia send → prompt en B | _pendiente_ |
| ¿Entrega con B inactiva? (esperado: no) | _pendiente_ |
| Orden con dos envíos seguidos | _pendiente_ |
| Duplicados | _pendiente_ |
| (c) Concurrencia: dos envíos simultáneos (seq distintos, nada perdido) | _pendiente_ |
| Entrega en SessionStart | _pendiente_ |
| Sorpresas | _pendiente_ |

## Conclusión / decisión para P1..P4

_pendiente_
