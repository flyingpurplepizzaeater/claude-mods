import type { Register } from 'claude-code'
import { findHandBack, nudge } from './check'

// Tools that are already a proper way of asking the owner.
const ASK_TOOLS = /^(AskUserQuestion|ExitPlanMode|mcp__ccd_session__start_session)$/

export const register: Register = on => {
  // Whether the main loop asked properly during the current turn.
  let askedWithOptions = false

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) askedWithOptions = false
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) {
      const args = e as unknown as { ask?: unknown }
      if (ASK_TOOLS.test(e.tool)) askedWithOptions = true
      if (e.tool === 'mcp__ccd_turn__wrap_up' && typeof args.ask === 'string' && args.ask.trim()) askedWithOptions = true
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    // Never block twice in a row: a second stop always goes through.
    if (result.block || e.stop_hook_active || askedWithOptions) return result
    const quote = findHandBack(e.last_assistant_message)
    if (!quote) return result
    $.ui.status(`keep-going: nudged past "${quote.slice(0, 40)}"`)
    return { ...result, block: nudge(quote) }
  }).catch(($, e, next) => next(e))
}
