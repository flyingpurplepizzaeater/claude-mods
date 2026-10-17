import { expect, mock, test } from 'claude-code/testing'

test('a finished subagent shows as done in the pane', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: { agentId: 'a1', content: [], totalToolUseCount: 0 } }))
  await $.tool.call({ tool: 'Agent', description: 'Find the bug', subagent_type: 'Explore', prompt: 'look' } as never)

  const ui = await $.ui.mount({ plugin: 'agent-dashboard', surface: 'desktop', component: 'Pane', props: {} as never, requestId: 'agent-dashboard' })
  expect(await ui.find({ type: 'Text', text: /✓ Find the bug · Explore/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 running/ })).toBeDefined()
})

test('shows 5-hour and weekly limits as bars', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 48 }, { kind: 'seven_day', percentUsed: 92 }],
  } }) as never)
  on('session.id', () => ({ value: 'x' }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'dashboard', args: '' } as never)

  const ui = await $.ui.mount({ plugin: 'agent-dashboard', surface: 'desktop', component: 'Pane', props: {} as never, requestId: 'agent-dashboard' })
  expect(await ui.find({ type: 'Text', text: /5-hour\s+\[#####-----\] 48%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Weekly\s+\[#########-\] 92%/ })).toBeDefined()
})

const PLAN = 'mcp__ccd_turn__update_plan'
const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({ plugin: 'agent-dashboard', surface: 'desktop', component: 'Pane', props: {} as never, requestId: 'agent-dashboard' })

test('Tasks section follows update_plan items, advance and done', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: [
    { content: 'Look around', status: 'in_progress' },
    { content: 'Fix it', status: 'pending' },
    { content: 'Test it', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: PLAN, advance: true } as never)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Tasks \(1\/3 done\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▶ Fix it' })).toBeDefined()

  await $.tool.call({ tool: PLAN, done: [2, 3] } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /Tasks \(3\/3 done\)/ })).toBeDefined()
})

test('Tasks section follows TodoWrite', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'TodoWrite', todos: [
    { content: 'Alpha', status: 'completed', activeForm: 'a' },
    { content: 'Beta', status: 'in_progress', activeForm: 'b' },
  ] } as never)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Tasks \(1\/2 done\)/ })).toBeDefined()
})

const bash = (stdout: string, isError = false) => ({
  result: { stdout, stderr: '', interrupted: false },
  text: stdout,
  ...(isError ? { isError: true } : {}),
})

test('Tests section shows a passing xcodebuild run', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => bash('Executed 42 tests, with 0 failures (0 unexpected)\n** TEST SUCCEEDED **'))
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App test | xcbeautify' } as never)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /✓ 42 tests, 0 failed/ })).toBeDefined()
})

test('a failed swift test toasts and shows a fail', async ($, on) => {
  mock.clock(on)
  const toast: string[] = []
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', (_$, e) => { toast.push(String(e.text)); return { value: undefined } as never })
  on('tool.call', () => bash('Executed 5 tests, with 2 failures (0 unexpected)', true))
  await $.tool.call({ tool: 'Bash', command: 'swift test' } as never)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /✗ 5 tests, 2 failed/ })).toBeDefined()
  expect(toast.length).toBe(1)
})

test('non-test commands leave the Tests section empty', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => bash('hello'))
  await $.tool.call({ tool: 'Bash', command: 'echo hello' } as never)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /No test runs in this session yet/ })).toBeDefined()
})

const submit = ($: Parameters<Parameters<typeof test>[1]>[0], text: string, midTurn: boolean) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' }, ...(midTurn ? { turnId: 't1' } : {}) } as never)

test('a request typed mid-turn is queued as a task with the queue note', async ($, on) => {
  mock.clock(on)
  const seen: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', (_$, e) => { seen.push({ text: e.text, context: e.context }); return { text: e.text } as never })
  on('ui.toast', () => ({ value: undefined }) as never)

  await submit($, 'also add dark mode to the settings screen', true)
  expect(seen[0].text).toBe('also add dark mode to the settings screen')
  expect(String(seen[0].context?.join('\n'))).toMatch(/Add it as a new pending step at the END of your task list/)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /⏳ also add dark mode to the settings screen/ })).toBeDefined()
})

