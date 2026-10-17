import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { continuePrompt, effectiveThreshold, goalOf, handoverDir, parseTokens } from './handover'

const NOTE = '## Goal\nShip the scanner export\n\n## Next steps\n1. Fix the axis'

// The world beneath the mod: a session at `tokens`, a fork that answers NOTE, files and MCP calls recorded.
function world(on: On, tokens: number, mcpError: boolean | 'refuse-direct' = false, projectThreshold?: string) {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = { forks: 0, writes: [] as { path: string; text: string }[], mcp: [] as any[], filled: [] as string[], logs: [] as string[], toasts: [] as string[] }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens }, rateLimits: [] } }) as never)
  on('session.id', () => ({ value: 'abcdef1234567890' }) as never)
  on('session.root', () => ({ value: '/Users/test/projects/proj' }) as never)
  on('fs.exists', (_$, e: any) => ({ value: e.path.endsWith('auto-handover.json') && projectThreshold !== undefined }) as never)
  on('fs.read', (_$, e: any) => (e.path.endsWith('auto-handover.json') ? { value: JSON.stringify({ threshold: projectThreshold }) } : { value: '' }) as never)
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? '/Users/test' : undefined }) as never)
  on('session.cwd', () => ({ value: '/Users/test/projects/proj' }) as never)
  on('model.fork', () => { seen.forks += 1; return { value: { isAnswered: true, text: NOTE, usage: {} } } as never })
  on('fs.write', (_$, e: any) => { seen.writes.push({ path: e.path, text: e.text }); return { value: undefined } as never })
  on('mcp.call', (_$, e: any) => {
    seen.mcp.push(e)
    return { value: mcpError === true || (mcpError === 'refuse-direct' && e.args.initiation === 'user_asked') ? { isError: true, content: [{ type: 'text', text: 'no such server' }] } : { isError: false, content: [{ type: 'text', text: 'Started session local_x' }] } } as never
  })
  on('prompt.fill', (_$, e: any) => { seen.filled.push(e.text); return { isFilled: true } as never })
  on('ui.log', (_$, e: any) => { seen.logs.push(e.text); return { value: undefined } as never })
  on('ui.toast', (_$, e: any) => { seen.toasts.push(e.text); return { value: undefined } as never })
  on('turn.complete', (_$, e: any) => ({ text: e.answer }) as never)
  return { clock, seen }
}

const endTurn = ($: any) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
// The first turn never hands over, so most tests finish one quietly first.
const endTwoTurns = async ($: any) => { await endTurn($); await endTurn($) }
// Automatic handover is off by default; these tests switch it on first.
const enable = ($: any) => $.command.run({ command: 'handover', args: 'on' } as never)

test('off by default: past the threshold nothing happens until /handover on', async ($, on) => {
  const { clock, seen } = world(on, 900_000)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.forks).toBe(0)
  const status = await $.command.run({ command: 'handover', args: 'status' } as never)
  expect(String((status as any).text)).toMatch(/^Automatic handover off/)
})

test('below the threshold nothing happens', async ($, on) => {
  const { clock, seen } = world(on, 150_000)
  await enable($)
  await endTwoTurns($)
  await clock.advance(5000)
  expect(seen.forks).toBe(0)
  expect(seen.mcp.length).toBe(0)
})

test('past 200k it writes the handover file and starts a fresh session from it, once', async ($, on) => {
  const { clock, seen } = world(on, 210_000)
  await enable($)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.forks).toBe(1)
  expect(seen.writes.filter(w => w.path.endsWith('.md')).length).toBe(1)
  const { path, text } = seen.writes.find(w => w.path.endsWith('.md'))!
  expect(path).toMatch(/^\/Users\/test\/\.claude\/handovers\/\d{4}-\d\d-\d\d-\d{4}-abcdef12\.md$/)
  expect(text).toMatch(/From session: abcdef1234567890/)
  expect(text).toMatch(/context past 200k, context 210k tokens/)
  expect(text).toMatch(/## Next steps\n1\. Fix the axis/)

  expect(seen.mcp.length).toBe(1)
  const call = seen.mcp[0]
  expect(call.server).toBe('ccd_session')
  expect(call.tool).toBe('start_session')
  expect(call.args.initiation).toBe('user_asked')
  expect(call.args.context).toBe('fresh')
  expect(call.args.title).toBe('Continue: Ship the scanner export')
  expect(call.args.prompt).toContain(path)
  expect(call.args.background.length).toBeGreaterThan(80)
  expect(seen.logs[0]).toMatch(/new session started/)

  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.forks).toBe(1)
})

