// odd-claude mod (R09): optional live subagents pane. Everything here is an enhancement over the command hooks:
// the plugin works without it (mods off, `-p`, safe mode) and `/odd-claude:agents` prints the same table.
// Rules: the mod never touches the prompt or tool calls, only answers its own command and pane, and any
// missing API degrades silently. The table format mirrors src/lib/subagents.ts renderSubagents.
// Only static relative imports are allowed in a mod, so the formatter is repeated below.

type Rec = { id: string; type: string; startedAt?: number; endedAt?: number };

const COMMAND = 'odd-agents';
const PANE = 'odd-agents';

function duration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h${p(m)}m${p(s % 60)}s`;
  if (m > 0) return `${m}m${p(s % 60)}s`;
  return `${s % 60}s`;
}

export function tableLines(records: Rec[], now: number): string[] {
  if (records.length === 0) return ['No subagents recorded for this session.'];
  const sorted = [...records].sort((a, b) => (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0));
  const rows = sorted.map((r) => [
    r.type,
    r.startedAt === undefined ? '-' : new Date(r.startedAt).toISOString().slice(11, 19),
    r.endedAt === undefined ? 'running' : 'done',
    r.startedAt === undefined ? '-' : duration((r.endedAt ?? now) - r.startedAt),
  ]);
  const table = [['AGENT_TYPE', 'STARTED (UTC)', 'STATUS', 'DURATION'], ...rows];
  const widths = [0, 1, 2].map((i) => Math.max(...table.map((r) => r[i].length)) + 2);
  const lines = table.map((r) => [0, 1, 2].map((i) => r[i].padEnd(widths[i])).join('') + r[3]);
  const running = records.filter((r) => r.endedAt === undefined).length;
  return [...lines, `${records.length} subagent${records.length === 1 ? '' : 's'} (${running} running)`];
}

async function load($: any): Promise<Rec[]> {
  try {
    const env = await $.process.hookEnv();
    const dir = env?.CLAUDE_PLUGIN_DATA;
    const id = env?.CLAUDE_CODE_SESSION_ID ?? (await $.session.id());
    if (typeof dir !== 'string' || typeof id !== 'string' || id === '') return [];
    const seg = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || '_';
    const raw = JSON.parse(await $.fs.read(`${dir}/sessions/${seg}.json`));
    const list = raw?.data?.subagents;
    return Array.isArray(list) ? list.filter((r: any) => r && typeof r.id === 'string' && typeof r.type === 'string') : [];
  } catch {
    return [];
  }
}

export function register(on: any) {
  let timer: any;

  on('session.start', async ($: any, e: any, next: any) => {
    try {
      await $.command.register({ name: COMMAND, description: 'Live pane of this session\'s subagents (odd-claude)' });
    } catch {
      // API missing: the /odd-claude:agents skill is the fallback
    }
    return next(e);
  });

  on('command.run', { command: COMMAND }, async ($: any) => {
    const text = tableLines(await load($), Date.now()).join('\n');
    try {
      await $.ui.open({ id: PANE, title: 'odd agents', focus: true, closeOnEscape: true });
      if (timer === undefined) timer = $.clock.every(2000, () => $.ui.invalidate('ui.render'));
    } catch {
      // no panes here: the text answer below is the whole output
    }
    return { text };
  }).catch(() => ({ text: 'odd-agents: unavailable (see /odd-claude:agents)' }));

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const lines = tableLines(await load($), Date.now());
    return Box({ key: 'root' }, ...lines.map((l, i) => Text({ key: `l${i}` }, l)));
  });

  on('ui.close', async ($: any, e: any, next: any) => {
    if (e?.id === PANE || e?.requestId === PANE) {
      try {
        if (typeof timer === 'function') timer();
        else timer?.cancel?.();
      } catch {
        // ignore
      }
      timer = undefined;
    }
    return next(e);
  }).catch(($: any, e: any, next: any) => (next.called ? undefined : next(e)));
}
