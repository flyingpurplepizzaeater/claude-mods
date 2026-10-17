import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import {
  DEFAULT_THRESHOLD,
  HANDOVER_PROMPT,
  PROJECT_FILE,
  SESSION_SERVER,
  continuePrompt,
  effectiveThreshold,
  fmtTokens,
  goalOf,
  handoverDir,
  handoverFile,
  handoverName,
  logFile,
  parseTokens,
} from './handover'

// The handover this session already wrote, so the automatic one (when on) fires once per session.
const handedOver = atom({ plugin: 'auto-handover', key: 'handedOver' } as const, '')
// Main-loop turns this session has finished, counted here (prompts from the app or other sessions included).
const turnsSeen = atom({ plugin: 'auto-handover', key: 'turnsSeen' } as const, 0)

const USAGE = '/handover [now | status | on | off | threshold <200k>]'

// First that is set: AUTO_HANDOVER_THRESHOLD, the project's .claude/auto-handover.json
// ({ "threshold": "120k" }), /handover threshold, then 200k.
const getThreshold = async ($: Engine) => {
  const fromEnv = parseTokens((await $.env.get('AUTO_HANDOVER_THRESHOLD')) ?? '')
  if (fromEnv !== undefined) return fromEnv
  const projectFile = `${await $.session.root()}/${PROJECT_FILE}`
  if (await $.fs.exists(projectFile).catch(() => false)) {
    const raw = await $.fs.read(projectFile).catch(() => '')
    const fromProject = parseTokens(String(safeJson(raw)?.threshold ?? ''))
    if (fromProject !== undefined) return fromProject
  }
  const v = await $.store.get('threshold')
  return typeof v === 'number' && v >= 1000 ? v : DEFAULT_THRESHOLD
}
// Off unless /handover on: built-in auto-compact (CLAUDE_CODE_AUTO_COMPACT_WINDOW) covers the automatic case.
const isEnabled = async ($: Engine) => (await $.store.get('enabled')) === true

type Outcome = { ok: boolean; text: string }

const safeJson = (raw: string): { threshold?: unknown } | undefined => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// Where handover notes go: <config dir>/handovers.
const getHandoverDir = async ($: Engine) =>
  handoverDir(
    (await $.env.get('HOME').catch(() => undefined)) ?? '',
    await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined),
  )

// One line per step in ~/.claude/handovers/auto-handover.log, newest last, last 200 kept.
async function logLine($: Engine, text: string) {
  const at = new Date(await $.clock.now()).toISOString()
  const log = logFile(await getHandoverDir($))
  const old = await $.fs.read(log).catch(() => '')
  const lines = `${old}${at} ${text.replace(/\s+/g, ' ').slice(0, 600)}\n`.split('\n').filter(Boolean).slice(-200)
  await $.fs.write(log, `${lines.join('\n')}\n`).catch(() => undefined)
}

// The session server can wait on the app; give up after a minute so the fallback still runs.
const withTimeout = <T,>($: Engine, p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, $.clock.sleep(ms).then(() => fallback)])

