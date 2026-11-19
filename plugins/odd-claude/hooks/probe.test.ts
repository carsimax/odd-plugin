import { expect, test } from 'claude-code/testing';

function spawnSetup(on: any, file: string | undefined | (() => never), env: any = { CLAUDE_PLUGIN_DATA: '/data' }) {
  const seen: any[] = [];
  on('process.hookEnv', () => (typeof env === 'function' ? env() : { value: env }));
  on('fs.read', () => {
    if (file === undefined) throw new Error('ENOENT');
    if (typeof file === 'function') return file();
    return { value: file };
  });
  on('agent.spawn', (_$: any, e: any) => { seen.push(e); return { model: e.model ?? 'inherited', agentId: 'x1' }; });
  return seen;
}
const prof = (model: unknown, extra: any = {}) => JSON.stringify({ version: 1, sessionId: 'profiles', data: { active: 'custom', routing: { 'odd-worker': { model } } }, ...extra });

test('PROBE spawn: hostile model strings pass through unchanged, never deny', async ($: any, on: any) => {
  const files = [
    prof('opus; rm -rf /'), prof('claude-opus-4-5'), prof('OPUS'), prof(''), prof('opus '), prof(null), prof(5), prof({}), prof(['opus']),
    prof('opus\u001b]0;x\u0007'), 'not json', '', JSON.stringify({ version: 2, data: { routing: { 'odd-worker': { model: 'opus' } } } }),
    JSON.stringify({ version: '1', data: { routing: { 'odd-worker': { model: 'opus' } } } }),
    JSON.stringify({ version: 1, data: { routing: [] } }), JSON.stringify({ version: 1, data: null }), 'null', '[]',
    JSON.stringify({ version: 1, data: { routing: { __proto__: { model: 'opus' } } } }),
  ];
  const box: any = { f: files[0] };
  const seen: any[] = [];
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }));
  on('fs.read', () => ({ value: box.f }));
  on('agent.spawn', (_$: any, e: any) => { seen.push(e); return { model: e.model ?? 'inherited', agentId: 'x1' }; });
  for (const f of files) {
    box.f = f;
    const r = await $.agent.spawn({ prompt: 'x', subagentType: 'odd-claude:odd-worker', model: 'sonnet' } as any);
    expect(r.deny).toBe(undefined);
  }
  expect(seen.length).toBe(files.length);
  expect(seen.map((e: any) => e.model)).toEqual(files.map(() => 'sonnet'));
});

test('PROBE spawn: forks and non-matching types ignored even with a valid profile', async ($: any, on: any) => {
  const seen = spawnSetup(on, prof('opus'));
  const types: any[] = ['odd-claude:odd-worker ', 'ODD-CLAUDE:odd-worker', 'odd-claude:__proto__', 'odd-claude:constructor', 'odd-claude:', 'xodd-claude:odd-worker', undefined, 42];
  for (const t of types) {
    const r = await $.agent.spawn({ prompt: 'x', subagentType: t, model: 'haiku' } as any);
    expect(r.deny).toBe(undefined);
  }
  const rf = await $.agent.spawn({ prompt: 'x', subagentType: 'odd-claude:odd-worker', fork: true } as any);
  expect(rf.deny).toBe(undefined);
  const rok = await $.agent.spawn({ prompt: 'x', subagentType: 'odd-claude:odd-worker', model: 'haiku' } as any);
  expect(seen.map((e: any) => e.model)).toEqual([...types.map(() => 'haiku'), undefined, 'opus']);
  expect(rok.deny).toBe(undefined);
});

test('PROBE spawn: hookEnv throwing, null env, fs.read throwing -> pass through', async ($: any, on: any) => {
  const seen = spawnSetup(on, () => { throw new Error('EACCES'); }, () => { throw new Error('no env'); });
  const r = await $.agent.spawn({ prompt: 'x', subagentType: 'odd-claude:odd-worker', model: 'haiku' } as any);
  expect(r.deny).toBe(undefined);
  expect(seen[0].model).toBe('haiku');
});

let n = 0;
async function draw($: any, props: any) {
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'ToolResult', requestId: `p${++n}`, props } as any);
  const tree = await ui.drawn();
  return { type: tree.type, text: (await ui.find({ type: 'Text' }))?.text };
}
const ON = JSON.stringify({ version: 1, data: { enabled: true } });
const L = (k: number) => Array.from({ length: k }, (_, i) => `l${i}`).join('\n');

test('PROBE quiet: malformed props, missing isErrored, errored -> default; huge output bounded', async ($: any, on: any) => {
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }));
  on('fs.read', () => ({ value: ON }));
  const bad = [
    { tool: 'Bash', output: { stdout: L(50), stderr: '' } },
    { tool: 'Bash', output: { stdout: L(50), stderr: '' }, isErrored: undefined },
    { tool: 'Bash', output: { stdout: L(50), stderr: '' }, isErrored: 'false' },
    { tool: 'Bash', output: { stdout: L(50), stderr: 5 }, isErrored: false },
    { tool: 'Bash', output: { stdout: L(50), stderr: '  \n' , interrupted: 'true'}, isErrored: true },
    { tool: 'Bash', output: [L(50)], isErrored: false },
    { tool: 'Read', output: { file: { content: 5 } }, isErrored: false },
    { tool: 'Grep', output: { content: 7, filenames: 3 }, isErrored: false },
    { tool: 'Bash', output: { stdout: L(50), stderr: '' }, isErrored: false, isExpanded: true },
    { tool: { toString() { throw new Error('x'); } }, output: { stdout: L(50) }, isErrored: false },
  ];
  for (const p of bad) expect((await draw($, p)).type).toBe('engine');
  const t0 = Date.now();
  const huge = await draw($, { tool: 'Bash', output: { stdout: 'a\n'.repeat(3_000_000), stderr: '' }, isErrored: false });
  expect(huge.text).toContain('Bash: ');
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('PROBE changes pane: hostile git output has no escapes; process.run throwing degrades', async ($: any, on: any) => {
  const box: any = { mode: 'hostile' };
  on('process.run', (_$: any, e: any) => {
    if (box.mode === 'throw') throw new Error('no process api');
    const st = ['## main', '?? a\u001b]0;PWN\u0007b', '?? c\u001b[31mR', '?? d‮e', '?? f\u009bm', 'R  n\u001b[2J', 'o', ''].join('\0');
    return { value: { exitCode: 0, stdout: e.argv.includes('status') ? st : ' x\u001b[1m | 1 +\n', stderr: '' } };
  });
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-changes', props: {} } as any);
  const texts = (await ui.findAll({ type: 'Text' })).map((f: any) => f.text);
  expect(texts.length).toBeGreaterThan(3);
  for (const t of texts) expect(/[\u0000-\u001f\u007f-\u009f‪-‮]/.test(t)).toBe(false);
  box.mode = 'throw';
  const ans = await $.command.run({ command: 'odd-changes', args: '' } as any);
  expect(ans.text).toBe('git unavailable or timed out; changes unavailable.');
});

test('PROBE agents pane: hookEnv throwing renders the empty message', async ($: any, on: any) => {
  on('process.hookEnv', () => { throw new Error('nope'); });
  const ui = await $.ui.mount({ plugin: 'odd-claude', surface: 'terminal', component: 'Pane', requestId: 'odd-agents', props: {} } as any);
  const texts = (await ui.findAll({ type: 'Text' })).map((f: any) => f.text);
  expect(texts).toEqual(['No subagents recorded for this session.']);
});
