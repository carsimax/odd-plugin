// odd-claude mod (R09): optional live subagents pane. Everything here is an enhancement over the command hooks:
// the plugin works without it (mods off, `-p`, safe mode) and `/odd-claude:agents` prints the same table.
// Rules: the mod never touches the prompt or tool calls, only answers its own commands and panes, and any
// missing API degrades silently. The one routing hook is the spawn hook of R40: it only ever rewrites `model`
// of an odd-claude agent from the active profile and always continues with next(...); it never refuses a spawn. The table format mirrors src/lib/subagents.ts renderSubagents.
// Only static relative imports are allowed in a mod, so the formatters are repeated below.
// R51 quiet tool rendering: `ui.render` on ToolResult draws long, successful Bash/Read/Grep/Glob results as one summary
// line, only when `<data>/quiet.json` says enabled (OFF by default, `/odd-claude:quiet`). Render-only (the model sees
// the stored result), bounded work per render, and anything unknown, errored, interrupted, expanded or unreadable
// falls through to next(e), the default rendering.
// `/odd-changes` (R46) opens a pane with the working-tree summary of src/lib/changes.ts (git status + diff --stat,
// read-only, bounded timeout), refreshed on a timer; `/odd-claude:changes` prints the same text without mods.

type Rec = { id: string; type: string; startedAt?: number; endedAt?: number };

const COMMAND = 'odd-agents';
const PANE = 'odd-agents';
const CHANGES_COMMAND = 'odd-changes';
const CHANGES_PANE = 'odd-changes';
const ROLE_PREFIX = 'odd-claude:';
const ROLES = ['odd-explore', 'odd-verify', 'odd-worker', 'odd-jd-fix', 'odd-jd-judge-a', 'odd-jd-judge-b', 'odd-review-readability', 'odd-review-reliability', 'odd-review-resilience', 'odd-review-risk'];
const MODELS = ['haiku', 'sonnet', 'opus'];
const QUIET_MIN_LINES = 10;
const QUIET_SCAN_CAP = 1_000_000;
const NOT_A_REPO = 'Not a git repository; no changes to summarize.';
const GIT_FAILED = 'git failed; changes unavailable.';
const GIT_UNAVAILABLE = 'git unavailable or timed out; changes unavailable.';
const CHANGES_TTL_MS = 4000;

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

// Copy of cleanText in src/lib/statusline.ts (mods allow only static relative imports): keep both identical; the
// parity spec src/lib/changes-parity.spec.ts compares the three replace() patterns.
function cleanText(s: unknown): string {
  if (typeof s !== 'string') return '';
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
      .trim()
  );
}
const clean = (s: string) => cleanText(s).slice(0, 200);

export function summarizeChanges(statusZ: string, stat: string | undefined): string {
  const tokens = statusZ.split('\0');
  let branch = '';
  const entries: string[] = [];
  let untracked = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '') continue;
    if (t.startsWith('## ')) {
      branch = clean(t.slice(3).split('...')[0].replace(/^No commits yet on /, '').replace(/^Initial commit on /, ''));
      continue;
    }
    const code = t.slice(0, 2);
    const path = clean(t.slice(3));
    if (code === '??') untracked++;
    if (/[RC]/.test(code)) entries.push(`${code} ${clean(tokens[++i] ?? '')} -> ${path}`);
    else entries.push(`${code} ${path}`);
  }
  const head = `odd-claude changes${branch === '' ? '' : ` · branch ${branch}`}`;
  if (entries.length === 0) return `${head}\nWorking tree clean.`;
  const out = [head, ...entries.slice(0, 50)];
  if (entries.length > 50) out.push(`… and ${entries.length - 50} more`);
  out.push(`${entries.length} changed, ${untracked} untracked`);
  const lines = (stat ?? '').split('\n').map(clean).filter((l) => l !== '');
  const statLines = lines.length <= 40 ? lines : [...lines.slice(0, 39), '…', lines[lines.length - 1]];
  if (statLines.length > 0) out.push('', ...statLines);
  return out.join('\n');
}

