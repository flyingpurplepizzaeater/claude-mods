import { atom, read, update } from 'claude-code'
import type { Engine, Register, SessionMessage } from 'claude-code'

import { DEFAULT_THRESHOLD, fmtTokens, parseTokens, saveDir, saveName, transcript } from './save'

// Set while this mod's own compaction is queued or running, so one turn asks once.
const compacting = atom({ plugin: 'auto-compact', key: 'compacting' } as const, false)
const lastSave = atom({ plugin: 'auto-compact', key: 'lastSave' } as const, '')
// A compaction that met a running turn: tried again when the main loop's next turn ends.
const pending = atom({ plugin: 'auto-compact', key: 'pending' } as const, '')
// What the last compaction this mod started came to, for /autocompact status.
const lastResult = atom({ plugin: 'auto-compact', key: 'lastResult' } as const, '')
// When this mod last saved ahead of a /compact it ran itself, so that compaction's hook does not save twice.
const selfSavedAt = atom({ plugin: 'auto-compact', key: 'selfSavedAt' } as const, 0)
const SELF_SAVE_WINDOW_MS = 10 * 60_000

// ui.log reaches only the debug log in the desktop app: outcomes go to a toast and to status as well.
async function report($: Engine, text: string) {
  $.ui.log(`[auto-compact] ${text}`)
  $.ui.toast(`auto-compact: ${text}`)
  const at = new Date(await $.clock.now()).toTimeString().slice(0, 8)
  await update($, lastResult, () => `${at} ${text}`)
}

const USAGE = '/autocompact [status | on | off | threshold <250k> | now]'

// AUTO_COMPACT_THRESHOLD, then /autocompact threshold, then 250k.
async function getThreshold($: Engine) {
  const fromEnv = parseTokens((await $.env.get('AUTO_COMPACT_THRESHOLD')) ?? '')
  if (fromEnv !== undefined) return fromEnv
  const v = await $.store.get('threshold')
  return typeof v === 'number' && v >= 1000 ? v : DEFAULT_THRESHOLD
}
const isEnabled = async ($: Engine) => (await $.store.get('enabled')) !== false

const getSaveDir = async ($: Engine) =>
  saveDir((await $.env.get('HOME').catch(() => undefined)) ?? '', await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))

const INSTRUCTIONS = 'Keep the current goal, decisions made, files changed and the next steps.'

// Writes the conversation to compact-saves, owner-only. A failure is logged, never thrown.
async function save($: Engine, messages: readonly SessionMessage[], trigger: string, instructions?: string): Promise<string | undefined> {
  const [sessionId, cwd, now, use, dir] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.clock.now(),
    $.session.usage().catch(() => undefined),
    getSaveDir($),
  ])
  // Ahead-of-time compute overwrites one file per session; a real compaction gets its own.
  const name = trigger === 'precompute' ? `${sessionId}_precompute.md` : saveName(now, sessionId, trigger)
  const path = `${dir}/${name}`
  try {
    // Owner-only: the folder 700 before the file lands, the file 600 after.
    await $.process.run(['/bin/mkdir', '-p', '-m', '700', dir])
    await $.process.run(['/bin/chmod', '700', dir])
    await $.fs.write(path, transcript(messages, { sessionId, cwd, trigger, tokens: use?.context.tokens, now, instructions }))
    await $.process.run(['/bin/chmod', '600', path])
    if (trigger !== 'precompute') {
      await update($, lastSave, () => path)
      $.ui.log(`[auto-compact] saved ${messages.length} messages to ${path} before compacting`)
    }
    return path
  } catch (err) {
    $.ui.log(`[auto-compact] could not save before compacting: ${String(err)}`)
    return undefined
  }
}