test('when the app refuses a direct start it proposes the session as a card', async ($, on) => {
  const { clock, seen } = world(on, 210_000, 'refuse-direct')
  await enable($)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.mcp.map(c => c.args.initiation)).toEqual(['user_asked', 'own_initiative'])
  expect(seen.filled.length).toBe(0)
  expect(seen.logs[0]).toMatch(/session card is waiting/)
})

test('with no desktop session server it leaves the continue prompt in the box', async ($, on) => {
  const { clock, seen } = world(on, 210_000, true)
  await enable($)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.writes.filter(w => w.path.endsWith('.md')).length).toBe(1)
  expect(seen.filled[0]).toContain(seen.writes.find(w => w.path.endsWith('.md'))!.path)
  expect(seen.logs[0]).toMatch(/run \/clear, then send it/)
})

test('a lowered threshold fires earlier; off stops it', async ($, on) => {
  const { clock, seen } = world(on, 60_000)
  const set = await $.command.run({ command: 'handover', args: 'threshold 50k' } as never)
  expect(String((set as any).text)).toMatch(/past 50k/)
  await $.command.run({ command: 'handover', args: 'off' } as never)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.forks).toBe(0)
  await $.command.run({ command: 'handover', args: 'on' } as never)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.forks).toBe(1)
  const status = await $.command.run({ command: 'handover', args: 'status' } as never)
  expect(String((status as any).text)).toMatch(/on; fires past 50k tokens\. This session: 60k tokens, already handed over/)
})

test('/handover hands over on demand, whatever the size', async ($, on) => {
  const { seen } = world(on, 10_000)
  const out = await $.command.run({ command: 'handover', args: '' } as never)
  expect(seen.writes.filter(w => w.path.endsWith('.md')).length).toBe(1)
  expect(seen.mcp.length).toBe(1)
  expect(String((out as any).text)).toMatch(/Handover written to .* new session started/)
})

test('never on the first turn of a session (a fresh continuation cannot chain)', async ($, on) => {
  const { clock, seen } = world(on, 900_000)
  await enable($)
  await endTurn($)
  await clock.advance(2000)
  expect(seen.forks).toBe(0)
})

test('a project .claude/auto-handover.json lowers the threshold for that project', async ($, on) => {
  const { clock, seen } = world(on, 25_000, false, '20k')
  await enable($)
  await endTwoTurns($)
  await clock.advance(2000)
  expect(seen.forks).toBe(1)
  expect(seen.writes.find(w => w.path.endsWith('.md'))!.text).toMatch(/context past 20k/)
})

test('helpers', () => {
  expect(parseTokens('200k')).toBe(200_000)
  expect(parseTokens('1.5m')).toBe(1_500_000)
  expect(parseTokens('abc')).toBeUndefined()
  expect(effectiveThreshold(200_000, 200_000)).toBe(160_000)
  expect(effectiveThreshold(200_000, 1_000_000)).toBe(200_000)
  expect(goalOf('**Goal**: Do the thing\n\n**Done**')).toBe('Do the thing')
  expect(continuePrompt('/x/h.md', '/p')).toContain('/x/h.md')
})

test('the handover folder follows HOME, or CLAUDE_CONFIG_DIR when set', () => {
  expect(handoverDir('/Users/test')).toBe('/Users/test/.claude/handovers')
  expect(handoverDir('/Users/test/', '')).toBe('/Users/test/.claude/handovers')
  expect(handoverDir('/Users/test', '/opt/claude-config/')).toBe('/opt/claude-config/handovers')
})
