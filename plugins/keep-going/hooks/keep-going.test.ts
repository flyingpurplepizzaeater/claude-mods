import { expect, test } from 'claude-code/testing'
import { findHandBack } from './check'

const stop = (last: string, active = false) => ({ stop_hook_active: active, last_assistant_message: last })

test('spots hand-backs at the end of a message', async () => {
  expect(findHandBack('Built the view.\n\nWant me to wire up the API next?')).toBe('Want me to wire up the API next?')
  expect(findHandBack('Done. Let me know if you want changes.')).toBeTruthy()
  expect(findHandBack('Should I also add tests?')).toBeTruthy()
  expect(findHandBack('All 12 tests pass and the build is green.')).toBeUndefined()
  expect(findHandBack('I should add a cache here, so I did.')).toBeUndefined()
  expect(findHandBack(undefined)).toBeUndefined()
})

test('blocks a prose hand-back once', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'build it', turnId: 't1' })
  const first = await $.classic.Stop(stop('Done.\nWant me to add dark mode?'))
  expect(first.block).toContain('AskUserQuestion')
  const second = await $.classic.Stop(stop('Done.\nWant me to add dark mode?', true))
  expect(second.block).toBeUndefined()
})

test('lets a finished turn stop', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'build it', turnId: 't1' })
  const r = await $.classic.Stop(stop('Added dark mode; tests pass.'))
  expect(r.block).toBeUndefined()
})

test('lets a turn that asked with options stop', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  const r = await $.classic.Stop(stop('Which database should I use?'))
  expect(r.block).toBeUndefined()
})

test('a wrap_up with an ask counts, one without does not', async ($, on) => {
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x' } as never)
  expect((await $.classic.Stop(stop('Want me to push it?'))).block).toBeTruthy()
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x', ask: 'Push it?' } as never)
  expect((await $.classic.Stop(stop('Want me to push it?'))).block).toBeUndefined()
})
