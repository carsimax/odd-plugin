import { expect, test } from 'claude-code/testing';

const NOW_SESSION = {
  version: 1,
  sessionId: 's1',
  data: {
    subagents: [
      { id: 'a1', type: 'odd-claude:odd-explore', startedAt: Date.UTC(2026, 10, 18, 10, 0, 0), endedAt: Date.UTC(2026, 10, 18, 10, 1, 5) },
      { id: 'a3', type: 'general-purpose', endedAt: Date.UTC(2026, 10, 18, 10, 3, 0) },
    ],
  },
};

test('odd-agents command is registered on session start', async ($: any, on: any) => {
  const names: string[] = [];
  on('session.start', () => ({ cwd: '/tmp' }));
  on('command.register', (_$: any, e: any) => { names.push(e.name); return { value: undefined }; });
  await $.session.start({ cwd: '/tmp' } as any);
  expect(names).toContain('odd-agents');
});

test('odd-agents opens the pane and answers the table; the pane renders it', async ($: any, on: any) => {
  let opened: any;
  on('ui.open', (_$: any, e: any) => { opened = e; return { value: { isPlaced: true } }; });
  on('clock.every', () => ({ value: 1 }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data', CLAUDE_CODE_SESSION_ID: 's1' } }));
  on('fs.read', () => ({ value: JSON.stringify(NOW_SESSION) }));
  const answer = await $.command.run({ command: 'odd-agents', args: '' } as any);
  expect(opened.id).toBe('odd-agents');
  expect(answer.text).toBe([
    'AGENT_TYPE              STARTED (UTC)  STATUS  DURATION',
    'general-purpose         -              done    -',
    'odd-claude:odd-explore  10:00:00       done    1m05s',
    '2 subagents (0 running)',
  ].join('\n'));
});

test('odd-agents degrades silently when the pane API refuses', async ($: any, on: any) => {
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }));
  on('process.hookEnv', () => ({ value: {} }));
  const answer = await $.command.run({ command: 'odd-agents', args: '' } as any);
  expect(answer.text).toBe('No subagents recorded for this session.');
});

const STATUS_Z = ['## main...origin/main', ' M a.txt', '?? new.txt', ''].join('\0');
const STAT = ' a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n';
const CHANGES_TEXT = [
  'odd-claude changes · branch main',
  ' M a.txt',
  '?? new.txt',
  '2 changed, 1 untracked',
  '',
  'a.txt | 2 +-',
  '1 file changed, 1 insertion(+), 1 deletion(-)',
].join('\n');

test('odd-changes command is registered on session start', async ($: any, on: any) => {
  const names: string[] = [];
  on('session.start', () => ({ cwd: '/tmp' }));
  on('command.register', (_$: any, e: any) => { names.push(e.name); return { value: undefined }; });
  await $.session.start({ cwd: '/tmp' } as any);
  expect(names).toContain('odd-changes');
});

test('odd-changes opens a pane and answers the working-tree summary; the pane renders the same text', async ($: any, on: any) => {
  let opened: any;
  const runs: string[][] = [];
  on('ui.open', (_$: any, e: any) => { opened = e; return { value: { isPlaced: true } }; });
  on('clock.every', () => ({ value: 1 }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv);
    return { value: { exitCode: 0, stdout: e.argv.includes('status') ? STATUS_Z : STAT, stderr: '' } };
  });
  const answer = await $.command.run({ command: 'odd-changes', args: '' } as any);
  expect(opened.id).toBe('odd-changes');
  expect(answer.text).toBe(CHANGES_TEXT);
  // read-only git only, no user text on any command line
  // git runs under the C locale (stderr classification is English-only)
  for (const argv of runs) expect(argv.slice(0, 5)).toEqual(['env', '-u', 'LANGUAGE', 'LC_ALL=C', 'LANG=C']);
  for (const argv of runs) expect(argv[5]).toBe('git');
});

test('odd-changes degrades silently: no pane API, git failing', async ($: any, on: any) => {
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }));
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }));
  const answer = await $.command.run({ command: 'odd-changes', args: '' } as any);
  expect(answer.text).toBe('Not a git repository; no changes to summarize.');
});

const PROFILE_FILE = JSON.stringify({ version: 1, sessionId: 'profiles', data: { active: 'economy', routing: { 'odd-explore': { model: 'haiku', effort: 'low' }, 'odd-worker': { model: 'sonnet' }, 'odd-verify': { model: 'evil' } } } });