type GitOut = { out: string } | { fail: 'not-a-repo' | 'failed' };

async function git($: any, args: string[]): Promise<GitOut> {
  const r = await $.process.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], { timeoutMs: 5000 });
  if (r && r.exitCode === 0 && typeof r.stdout === 'string') return { out: r.stdout };
  return { fail: typeof r?.stderr === 'string' && /not a git repository/i.test(r.stderr) ? 'not-a-repo' : 'failed' };
}

async function changesText($: any): Promise<string> {
  try {
    const status = await git($, ['status', '--porcelain=v1', '-z', '--branch']);
    if ('fail' in status) return status.fail === 'not-a-repo' ? NOT_A_REPO : GIT_FAILED;
    let stat: string | undefined;
    try {
      const head = await git($, ['diff', '--stat', '--no-color', 'HEAD']);
      const plain = 'out' in head ? head : await git($, ['diff', '--stat', '--no-color']);
      stat = 'out' in plain ? plain.out : undefined;
    } catch {
      stat = undefined;
    }
    return summarizeChanges(status.out, stat);
  } catch {
    return GIT_UNAVAILABLE;
  }
}

function cancel(t: any) {
  try {
    if (typeof t === 'function') t();
    else t?.cancel?.();
  } catch {
    // ignore
  }
}

// The pane re-renders every refresh; one git run per interval (shared while in flight) so a hung git cannot cost
// its timeout on every render. The command always runs fresh.
let changesCache: { at: number; text: Promise<string> } | undefined;
function cachedChanges($: any): Promise<string> {
  const now = Date.now();
  if (changesCache === undefined || now - changesCache.at >= CHANGES_TTL_MS || now < changesCache.at) changesCache = { at: now, text: changesText($) };
  return changesCache.text;
}

function countLines(text: string): number {
  const t = text.length > QUIET_SCAN_CAP ? text.slice(0, QUIET_SCAN_CAP) : text;
  let n = 0;
  for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++;
  return t === '' ? 0 : t.endsWith('\n') ? n : n + 1;
}

// One-line summary of a successful built-in result, or undefined = draw it normally (short, odd shape, error signs).
export function quietSummary(tool: unknown, output: unknown): string | undefined {
  try {
    if (typeof output !== 'object' || output === null || Array.isArray(output)) return undefined;
    const o = output as Record<string, any>;
    let line: string | undefined;
    if (tool === 'Bash') {
      if (typeof o.stdout !== 'string' || o.interrupted === true) return undefined;
      if (o.stderr !== undefined && (typeof o.stderr !== 'string' || o.stderr.trim() !== '')) return undefined;
      const n = countLines(o.stdout);
      if (n > QUIET_MIN_LINES) line = `Bash: ${n} lines of output`;
    } else if (tool === 'Read') {
      const content = o.file?.content;
      if (typeof content !== 'string') return undefined;
      const n = countLines(content);
      if (n > QUIET_MIN_LINES) line = `Read: ${n} lines`;
    } else if (tool === 'Grep') {
      const files = Array.isArray(o.filenames) ? o.filenames.length : undefined;
      if (typeof o.content === 'string') {
        const n = countLines(o.content);
        if (n > QUIET_MIN_LINES) line = `Grep: ${n} lines${files === undefined ? '' : ` in ${files} files`}`;
      } else if (files !== undefined && files > QUIET_MIN_LINES) line = `Grep: ${files} files`;
    } else if (tool === 'Glob') {
      if (Array.isArray(o.filenames) && o.filenames.length > QUIET_MIN_LINES) line = `Glob: ${o.filenames.length} files`;
    }
    return line === undefined ? undefined : `${line} (ctrl+o to expand)`;
  } catch {
    return undefined;
  }
}

