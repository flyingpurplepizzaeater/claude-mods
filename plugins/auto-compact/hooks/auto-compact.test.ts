import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseTokens, redact, transcript } from './save'

const MESSAGES = [
  { role: 'user', text: 'Fix the export', toolUses: [] },
  { role: 'assistant', text: 'Reading it.', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/x.ts' }, text: 'const x = 1' }] },
]

// The world beneath the mod: a session at `tokens`; compactions, writes, logs recorded.
function world(on: On, tokens: number) {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = { compacts: 0, writes: [] as { path: string; text: string }[], logs: [] as string[], runs: [] as string[][] }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens }, rateLimits: [] } }) as never)
  on('session.id', () => ({ value: 'abcdef1234567890' }) as never)
  on('session.cwd', () => ({ value: '/home/test/proj' }) as never)
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('fs.write', (_$, e: any) => { seen.writes.push({ path: e.path, text: e.text }); return { value: undefined } as never })
  on('ui.log', (_$, e: any) => { seen.logs.push(e.text); return { value: undefined } as never })
  on('process.run', (_$, e: any) => { seen.runs.push(e.argv ?? e.command ?? e.args ?? e); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e: any) => ({ text: e.answer }) as never)
  on('session.messages', () => ({ value: MESSAGES }) as never)
  // busy: how many compactions to reject as if a turn were running.
  const state = { busy: 0 }
  on('session.compact', () => {
    if (state.busy > 0) { state.busy -= 1; throw new Error('a turn is running') }
    seen.compacts += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  return { clock, seen, state }
}

const endTurn = ($: any) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

test('parses token counts', () => {
  expect(parseTokens('250k')).toBe(250_000)
  expect(parseTokens('1.5m')).toBe(1_500_000)
  expect(parseTokens('300000')).toBe(300_000)
  expect(parseTokens('5k')).toBeUndefined()
  expect(parseTokens('lots')).toBeUndefined()
})

test('below 250k nothing compacts', async ($, on) => {
  const { clock, seen } = world(on, 240_000)
  await endTurn($)
  await clock.advance(5000)
  expect(seen.compacts).toBe(0)
})

test('past 250k it compacts after the turn', async ($, on) => {
  const { clock, seen } = world(on, 260_000)
  await endTurn($)
  expect(seen.compacts).toBe(0)
  await clock.advance(2000)
  expect(seen.compacts).toBe(1)
})

test('/autocompact off stops it; threshold changes it', async ($, on) => {
  const { clock, seen } = world(on, 260_000)
  await $.command.run({ command: 'autocompact', args: 'off' } as never)
  await endTurn($)
  await clock.advance(2000)
  expect(seen.compacts).toBe(0)
  await $.command.run({ command: 'autocompact', args: 'on' } as never)
  await $.command.run({ command: 'autocompact', args: 'threshold 300k' } as never)
  await endTurn($)
  await clock.advance(2000)
  expect(seen.compacts).toBe(0)
  const status = await $.command.run({ command: 'autocompact', args: 'status' } as never)
  expect(String((status as any).text)).toMatch(/^Auto-compact on, past 300k tokens/)
})

test('any compaction saves the transcript first', async ($, on) => {
  const { seen } = world(on, 260_000)
  await $.session.compact({ instructions: 'keep the plan', trigger: 'manual', messages: MESSAGES } as never)
  expect(seen.compacts).toBe(1)
  const save = seen.writes.find(w => w.path.includes('/compact-saves/'))
  expect(save?.path).toMatch(/^\/home\/test\/\.claude\/compact-saves\/.+_abcdef12_(manual|plugin)\.md$/)
  expect(save?.text).toMatch(/Fix the export/)
  expect(save?.text).toMatch(/Compact instructions: keep the plan/)
  expect(JSON.stringify(seen.runs)).toMatch(/mkdir.*-m.*700/)
  expect(JSON.stringify(seen.runs)).toMatch(/chmod.*600.*_manual\.md|chmod.*600.*_plugin\.md/)
})

test('secrets are redacted before saving', () => {
  const out = redact('key ghp_abcdefghijklmnop1234 and password: hunter2pass and AKIAABCDEFGHIJKLMNOP and Authorization: Bearer abc.def.ghijkl')
  expect(out).not.toMatch(/ghp_abcdefghijklmnop1234|hunter2pass|AKIAABCDEFGHIJKLMNOP|abc\.def\.ghijkl/)
  expect(out).toMatch(/password: \[redacted\]/)
  expect(redact('nothing secret here')).toBe('nothing secret here')
})

test('transcript renders messages and tool calls', () => {
  const md = transcript(MESSAGES as never, { sessionId: 's1', cwd: '/p', trigger: 'auto', tokens: 251_000, now: 0 })
  expect(md).toMatch(/Trigger: auto at 251k tokens/)
  expect(md).toMatch(/## 1\. user\n\nFix the export/)
  expect(md).toMatch(/\*\*Read\*\* `\{"file_path":"\/x.ts"\}`\n> const x = 1/)
})

test('its own compaction (past the threshold) saves the transcript first', async ($, on) => {
  const { clock, seen } = world(on, 260_000)
  await endTurn($)
  await clock.advance(2000)
  expect(seen.compacts).toBe(1)
  const save = seen.writes.find(w => w.path.includes('/compact-saves/'))
  expect(save?.path).toMatch(/_abcdef12_plugin\.md$/)
  expect(save?.text).toMatch(/Fix the export/)
})

test('/autocompact now saves and compacts', async ($, on) => {
  const { clock, seen } = world(on, 50_000)
  await $.command.run({ command: 'autocompact', args: 'now' } as never)
  await clock.advance(1000)
  expect(seen.compacts).toBe(1)
  expect(seen.writes.filter(w => w.path.includes('/compact-saves/')).length).toBe(1)
})

test('a compaction that meets a running turn runs after the next turn, without a stray save', async ($, on) => {
  const { clock, seen, state } = world(on, 50_000)
  state.busy = 1
  await $.command.run({ command: 'autocompact', args: 'now' } as never)
  await clock.advance(1000)
  expect(seen.compacts).toBe(0)
  expect(JSON.stringify(seen.runs)).toMatch(/"\/bin\/rm","-f",".*_plugin\.md"/)
  await endTurn($)
  await clock.advance(2000)
  expect(seen.compacts).toBe(1)
})

test('a retry that fails again is not retried forever', async ($, on) => {
  const { clock, seen, state } = world(on, 50_000)
  state.busy = 5
  await $.command.run({ command: 'autocompact', args: 'now' } as never)
  await clock.advance(1000)
  await endTurn($)
  await clock.advance(2000)
  await endTurn($)
  await clock.advance(2000)
  expect(state.busy).toBe(3)
  expect(seen.compacts).toBe(0)
})

test('/autocompact status shows how the last run went, including a pending retry', async ($, on) => {
  const { clock, state } = world(on, 50_000)
  state.busy = 1
  await $.command.run({ command: 'autocompact', args: 'now' } as never)
  await clock.advance(1000)
  let status = String(((await $.command.run({ command: 'autocompact', args: 'status' } as never)) as any).text)
  expect(status).toMatch(/Last run: .*compaction deferred until the next answer ends: ./)
  expect(status).toMatch(/Waiting to retry after the next answer/)
  await endTurn($)
  await clock.advance(2000)
  status = String(((await $.command.run({ command: 'autocompact', args: 'status' } as never)) as any).text)
  expect(status).toMatch(/Last run: .*compacted \(asked with \/autocompact now\), saved to \/home\/test\/\.claude\/compact-saves\/.+_plugin\.md\./)
  expect(status).not.toMatch(/Waiting to retry/)
})