function spawnSetup($: any, on: any, file: string | undefined) {
  const seen: any[] = [];
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }));
  on('fs.read', () => {
    if (file === undefined) throw new Error('ENOENT');
    return { value: file };
  });
  on('agent.spawn', (_$: any, e: any) => { seen.push(e); return { model: e.model ?? 'inherited', agentId: 'x1' }; });
  return seen;
}

test('agent.spawn rewrites the model of an odd-claude agent from the active profile', async ($: any, on: any) => {
  const seen = spawnSetup($, on, PROFILE_FILE);
  const r = await $.agent.spawn({ prompt: 'look around', subagentType: 'odd-claude:odd-explore' } as any);
  expect(seen.length).toBe(1);
  expect(seen[0].model).toBe('haiku');
  expect(seen[0].prompt).toBe('look around');
  expect(r.deny).toBe(undefined);
});

test('agent.spawn leaves other agents, unknown roles, bad models and a missing profile untouched, and never refuses', async ($: any, on: any) => {
  const seen = spawnSetup($, on, PROFILE_FILE);
  for (const subagentType of ['general-purpose', 'other-plugin:odd-explore', 'odd-claude:odd-unknown', 'odd-claude:odd-verify']) {
    const r = await $.agent.spawn({ prompt: 'x', subagentType, model: 'opus' } as any);
    expect(r.deny).toBe(undefined);
  }
  expect(seen.map((e: any) => e.model)).toEqual(['opus', 'opus', 'opus', 'opus']);
});

test('agent.spawn with no profile file or unreadable state passes the spawn through', async ($: any, on: any) => {
  const seen = spawnSetup($, on, undefined);
  const r = await $.agent.spawn({ prompt: 'x', subagentType: 'odd-claude:odd-worker' } as any);
  expect(seen.length).toBe(1);
  expect(seen[0].model).toBe(undefined);
  expect(r.deny).toBe(undefined);
});

// R51 quiet tool rendering: OFF by default, render-only, errors and small outputs untouched.
const QUIET_ON = JSON.stringify({ version: 1, sessionId: 'quiet', data: { enabled: true } });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

// `box.file` can change between mounts: hooks may only be registered before the test first calls `$`.
function quietSetup(on: any, file: string | undefined) {
  const box = { file };
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }));
  on('fs.read', () => {
    if (box.file === undefined) throw new Error('ENOENT');
    return { value: box.file };
  });
  return box;
}

let mounts = 0;

async function drawn($: any, tool: string, output: unknown, extra: Record<string, unknown> = {}) {
  const ui = await $.ui.mount({
    plugin: 'odd-claude',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: `t${++mounts}`,
    props: { tool_use_id: `t${mounts}`, tool, output, isErrored: false, ...extra },
  } as any);
  const tree = await ui.drawn();
  return { type: tree.type, text: (await ui.find({ type: 'Text' }))?.text };
}

test('quiet ON collapses long Bash/Read/Grep/Glob results to one summary line', async ($: any, on: any) => {
  quietSetup(on, QUIET_ON);
  const bash = await drawn($, 'Bash', { stdout: lines(120), stderr: '' });
  expect(bash.text).toContain('Bash: 120 lines of output');
  const read = await drawn($, 'Read', { type: 'text', file: { filePath: '/x', content: lines(300), numLines: 300 } });
  expect(read.text).toContain('Read: 300 lines');
  const grep = await drawn($, 'Grep', { mode: 'content', numFiles: 4, filenames: ['a', 'b', 'c', 'd'], content: lines(40), numLines: 40 });
  expect(grep.text).toContain('Grep: 40 lines in 4 files');
  const glob = await drawn($, 'Glob', { filenames: Array.from({ length: 80 }, (_, i) => `f${i}`), numFiles: 80 });
  expect(glob.text).toContain('Glob: 80 files');
});

test('quiet OFF (default, missing, corrupt or disabled state) draws the default rendering', async ($: any, on: any) => {
  const box = quietSetup(on, undefined);
  for (const file of [undefined, 'not json', JSON.stringify({ version: 1, data: { enabled: false } }), JSON.stringify({ version: 2, data: { enabled: true } })]) {
    box.file = file;
    const tree = await drawn($, 'Bash', { stdout: lines(120), stderr: '' });
    expect(tree.type).toBe('engine');
  }
});

