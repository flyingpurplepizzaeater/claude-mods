import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { SessionRow, SubagentRow, TestRun, UsageRow } from '../types'
import { nextTodos } from './tasks'
import { BUILD_NOTE, POLL_LIMIT, POLL_MS, TEST_COMMAND, findTaskOutput, isLongForeground, judge } from './tests'
import { CONTEXT_ADVICE, contextLevel } from './context'

// Every running Claude Code process writes a record in <config dir>/sessions (pid, name, status, cwd).
// The config dir is CLAUDE_CONFIG_DIR when set, else ~/.claude.
async function locations($: Engine) {
  const home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? '').replace(/\/+$/, '') || `${home}/.claude`
  return { home, sessionsDir: `${configDir}/sessions` }
}
// The desktop app shows one pane at a time, so everything lives in this one pane, stacked.
const PANE = 'agent-dashboard'
const TITLE = 'Dashboard'
const REFRESH_MS = 5000

// Every value the pane draws, kept in this one plugin's state.
const sessions = atom({ plugin: 'agent-dashboard', key: 'sessions' } as const, [])
const subagents = atom({ plugin: 'agent-dashboard', key: 'subagents' } as const, [])
const usage = atom({ plugin: 'agent-dashboard', key: 'usage' } as const, { limits: [] } as UsageRow)
const todos = atom({ plugin: 'agent-dashboard', key: 'todos' } as const, [])
const testLast = atom({ plugin: 'agent-dashboard', key: 'testLast' } as const, null)
const testHistory = atom({ plugin: 'agent-dashboard', key: 'testHistory' } as const, [])
// The highest context threshold already toasted this session (0 none, 1 = 150k, 2 = 400k).
const contextWarned = atom({ plugin: 'agent-dashboard', key: 'contextWarned' } as const, 0)

// Mid-turn requests: what the model is told when one arrives while it works.
const QUEUE_NOTE = `[dashboard] The user sent the message above while you were in the middle of a task.
- If it corrects, redirects or stops what you are doing right now, act on it now.
- Otherwise it is a new request: do NOT switch to it yet. Add it as a new pending step at the END of your task list (update_plan, TodoWrite or TaskCreate, whichever this session uses), reply with one short line saying it is queued, finish the current step and the steps before it, then do it in order.`
// New requests: plan multi-part or long work in the task list before starting, as Cowork does.
const PLAN_NOTE = `[dashboard] If this request contains several tasks, or is long or complicated (more than about three steps), first write its steps to your task list (update_plan, TodoWrite or TaskCreate, whichever this session uses), one step per task, then work through them in order and keep the list current as each finishes. A simple one-step request needs no list.`

// Who counts as the person typing: the composer, the desktop app (sdk), or Remote Control.
const PERSON = new Set(['composer', 'sdk', 'bridge'])
const NOW_PREFIX = /^!now\b\s*/i

const LIMIT_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }

// '[#####-----] 48%' at ten cells.
const bar = (pct: number) => {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${Math.round(pct)}%`
}

const resetIn = (now: number, at?: string) => {
  if (!at) return ''
  const mins = Math.round((Date.parse(at) - now) / 60000)
  if (!Number.isFinite(mins) || mins <= 0) return ''
  return mins < 60 ? ` · resets in ${mins}m` : mins < 48 * 60 ? ` · resets in ${Math.floor(mins / 60)}h ${mins % 60}m` : ` · resets in ${Math.round(mins / 1440)}d`
}

const ago = (now: number, then: number) => {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
const mark = (v: TestRun['verdict']) => (v === 'passed' ? '✓' : v === 'failed' ? '✗' : v === 'running' ? '…' : '?')

async function refresh($: Engine) {
  const u = await $.session.usage().catch(() => undefined)
  if (u) {
    await update($, usage, () => ({
      limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      contextPercent: u.context.percent,
      contextTokens: u.context.tokens,
    }))
    const level = contextLevel(u.context.tokens)
    if (level > (await read($, contextWarned))) {
      await update($, contextWarned, () => level)
      $.ui.toast(`Context past ${level === 2 ? '400k' : '150k'} tokens: ${CONTEXT_ADVICE}`)
    }
  }
  const selfId = await $.session.id()
  const { home, sessionsDir } = await locations($)
  const entries = await $.fs.list(sessionsDir)
  const rows: SessionRow[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const rec = JSON.parse(await $.fs.read(`${sessionsDir}/${entry.name}`))
      rows.push({
        pid: rec.pid,
        name: rec.name ?? rec.sessionId ?? `pid ${rec.pid}`,
        status: rec.status ?? 'unknown',
        cwd: home ? String(rec.cwd ?? '').replace(home, '~') : String(rec.cwd ?? ''),
        sinceMs: rec.statusUpdatedAt ?? rec.updatedAt ?? rec.startedAt ?? 0,
        isSelf: rec.sessionId === selfId,
      })
    } catch {
      // A record being rewritten mid-read; the next refresh picks it up.
    }
  }
  // Records can outlive a crashed process: keep only pids that are still running.
  if (rows.length > 0) {
    const ps = await $.process.run(['/bin/ps', '-o', 'pid=', '-p', rows.map(r => r.pid).join(',')])
    const alive = new Set(String(ps.stdout ?? '').split(/\s+/).filter(Boolean).map(Number))
    await update($, sessions, () => rows.filter(r => alive.has(r.pid)))
  } else {
    await update($, sessions, () => [])
  }
}

async function recordTest($: Engine, run: TestRun, toast: boolean) {
  await update($, testLast, () => run)
  if (run.verdict !== 'running') await update($, testHistory, list => [...list, run].slice(-8))
  $.ui.status(`tests ${mark(run.verdict)} ${run.summary} · ${clock(run.at)}`)
  if (toast && run.verdict === 'failed') $.ui.toast(`Tests failed: ${run.summary}`)
}

export const register: Register = (on, options) => {
  // Behaviour switches (plugin.json userConfig): the two prompt notes default on, the build reminder off.
  const planNote = options.planNote !== false
  const queueMessages = options.queueMessages !== false
  const buildReminder = options.buildReminder === true

  on('session.start', async ($, e, next) => {
    // Open first: session start has a short budget, and the refresh (files, ps, usage) can outlast it.
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(0, () => {
      void refresh($).catch(() => undefined)
    })
    $.clock.every(REFRESH_MS, () => {
      void refresh($).catch(() => undefined)
    })
    // /agents is Claude Code's own command, so this is /dashboard. A refused name must never block the pane.
    await $.command
      .register({ name: 'dashboard', description: 'Show the dashboard: usage, tasks, tests, sessions and subagents' })
      .catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async $ => {
    await refresh($).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: opened.isPlaced ? 'Dashboard opened.' : `Dashboard waiting: ${opened.reason}` }
  }).catch(($, e, next) => next(e))

  // Subagents: one row per Agent call, running until it returns.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const row: SubagentRow = {
      id: e.tool_use_id,
      description: e.description ?? 'subagent',
      type: e.subagent_type ?? 'general-purpose',
      state: 'running',
      startedAt: await $.clock.now(),
    }
    await update($, subagents, list => [...list, row].slice(-30))
    const ran = await next(e)
    const endedAt = await $.clock.now()
    await update($, subagents, list =>
      ran.deny !== undefined
        ? list.filter(one => one.id !== row.id)
        : list.map(one =>
            one.id === row.id ? { ...one, state: ran.isError ? 'failed' : 'done', endedAt } : one,
          ),
    )

    return ran
  }).catch(($, e, next) => next(e)) // never block a subagent over a dashboard glitch

  // Tests: verdict of any test command, following background runs to their end.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !TEST_COMMAND.test(e.command)) return ran

    const command = e.command.slice(0, 80)
    const result = ran.result
    if (result.backgroundTaskId) {
      await recordTest($, { command, verdict: 'running', summary: 'running in background', at: await $.clock.now() }, false)
      const path = await findTaskOutput($, result.backgroundTaskId)
      if (path === undefined) return ran
      let polls = 0
      const timer = $.clock.every(POLL_MS, () => {
        void (async () => {
          polls += 1
          const verdict = judge(await $.fs.read(path))
          if (verdict || polls > POLL_LIMIT) {
            timer.cancel()
            await recordTest($, { command, verdict: verdict?.verdict ?? 'unknown', summary: verdict?.summary ?? 'no verdict found', at: await $.clock.now() }, true)
          }
        })().catch(() => undefined)
      })
      return ran
    }

    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const verdict = judge(out) ?? (ran.isError ? { verdict: 'failed' as const, summary: 'exited with an error' } : { verdict: 'unknown' as const, summary: 'finished, no verdict found' })
    await recordTest($, { command, verdict: verdict.verdict, summary: verdict.summary, at: await $.clock.now() }, true)

    return ran
  }).catch(($, e, next) => next(e)) // never block a command over the dashboard

  // Optional (buildReminder): long builds and tests run in the foreground get a reminder to use the background; the command itself is untouched.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!buildReminder || ran.deny !== undefined || !isLongForeground(e.command, e.run_in_background)) return ran

    return { ...ran, context: [...(ran.context ?? []), BUILD_NOTE] }
  }).catch(($, e, next) => next(e)) // never block a command over a reminder

  // Tasks: follow whichever task-list tool the session uses.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const args = e as unknown as Record<string, unknown>
    const list = nextTodos(await read($, todos), e.tool, args, ran.result)
    if (list !== undefined) await update($, todos, () => list)

    return ran
  }).catch(($, e, next) => next(e)) // never block a tool over the dashboard

  // New requests get the plan-first note; requests typed while a turn runs go to the end of the task list instead of derailing it.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = PERSON.has(e.origin.kind) && !e.command && !e.isMeta && e.text.trim() !== ''
    if (!isPerson) return next(e)
    if (e.turnId === undefined) return planNote ? next({ ...e, context: [...(e.context ?? []), PLAN_NOTE] }) : next(e)
    if (!queueMessages) return next(e)
    if (NOW_PREFIX.test(e.text)) return next({ ...e, text: e.text.replace(NOW_PREFIX, '') })

    const firstLine = e.text.trim().split('\n')[0].slice(0, 80)
    await update($, todos, list => [...list, { id: `q${list.length}-${firstLine.length}`, text: `⏳ ${firstLine}`, status: 'pending' }])
    $.ui.toast(`Queued after the current task: ${firstLine.slice(0, 50)}`)

    return next({ ...e, context: [...(e.context ?? []), QUEUE_NOTE] })
  }).catch(($, e, next) => next(e)) // never lose a message over the queue

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const use = await read($, usage)
    const level = contextLevel(use.contextTokens)
    const tasks = await read($, todos)
    const done = tasks.filter(t => t.status === 'completed').length
    const current = await read($, testLast)
    const runs = [...(await read($, testHistory))].reverse().slice(0, 3)
    const ss = await read($, sessions)
    const subs = await read($, subagents)
    const running = subs.filter(s => s.state === 'running')
    const recent = subs.filter(s => s.state !== 'running').slice(-3)

    return (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        {use.limits.length === 0 && <Text dimColor>No limit readings yet (they arrive with the next reply).</Text>}
        {use.limits.map(l => (
          <Text key={`u${l.kind}`} color={l.percentUsed >= 90 ? 'red' : l.percentUsed >= 75 ? 'yellow' : undefined}>
            {(LIMIT_LABELS[l.kind] ?? l.kind).padEnd(8)} {bar(l.percentUsed)}
            {resetIn(now, l.resetsAt)}
          </Text>
        ))}
        {use.contextPercent !== undefined && (
          <Text dimColor>
            {'Context'.padEnd(8)} {bar(use.contextPercent)} (this session{use.contextTokens !== undefined ? `, ${Math.round(use.contextTokens / 1000)}k tokens` : ''})
          </Text>
        )}
        {level > 0 && (
          <Text color={level === 2 ? 'red' : 'yellow'} bold>
            ⚠ Context past {level === 2 ? '400k' : '150k'} tokens: {CONTEXT_ADVICE}
          </Text>
        )}

        <Text> </Text>
        <Text bold>Tasks{tasks.length > 0 ? ` (${done}/${tasks.length} done)` : ''}</Text>
        {tasks.length === 0 && <Text dimColor>No tasks in this session yet.</Text>}
        {tasks.map(t => (
          <Text
            key={`t${t.id}`}
            color={t.status === 'in_progress' ? 'yellow' : undefined}
            dimColor={t.status === 'completed'}
            strikethrough={t.status === 'completed'}
          >
            {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'} {t.text}
          </Text>
        ))}

        <Text> </Text>
        <Text bold>Tests</Text>
        {current === null && <Text dimColor>No test runs in this session yet.</Text>}
        {current?.verdict === 'running' && (
          <Text color="yellow">… running in background since {clock(current.at)} · {current.command}</Text>
        )}
        {runs.map((run, i) => (
          <Text key={`r${run.at}-${i}`} color={run.verdict === 'passed' ? 'green' : run.verdict === 'failed' ? 'red' : 'yellow'} dimColor={i > 0}>
            {mark(run.verdict)} {run.summary} · {clock(run.at)} · {run.command}
          </Text>
        ))}

        <Text> </Text>
        <Text bold>Sessions ({ss.length})</Text>
        {ss.length === 0 && <Text dimColor>None running.</Text>}
        {ss.map(s => (
          <Text key={`s${s.pid}`} color={s.status === 'busy' ? 'green' : undefined} dimColor={s.status !== 'busy'}>
            {s.status === 'busy' ? '● ' : '○ '}
            {s.name}
            {s.isSelf ? ' (this)' : ''} · {s.status} {ago(now, s.sinceMs)} · {s.cwd}
          </Text>
        ))}

        <Text> </Text>
        <Text bold>Subagents here ({running.length} running)</Text>
        {subs.length === 0 && <Text dimColor>None yet.</Text>}
        {running.map(s => (
          <Text key={s.id} color="yellow">
            ▶ {s.description} · {s.type} · {ago(now, s.startedAt)}
          </Text>
        ))}
        {recent.map(s => (
          <Text key={s.id} dimColor color={s.state === 'failed' ? 'red' : undefined}>
            {s.state === 'failed' ? '✗' : '✓'} {s.description} · {s.type} · took {ago(s.endedAt ?? now, s.startedAt)}
          </Text>
        ))}
      </Box>
    )
  })
}