async function quietEnabled($: any): Promise<boolean> {
  try {
    const env = await $.process.hookEnv();
    const dir = env?.CLAUDE_PLUGIN_DATA;
    if (typeof dir !== 'string' || dir === '') return false;
    const raw = JSON.parse(await $.fs.read(`${dir}/quiet.json`));
    return raw?.version === 1 && raw?.data?.enabled === true;
  } catch {
    return false;
  }
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

// R40: model of an odd-claude agent from <data>/profiles.json (written by /odd-claude:profiles, same whitelist
// as src/lib/profiles.ts); undefined = no profile, not ours or anything unreadable, i.e. leave the spawn alone.
export async function routedModel($: any, subagentType: unknown): Promise<string | undefined> {
  try {
    if (typeof subagentType !== 'string' || !subagentType.startsWith(ROLE_PREFIX)) return undefined;
    const role = subagentType.slice(ROLE_PREFIX.length);
    if (!ROLES.includes(role)) return undefined;
    const env = await $.process.hookEnv();
    const dir = env?.CLAUDE_PLUGIN_DATA;
    if (typeof dir !== 'string' || dir === '') return undefined;
    const raw = JSON.parse(await $.fs.read(`${dir}/profiles.json`));
    const model = raw?.version === 1 ? raw?.data?.routing?.[role]?.model : undefined;
    return typeof model === 'string' && MODELS.includes(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

export function register(on: any) {
  let timer: any;
  let changesTimer: any;

  on('session.start', async ($: any, e: any, next: any) => {
    try {
      await $.command.register({ name: COMMAND, description: 'Live pane of this session\'s subagents (odd-claude)' });
    } catch {
      // API missing: the /odd-claude:agents skill is the fallback
    }
    try {
      await $.command.register({ name: CHANGES_COMMAND, description: 'Working-tree changes pane (odd-claude)' });
    } catch {
      // API missing: the /odd-claude:changes skill is the fallback
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

  on('command.run', { command: CHANGES_COMMAND }, async ($: any) => {
    const text = await changesText($);
    changesCache = { at: Date.now(), text: Promise.resolve(text) };
    try {
      await $.ui.open({ id: CHANGES_PANE, title: 'odd changes', focus: true, closeOnEscape: true });
      if (changesTimer === undefined) changesTimer = $.clock.every(5000, () => $.ui.invalidate('ui.render'));
    } catch {
      // no panes here: the text answer below is the whole output
    }
    return { text };
  }).catch(() => ({ text: 'odd-changes: unavailable (see /odd-claude:changes)' }));

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e?.requestId !== CHANGES_PANE) return next(e);
    try {
      const { Box, Text } = $.ui.resolve(e);
      const lines = (await cachedChanges($)).split('\n');
      return Box({ key: 'root', children: lines.map((l, i) => Text({ key: `l${i}`, children: l })) });
    } catch {
      return next(e);
    }
  });

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e?.requestId !== PANE) return next(e);
    try {
      const { Box, Text } = $.ui.resolve(e);
      const lines = tableLines(await load($), Date.now());
      return Box({ key: 'root', children: lines.map((l, i) => Text({ key: `l${i}`, children: l })) });
    } catch {
      return next(e);
    }
  });

  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any, next: any) => {
    try {
      const props = e?.props;
      if (props?.isErrored !== false || props?.isExpanded === true) return next(e);
      const line = quietSummary(props.tool, props.output);
      if (line === undefined || !(await quietEnabled($))) return next(e);
      // constructors take props only: children go in `children` (ElementConstructor)
      const { Text } = $.ui.resolve(e);
      return Text({ children: line });
    } catch {
      return next(e);
    }
  });

  on('agent.spawn', async ($: any, e: any, next: any) => {
    const model = e?.fork === true ? undefined : await routedModel($, e?.subagentType);
    if (model === undefined) return next(e);
    return next({ ...e, model });
  });

  on('ui.close', async ($: any, e: any, next: any) => {
    if (e?.id === PANE || e?.requestId === PANE) {
      cancel(timer);
      timer = undefined;
    }
    if (e?.id === CHANGES_PANE || e?.requestId === CHANGES_PANE) {
      cancel(changesTimer);
      changesTimer = undefined;
    }
    return next(e);
  }).catch(($: any, e: any, next: any) => (next.called ? undefined : next(e)));
}