test('quiet ON never hides errors, stderr, interrupts, expanded rows, small outputs, unknown tools or odd shapes', async ($: any, on: any) => {
  quietSetup(on, QUIET_ON);
  const big = { stdout: lines(120), stderr: '' };
  const cases: Array<[string, unknown, Record<string, unknown>]> = [
    ['Bash', big, { isErrored: true }],
    ['Bash', { stdout: lines(120), stderr: 'boom' }, {}],
    ['Bash', { stdout: lines(120), stderr: '', interrupted: true }, {}],
    ['Bash', big, { isExpanded: true }],
    ['Bash', { stdout: lines(3), stderr: '' }, {}],
    ['Edit', big, {}],
    ['mcp__x__y', big, {}],
    ['Bash', 'a string', {}],
    ['Bash', null, {}],
    ['Read', { file: 5 }, {}],
    ['Glob', { filenames: 'nope' }, {}],
  ];
  for (const [tool, output, extra] of cases) {
    const tree = await drawn($, tool, output, extra);
    expect(tree.type).toBe('engine');
  }
});

test('quiet rendering is render-only: it registers no tool or permission hooks and never refuses', async ($: any, on: any) => {
  quietSetup(on, QUIET_ON);
  let hooked = 0;
  on('tool.call', () => { hooked++; return { result: undefined }; });
  const tree = await drawn($, 'Bash', { stdout: lines(50), stderr: '' });
  expect(tree.text).toContain('Bash: 50 lines');
  expect(hooked).toBe(0);
});

// Panes: the constructors take props only (children go in `children`), so the drawn tree must hold the text.
test('the odd-agents pane draws its table as Text rows', async ($: any, on: any) => {
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data', CLAUDE_CODE_SESSION_ID: 's1' } }));
  on('fs.read', () => ({ value: JSON.stringify(NOW_SESSION) }));
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-agents', props: {} } as any);
  const texts = (await ui.findAll({ type: 'Text' })).map((f: any) => f.text);
  expect(texts).toEqual([
    'AGENT_TYPE              STARTED (UTC)  STATUS  DURATION',
    'general-purpose         -              done    -',
    'odd-claude:odd-explore  10:00:00       done    1m05s',
    '2 subagents (0 running)',
  ]);
});

test('the odd-changes pane draws the working-tree summary as Text rows', async ($: any, on: any) => {
  on('process.run', (_$: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv.includes('status') ? STATUS_Z : STAT, stderr: '' } }));
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-changes', props: {} } as any);
  const texts = (await ui.findAll({ type: 'Text' })).map((f: any) => f.text);
  expect(texts).toEqual(CHANGES_TEXT.split('\n'));
});

test('a pane that is not ours is left to the default rendering', async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'someone-else', props: {} } as any);
  expect((await ui.drawn()).type).toBe('engine');
});

test('odd-changes pane: names carry no escape-sequence residue (parity with the CLI)', async ($: any, on: any) => {
  on('process.run', (_$: any, e: any) => {
    const st = ['## main', '?? a\u001b]0;PWN\u0007b', '?? c\u001b[31mR', ''].join('\0');
    return { value: { exitCode: 0, stdout: e.argv.includes('status') ? st : '', stderr: '' } };
  });
  const answer = await $.command.run({ command: 'odd-changes', args: '' } as any);
  expect(answer.text).toBe('odd-claude changes · branch main\n?? ab\n?? cR\n2 changed, 2 untracked');
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-changes', props: {} } as any);
  const texts = (await ui.findAll({ type: 'Text' })).map((f: any) => f.text);
  expect(texts).toContain('?? ab');
  for (const t of texts) expect(/[\u0000-\u001f\u007f-\u009f]|\]0;|\[31m/.test(t)).toBe(false);
});

test('odd-changes pane: renders within one refresh interval reuse a single git run', async ($: any, on: any) => {
  let runs = 0;
  on('process.run', () => { runs++; return { value: { exitCode: 0, stdout: '## main\0', stderr: '' } }; });
  let ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-changes', props: {} } as any);
  await ui.drawn();
  for (let i = 0; i < 3; i++) {
    await ui.unmount();
    ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-changes', props: {} } as any);
    await ui.drawn();
  }
  // first render runs status + diff (HEAD, then plain when HEAD yields nothing); later renders hit the cache
  expect(runs).toBeLessThanOrEqual(3);
});
