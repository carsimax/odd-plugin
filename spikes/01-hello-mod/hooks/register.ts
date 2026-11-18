export function register(on: any) {
  on('session.start', async ($: any, e: any, next: any) => {
    await $.command.register({ name: 'odd-hello', description: 'Open the odd hello pane' })
    await $.tool.register({
      name: 'odd_ping',
      description: 'Returns ODD-PONG',
      inputSchema: { type: 'object', properties: {} },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__odd-hello-mod__odd_ping' }, async () => ({ result: 'ODD-PONG' }))

  on('prompt.compose', async ($: any, e: any, next: any) => {
    return next({ ...e, sections: [...e.sections, { id: 'odd-hello', text: 'ODD-HELLO-SECTION-77', scope: 'session' }] })
  })

  on('command.run', { command: 'odd-hello' }, async ($: any) => {
    await $.ui.open({ id: 'odd-hello', title: 'odd hello', focus: true, closeOnEscape: true })
    return { text: 'hello from odd-hello-mod' }
  })

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== 'odd-hello') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ key: 'root' }, Text({ key: 't' }, 'ODD-PANE'))
  })

  // alternative to prompt.compose (which the builtin guard answers first): append to the 'environment'-agnostic first section
  let done = false
  on('prompt.section', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (done || !r || typeof r.text !== 'string') return r
    done = true
    return { ...r, text: r.text + '\nODD-SECTION-APPEND-55' }
  })
  on('prompt.context', async ($: any, e: any, next: any) => {
    const r = await next(e)
    return { ...r, blocks: [...(r?.blocks ?? []), 'ODD-CONTEXT-BLOCK-66'] }
  })
}
