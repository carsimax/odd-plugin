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
  for (const argv of runs) expect(argv[0]).toBe('git');
});

test('odd-changes degrades silently: no pane API, git failing', async ($: any, on: any) => {
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }));
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal' } }));
  const answer = await $.command.run({ command: 'odd-changes', args: '' } as any);
  expect(answer.text).toBe('Not a git repository; no changes to summarize.');
});