// Writes the handover file, then starts a fresh desktop session on it; where there is no
// desktop app, leaves the continue prompt in the box to send after /clear.
async function handover($: Engine, why: string): Promise<Outcome> {
  const r = await $.model.fork({ prompt: HANDOVER_PROMPT })
  if (!r.isAnswered) return { ok: false, text: `Handover failed: could not write the note (${r.reason}).` }
  const note = r.text.trim()

  const [sessionId, cwd, now, use] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.clock.now(),
    $.session.usage().catch(() => undefined),
  ])
  const path = `${await getHandoverDir($)}/${handoverName(now, sessionId)}`
  await $.fs.write(path, handoverFile({ note, sessionId, cwd, tokens: use?.context.tokens, now, why }))
  await update($, handedOver, () => path)
  await logLine($, `${sessionId} wrote ${path} (${why})`)

  const prompt = continuePrompt(path, cwd)
  // The app starts a session outright only on the person's own words; a turn another session or an
  // event drove is refused, and then the same session is proposed as a card to start with one click.
  const startSession = (initiation: 'user_asked' | 'own_initiative') =>
    withTimeout(
      $,
      $.mcp
        .call(SESSION_SERVER, 'start_session', {
          initiation,
          context: 'fresh',
          title: `Continue: ${goalOf(note)}`,
          prompt,
          background: `Handover from session ${sessionId} (${why}). The full note is in ${path}:\n\n${note}`,
          use_worktree: false,
        })
        .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] })),
      60_000,
      { isError: true, content: [{ type: 'text', text: 'no answer from the session server in 60s' }] },
    )
  const textOf = (r: { content: readonly unknown[] }) =>
    r.content.map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join(' ').trim()

  const started = await startSession('user_asked')
  const said = textOf(started)
  await logLine($, `${sessionId} start_session ${started.isError ? 'failed' : 'ok'}: ${said}`)
  if (!started.isError) {
    $.ui.toast('Handed over to a new session: carry on there.')
    return { ok: true, text: `Handover written to ${path} and a new session started from it. Carry on there; this one can be archived.${said ? `\n${said.slice(0, 300)}` : ''}` }
  }

  const proposed = await startSession('own_initiative')
  const proposedSaid = textOf(proposed)
  await logLine($, `${sessionId} propose ${proposed.isError ? 'failed' : 'ok'}: ${proposedSaid}`)
  if (!proposed.isError) {
    $.ui.toast('Handover written: start the "Continue" session card to carry on fresh.')
    return { ok: true, text: `Handover written to ${path}. The app would not start a session from this turn, so a "Continue: …" session card is waiting: start it to carry on fresh.` }
  }

  const filled = await $.prompt.fill({ text: prompt }).catch(() => ({ isFilled: false }))
  $.ui.toast('Handover written: run /clear, then send the prompt in the box.')
  return {
    ok: true,
    text: `Handover written to ${path}. No new session could be started here (${said.slice(0, 200) || 'no desktop app'}).${
      filled.isFilled ? ' The continue prompt is in the prompt box: run /clear, then send it.' : ` Run /clear, then send:\n\n${prompt}`
    }`,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'handover', description: 'Write a handover file and continue in a fresh session', argumentHint: '[now|status|on|off|threshold 200k]' })
      .catch(() => undefined)
    return next(e)
  })

  // At the end of each main-loop turn: past the threshold, hand over once, after the turn has let go.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    const seen = (await read($, turnsSeen)) + 1
    await update($, turnsSeen, () => seen)
    if ((await read($, handedOver)) || !(await isEnabled($))) return done
    const use = await $.session.usage().catch(() => undefined)
    const tokens = use?.context.tokens
    const limit = effectiveThreshold(await getThreshold($), use?.context.window)
    if (tokens === undefined || tokens < limit) return done
    // Never on a session's first turn, so a session that just took over cannot hand straight on.
    if (seen < 2) return done

    await update($, handedOver, () => 'pending')
    $.clock.after(1500, async () => {
      const out = await handover($, `context past ${fmtTokens(limit)}`).catch((err: unknown) => ({ ok: false, text: `Handover failed: ${String(err)}` }))
      if (!out.ok) await update($, handedOver, () => '')
      await logLine($, out.text)
      $.ui.log(`[auto-handover] ${out.text}`)
    })
    return done
  }).catch(($, e, next) => next(e)) // never break a turn over a handover glitch

  on('command.run', { command: 'handover' }, async ($, e) => {
    const [verb = 'now', ...rest] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (verb === 'now') return { text: (await handover($, 'asked with /handover')).text }
    if (verb === 'on' || verb === 'off') {
      await $.store.set('enabled', verb === 'on')
      if (verb === 'on') await update($, handedOver, () => '')
      return { text: `Automatic handover ${verb === 'on' ? 'on' : 'off'}.` }
    }
    if (verb === 'threshold') {
      const n = parseTokens(rest.join(''))
      if (n === undefined) return { text: `Give a token count, e.g. /handover threshold 200k (at least 1k).` }
      await $.store.set('threshold', n)
      return { text: `Automatic handover now fires past ${fmtTokens(n)} tokens.` }
    }
    if (verb === 'status') {
      const [on_, limit, use, done] = [await isEnabled($), await getThreshold($), await $.session.usage().catch(() => undefined), await read($, handedOver)]
      const eff = effectiveThreshold(limit, use?.context.window)
      return {
        text: `Automatic handover ${on_ ? 'on' : 'off'}; fires past ${fmtTokens(eff)} tokens${eff < limit ? ` (80% of the ${fmtTokens(use!.context.window)} window; set ${fmtTokens(limit)})` : ''}. This session: ${
          use?.context.tokens !== undefined ? `${fmtTokens(use.context.tokens)} tokens` : 'no count yet'
        }${done ? `, already handed over (${done})` : ''}. Files in ${await getHandoverDir($)}.`,
      }
    }
    return { text: `Usage: ${USAGE}` }
  }).catch(($, e, next) => next(e))
}
