import { expect, test } from 'claude-code/testing'

test('odd-hello command replies', async ($, on) => {
  // stub the pane open so the command can answer in the test kit
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const answer = await $.command.run({ command: 'odd-hello', args: '' } as any)
  expect(answer.text).toBe('hello from odd-hello-mod')
})
