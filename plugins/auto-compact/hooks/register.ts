import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import { DEFAULT_THRESHOLD, fmtTokens, parseTokens, saveDir, saveName, transcript } from './save'

// Set while this mod's own compaction is queued or running, so one turn asks once.
const compacting = atom({ plugin: 'auto-compact', key: 'compacting' } as const, false)
const lastSave = atom({ plugin: 'auto-compact', key: 'lastSave' } as const, '')

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

async function compactNow($: Engine, why: string) {
  await update($, compacting, () => true)
  try {
    const r = await $.session.compact({ instructions: 'Keep the current goal, decisions made, files changed and the next steps.' })
    if (r.skip !== undefined) $.ui.log(`[auto-compact] compaction skipped: ${r.skip}`)
    else $.ui.toast(`Compacted (${why}).`)
  } catch (err) {
    $.ui.log(`[auto-compact] compaction failed: ${String(err)}`)
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
    if ((await read($, compacting)) || !(await isEnabled($))) return done
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
    const [sessionId, cwd, now, use, dir] = await Promise.all([
      $.session.id(),
      $.session.cwd(),
      $.clock.now(),
      $.session.usage().catch(() => undefined),
      getSaveDir($),
    ])
    // Ahead-of-time compute overwrites one file per session; a real compaction gets its own.
    const name = e.trigger === 'precompute' ? `${sessionId}_precompute.md` : saveName(now, sessionId, e.trigger)
    const path = `${dir}/${name}`
    try {
      await $.fs.write(path, transcript(e.messages, { sessionId, cwd, trigger: e.trigger, tokens: use?.context.tokens, now, instructions: e.instructions }))
      if (e.trigger !== 'precompute') {
        await update($, lastSave, () => path)
        $.ui.log(`[auto-compact] saved ${e.messages.length} messages to ${path} before compacting`)
      }
    } catch (err) {
      $.ui.log(`[auto-compact] could not save before compacting: ${String(err)}`)
    }
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
      const [enabled, limit, use, saved, dir] = [await isEnabled($), await getThreshold($), await $.session.usage().catch(() => undefined), await read($, lastSave), await getSaveDir($)]
      const window = use?.context.window
      return {
        text: [
          `Auto-compact ${enabled ? 'on' : 'off'}, past ${fmtTokens(limit)} tokens.`,
          `This session: ${use?.context.tokens !== undefined ? fmtTokens(use.context.tokens) : 'no count yet'}${window ? ` of a ${fmtTokens(window)} window` : ''}.`,
          ...(window && window <= limit ? [`Note: this model's window is no larger than the threshold, so the built-in auto-compact fires first (the transcript is still saved).`] : []),
          `Saves go to ${dir}${saved ? `; last: ${saved}` : ''}.`,
        ].join('\n'),
      }
    }
    return { text: `Usage: ${USAGE}` }
  }).catch(($, e, next) => next(e))
}
