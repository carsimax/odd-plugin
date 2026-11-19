import { expect, test } from 'claude-code/testing';
import { register } from './register.ts';

// ui.close is not drivable through the harness: drive register() with a recording `on`.
test('closing either pane cancels its refresh timer and never throws', async () => {
  const H: any[] = [];
  register((name: string, a: any, b?: any) => { const h: any = { name, filter: typeof a === 'function' ? undefined : a, fn: typeof a === 'function' ? a : b }; H.push(h); return { catch(c: any) { h.catch = c; return this; } }; });
  let cancelled = 0;
  const $: any = {
    process: { run: async () => ({ exitCode: 0, stdout: '## main\0', stderr: '' }), hookEnv: async () => ({}) },
    ui: { open: async () => ({ isPlaced: true }), invalidate: () => {} },
    clock: { every: () => () => { cancelled++; } },
    session: { id: async () => 's' },
  };
  const next: any = () => 'NEXT';
  for (const id of ['odd-agents', 'odd-changes']) await H.find((h) => h.name === 'command.run' && h.filter?.command === id).fn($, {}, next);
  const close = H.find((h) => h.name === 'ui.close').fn;
  expect(await close($, { id: 'odd-agents' }, next)).toBe('NEXT');
  expect(await close($, { id: 'odd-changes' }, next)).toBe('NEXT');
  expect(cancelled).toBe(2);
});

// Guard (tsc does not typecheck hooks/): drive every registered handler once with a permissive $ so a missing
// identifier surfaces as a ReferenceError instead of being swallowed by the handler's .catch.
test('every registered handler runs without a ReferenceError', async () => {
  const H: any[] = [];
  register((name: string, a: any, b?: any) => { const h: any = { name, filter: typeof a === 'function' ? undefined : a, fn: typeof a === 'function' ? a : b }; H.push(h); return { catch(c: any) { h.catch = c; return this; } }; });
  const el = (props: any) => props;
  const $: any = {
    process: { run: async () => ({ exitCode: 0, stdout: '## main\0', stderr: '' }), hookEnv: async () => ({ CLAUDE_PLUGIN_DATA: '/d' }) },
    fs: { read: async () => '{}' },
    command: { register: async () => undefined },
    ui: { open: async () => ({ isPlaced: true }), invalidate: () => {}, resolve: () => ({ Box: el, Text: el }) },
    clock: { every: () => () => {} },
    session: { id: async () => 's' },
  };
  const next: any = (e: any) => e;
  const events: any[] = [
    {}, { requestId: 'odd-changes' }, { requestId: 'odd-agents' }, { id: 'odd-agents' }, { id: 'odd-changes' },
    { props: { tool: 'Bash', output: { stdout: 'a\n'.repeat(30), stderr: '' }, isErrored: false } }, { subagentType: 'odd-claude:odd-worker' },
  ];
  expect(H.length).toBeGreaterThan(5);
  for (const h of H) {
    for (const e of events) {
      try {
        await h.fn($, e, next);
      } catch (err: any) {
        expect(err instanceof ReferenceError).toBe(false);
      }
    }
  }
});

test('git failing in the mod: non-repo vs other failures vs unavailable', async () => {
  const H: any[] = [];
  register((name: string, a: any, b?: any) => { const h: any = { name, filter: typeof a === 'function' ? undefined : a, fn: typeof a === 'function' ? a : b }; H.push(h); return { catch(c: any) { h.catch = c; return this; } }; });
  let result: any;
  const $: any = {
    process: { run: async () => { if (result === 'throw') throw new Error('x'); return result; } },
    ui: { open: async () => ({ isPlaced: false }) },
  };
  const run = async () => (await H.find((h) => h.name === 'command.run' && h.filter?.command === 'odd-changes').fn($, {}, () => 'NEXT')).text;
  result = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
  expect(await run()).toBe('Not a git repository; no changes to summarize.');
  result = { exitCode: 1, stdout: '', stderr: 'fatal: something else' };
  expect(await run()).toBe('git failed; changes unavailable.');
  result = { exitCode: null, stdout: '', stderr: '' };
  expect(await run()).toBe('git failed; changes unavailable.');
  result = 'throw';
  expect(await run()).toBe('git unavailable or timed out; changes unavailable.');
});
