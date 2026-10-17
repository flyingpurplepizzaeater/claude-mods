import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('upgrades with the session context and fills the prompt box', async ($, on) => {
  const filled: string[] = []
  on('model.fork', () => ({ value: { isAnswered: true, text: '  Fix the login crash in MyApp and run its tests.  ', usage } }) as never)
  on('prompt.fill', (_$, e) => { filled.push(e.text); return { isFilled: true } as never })

  const out = await $.command.run({ command: 'improve', args: 'fix login' } as never)
  expect(filled).toEqual(['Fix the login crash in MyApp and run its tests.'])
  expect(String((out as { text?: string }).text)).toMatch(/in the prompt box/)
})

test('falls back to a plain call, shows the text when the box is unavailable, then sends it', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork', usage } }) as never)
  on('session.cwd', () => ({ value: '/Users/test/projects' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'List the projects in this folder.', usage } }) as never)
  on('prompt.fill', () => ({ isFilled: false }) as never)
  on('prompt.submit', (_$, e) => { sent.push(e.text); return { text: e.text } as never })

  const out = await $.command.run({ command: 'improve', args: 'what projects' } as never)
  expect(String((out as { text?: string }).text)).toMatch(/Upgraded prompt:\n\nList the projects in this folder\./)

  const done = await $.command.run({ command: 'improve', args: 'send' } as never)
  expect(String((done as { text?: string }).text)).toMatch(/Sending/)
  await clock.advance(10)
  expect(sent).toEqual(['List the projects in this folder.'])
})

test('send with nothing upgraded explains what to do', async $ => {
  const out = await $.command.run({ command: 'improve', args: 'send' } as never)
  expect(String((out as { text?: string }).text)).toMatch(/Nothing to send yet/)
})