// $.session.compact skips this plugin's own session.compact hook, so the save happens here first.
async function compactNow($: Engine, why: string, retry = false) {
  await update($, compacting, () => true)
  let saved: string | undefined
  const before = await read($, lastSave)
  try {
    const messages = await $.session.messages().catch(() => [] as SessionMessage[])
    if (messages.length) saved = await save($, messages, 'plugin', INSTRUCTIONS)
    // The desktop app and other SDK hosts have no $.session.compact, and it rejects while a turn runs:
    // either way /compact does it, queued by the engine until the session is idle.
    const r = await $.session.compact({ instructions: INSTRUCTIONS }).catch(async () => {
      const at = saved ? await $.clock.now() : 0
      await update($, selfSavedAt, () => at)
      await $.command.run({ command: 'compact', args: INSTRUCTIONS })
      return { skip: undefined }
    })
    await update($, pending, () => '')
    if (r.skip !== undefined) await report($, `compaction skipped: ${r.skip}`)
    else await report($, `compacted (${why})${saved ? `, saved to ${saved}` : ', but the transcript could not be saved'}.`)
  } catch (err) {
    // Rejected while a turn runs: drop the save it never compacted, try again once when the next turn ends.
    if (saved) {
      await $.process.run(['/bin/rm', '-f', saved]).catch(() => undefined)
      await update($, lastSave, () => before)
      await update($, selfSavedAt, () => 0)
    }
    await update($, pending, () => (retry ? '' : why))
    await report($, `compaction ${retry ? 'failed' : 'deferred until the next answer ends'}: ${String(err)}`)
  } finally {
    await update($, compacting, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'autocompact', description: 'Auto-compact past a token threshold (250k), saving the transcript first', argumentHint: '[status|on|off|threshold 250k|now]' })
      .catch(() => undefined)
    await update($, compacting, () => false)
    return next(e)
  })

  // After each main-loop answer: past the threshold, compact once the turn has let go.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    if (await read($, compacting)) return done
    const deferred = await read($, pending)
    if (deferred) {
      await update($, compacting, () => true)
      $.clock.after(1500, () => compactNow($, deferred, true))
      return done
    }
    if (!(await isEnabled($))) return done
    const tokens = (await $.session.usage().catch(() => undefined))?.context.tokens
    const limit = await getThreshold($)
    if (tokens === undefined || tokens < limit) return done
    await update($, compacting, () => true)
    $.clock.after(1500, () => compactNow($, `context ${fmtTokens(tokens)} past ${fmtTokens(limit)}`))
    return done
  }).catch(($, e, next) => next(e))

  // Before any compaction of the main conversation (/compact, built-in auto, this mod): save it whole.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || !e.messages?.length) return next(e)
    const selfSaved = await read($, selfSavedAt)
    if (e.trigger !== 'precompute' && selfSaved && (await $.clock.now()) - selfSaved < SELF_SAVE_WINDOW_MS) {
      await update($, selfSavedAt, () => 0) // this mod's own /compact: saved already
      return next(e)
    }
    await save($, e.messages, e.trigger, e.instructions)
    return next(e)
  }).catch(($, e, next) => next(e)) // a failed save never blocks the compaction

  on('command.run', { command: 'autocompact' }, async ($, e) => {
    const [verb = 'status', ...rest] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (verb === 'on' || verb === 'off') {
      await $.store.set('enabled', verb === 'on')
      return { text: `Auto-compact ${verb}. Transcripts are still saved before every compaction.` }
    }
    if (verb === 'threshold') {
      const n = parseTokens(rest.join(''))
      if (n === undefined) return { text: 'Give a token count, e.g. /autocompact threshold 250k (at least 10k).' }
      await $.store.set('threshold', n)
      return { text: `Auto-compact now fires past ${fmtTokens(n)} tokens.` }
    }
    if (verb === 'now') {
      $.clock.after(500, () => compactNow($, 'asked with /autocompact now'))
      return { text: 'Saving the transcript and compacting…' }
    }
    if (verb === 'status') {
      const [enabled, limit, use, saved, dir, last, waiting] = [await isEnabled($), await getThreshold($), await $.session.usage().catch(() => undefined), await read($, lastSave), await getSaveDir($), await read($, lastResult), await read($, pending)]
      const window = use?.context.window
      return {
        text: [
          `Auto-compact ${enabled ? 'on' : 'off'}, past ${fmtTokens(limit)} tokens.`,
          `This session: ${use?.context.tokens !== undefined ? fmtTokens(use.context.tokens) : 'no count yet'}${window ? ` of a ${fmtTokens(window)} window` : ''}.`,
          ...(window && window <= limit ? [`Note: this model's window is no larger than the threshold, so the built-in auto-compact fires first (the transcript is still saved).`] : []),
          `Saves go to ${dir}${saved ? `; last: ${saved}` : ''}.`,
          ...(last ? [`Last run: ${last}`] : []),
          ...(waiting ? [`Waiting to retry after the next answer (${waiting}).`] : []),
        ].join('\n'),
      }
    }
    return { text: `Usage: ${USAGE}` }
  }).catch(($, e, next) => next(e))
}
