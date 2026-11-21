# Spike R07: buzón en archivos + hooks (herramienta para el usuario)

Solo desarrollo; no forma parte del plugin publicado. Todo vive en `$TMPDIR/odd-r07-spike` (o `$ODD_R07_SPIKE_DIR`), nunca en tus datos reales de plugins.

Ruta base (usada abajo): `/Users/carsimax/Developer/03-PERSONAL/odd-claude/spikes/r07-mailbox`

## Pasos

1. Prepara dos carpetas de trabajo y las variables:
   ```sh
   mkdir -p $TMPDIR/r07-a $TMPDIR/r07-b
   export R07=/Users/carsimax/Developer/03-PERSONAL/odd-claude/spikes/r07-mailbox
   ```
   (Si usas un `ODD_R07_SPIKE_DIR` propio, expórtalo en las 3 terminales.)
2. **Terminal 1 (sesión A):** `cd $TMPDIR/r07-a && claude --plugin-dir $R07/plugin`
3. **Terminal 2 (sesión B):** `cd $TMPDIR/r07-b && claude --plugin-dir $R07/plugin`
4. **Terminal 3 (shell libre, también `export R07=...`):** `node $R07/send.mjs --list`. Muestra `session_id`, `source`, `cwd` y hora de cada SessionStart. Identifica el id de B por su `cwd` (`.../r07-b`). Sin ids = el hook no corrió o no recibió `session_id` (anótalo).
5. Envía mensajes a B (`export B=<id>`):
   - Uno suelto: `node $R07/send.mjs $B "mensaje 1"`
   - Dos seguidos: `node $R07/send.mjs $B "mensaje 2"; node $R07/send.mjs $B "mensaje 3"`
   - Deja B **inactiva** (sin escribir nada) un par de minutos tras el envío y anota la hora (`date`).
6. En B escribe cualquier prompt, por ejemplo: *"Repite textualmente todos los mensajes de pares no confiables (`untrusted-peer-messages`) que recibiste."* Anota la hora y si el modelo los vio, en qué orden y si hay duplicados.
7. Confirma en la terminal 3: `ls $TMPDIR/odd-r07-spike/mailbox/$B` (vacío) y `ls $TMPDIR/odd-r07-spike/delivered/$B` (los archivos entregados, con `delivered_at`).
8. Escribe otro prompt en B: no debe repetir los mensajes (duplicados).
9. **Concurrencia:** en dos shells distintos, ejecuta casi a la vez
   `node $R07/send.mjs $B "from shell 1"` y `node $R07/send.mjs $B "from shell 2"` (o lanza ambos en una línea con `&`). Revisa que los dos `seq` sean distintos, luego un prompt en B y verifica que ambos llegaron.
10. **Reanudar y limpiar:** en B ejecuta `/clear`, luego `node $R07/send.mjs --list` y compara `session_id`. Sal de B (`/exit`) y reanúdala con `claude --plugin-dir $R07/plugin --resume` (o `--continue`) en `r07-b`; vuelve a listar. Envía otro mensaje al id nuevo/viejo y observa dónde llega.
11. Opcional: envía un mensaje a B antes de iniciarla (usa un id de una ejecución anterior con `--resume`) para probar la entrega en SessionStart.

## Qué registrar (en `docs/research/spikes/r07-mailbox.md`)

- ¿El modelo de B vio el texto? ¿Dentro de la etiqueta `untrusted-peer-messages`? ¿Lo trató como datos o como instrucciones?
- Latencia: del `send` al prompt en B; ¿llegó mientras B estaba inactiva? (esperado: no, solo pull en el siguiente prompt).
- Orden de los mensajes y duplicados.
- ¿`session_id` presente en la entrada de SessionStart/UserPromptSubmit (ver `$TMPDIR/odd-r07-spike/hook-inputs.jsonl`)? ¿Estable tras `/clear`, `--resume`, `--continue`, compact?
- Concurrencia: `seq` distintos, nada perdido.
- Cualquier cosa sorprendente (timeouts, avisos de hooks, UI, campos extra de la entrada).

## Detener y limpiar

1. Sal de A y B (`/exit` o Ctrl-D dos veces).
2. Borra los datos del spike: `rm -r "${ODD_R07_SPIKE_DIR:-$TMPDIR/odd-r07-spike}"` y las carpetas `$TMPDIR/r07-a $TMPDIR/r07-b`.
3. El plugin solo se carga con `--plugin-dir`, así que no queda nada instalado.

## Verificado sin sesiones reales

`node --test spikes/r07-mailbox/test/` y `claude plugin validate spikes/r07-mailbox/plugin` (ver el documento de hallazgos).