test('!now skips the queue, and a new request gets only the plan-first note', async ($, on) => {
  mock.clock(on)
  const seen: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', (_$, e) => { seen.push({ text: e.text, context: e.context }); return { text: e.text } as never })

  await submit($, '!now stop and revert that file', true)
  await submit($, 'start a new feature', false)
  expect(seen.map(s => s.text)).toEqual(['stop and revert that file', 'start a new feature'])
  // !now: nothing added; a new (idle) request: only the plan-first note, never the queue note.
  expect((seen[0].context ?? []).some(c => c.includes('[dashboard]'))).toBe(false)
  expect(String(seen[1].context?.join('\n'))).toMatch(/first write its steps to your task list/)
  expect(String(seen[1].context?.join('\n'))).not.toMatch(/while you were in the middle/)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /No tasks in this session yet/ })).toBeDefined()
})

const usageAt = (tokens: number) => ({ value: {
  startedAt: 0,
  context: { window: 1000000, tokens, percent: tokens / 10000 },
  rateLimits: [],
} }) as never

const runDashboard = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], tokens: { n: number }, toasts: string[]) => {
  on('session.usage', () => usageAt(tokens.n))
  on('session.id', () => ({ value: 'x' }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => { toasts.push(String(e.text)); return { value: undefined } as never })
}

test('context warning: none under 150k, yellow past 150k, red past 400k, one toast per threshold', async ($, on) => {
  mock.clock(on)
  const tokens = { n: 120_000 }
  const toasts: string[] = []
  await runDashboard($, on, tokens, toasts)

  await $.command.run({ command: 'dashboard', args: '' } as never)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /⚠ Context past/ })).toBeUndefined()
  expect(toasts.length).toBe(0)

  tokens.n = 250_000
  await $.command.run({ command: 'dashboard', args: '' } as never)
  await $.command.run({ command: 'dashboard', args: '' } as never)
  await ui.redraw()
  const yellow = await ui.find({ type: 'Text', text: /⚠ Context past 150k tokens: consider \/compact, or start a fresh session/ })
  expect(yellow).toBeDefined()
  expect((yellow as any).props.color).toBe('yellow')
  expect(toasts.length).toBe(1)

  tokens.n = 420_000
  await $.command.run({ command: 'dashboard', args: '' } as never)
  await $.command.run({ command: 'dashboard', args: '' } as never)
  await ui.redraw()
  const red = await ui.find({ type: 'Text', text: /⚠ Context past 400k tokens/ })
  expect((red as any).props.color).toBe('red')
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toMatch(/400k/)
})

const NUDGE = /run long builds and tests in the background/

test('with buildReminder on, a foreground xcodebuild gets the background-build note and still runs as asked', { options: { buildReminder: true } }, async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }) as never)
  const ran: string[] = []
  on('tool.call', (_$, e) => { ran.push((e as any).command); return bash('** BUILD SUCCEEDED **') })
  const out = await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App build | xcbeautify' } as never)
  expect(ran).toEqual(['xcodebuild -scheme App build | xcbeautify'])
  expect((out as any).deny).toBeUndefined()
  expect(String((out as any).context?.join('\n'))).toMatch(NUDGE)

  const swift = await $.tool.call({ tool: 'Bash', command: 'swift test' } as never)
  expect(String((swift as any).context?.join('\n'))).toMatch(NUDGE)
})

test('by default (buildReminder off) a foreground build gets no note', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => bash('ok'))
  const out = await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App build' } as never)
  expect(((out as any).context ?? []).some((c: string) => NUDGE.test(c))).toBe(false)
})

test('with buildReminder on, background builds, quick xcodebuild queries and ordinary commands get no note', { options: { buildReminder: true } }, async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => bash('ok'))
  for (const input of [
    { command: 'xcodebuild -scheme App build', run_in_background: true },
    { command: 'xcodebuild -version' },
    { command: 'xcodebuild -list -project App.xcodeproj' },
    { command: 'echo hello' },
  ]) {
    const out = await $.tool.call({ tool: 'Bash', ...input } as never)
    expect(((out as any).context ?? []).some((c: string) => NUDGE.test(c))).toBe(false)
  }
})
