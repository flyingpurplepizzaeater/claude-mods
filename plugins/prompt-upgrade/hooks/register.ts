import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

// Used when the session has no conversation to fork yet.
const FALLBACK_MODEL = 'sonnet'

const last = atom({ plugin: 'prompt-upgrade', key: 'last' } as const, null)

const RULES = `Rewrite the rough prompt below into a better prompt for a coding agent working on this machine.
- Keep the person's intent exactly. Never add goals, features or constraints they did not ask for.
- Make it specific: name the files, project, tools or behaviour it refers to when the conversation makes them clear.
- Say what "done" looks like, and how to check it, when that follows from the request.
- Keep it short: a few sentences or a short list. Plain words, no headings, no preamble.
- If something essential is ambiguous, keep it open as a question at the end instead of guessing.
Reply with the rewritten prompt only, nothing before or after it.`

async function upgrade($: Engine, rough: string): Promise<string | undefined> {
  const ask = `${RULES}\n\nRough prompt:\n${rough}`
  // A fork reads the session's own transcript (from the prompt cache), so it knows the project at hand.
  const forked = await $.model.fork({ prompt: ask })
  if (forked.isAnswered) return forked.text.trim()

  const cwd = await $.session.cwd()
  const plain = await $.model.complete({
    model: FALLBACK_MODEL,
    system: `The agent works in ${cwd}.`,
    prompt: ask,
    maxTokens: 800,
    timeoutMs: 45_000,
  })

  return plain.isAnswered ? plain.text.trim() : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'improve',
      description: 'Rewrite a rough prompt into a clear one for review; "/improve send" submits the last one',
      argumentHint: '<rough prompt> | send',
    })

    return next(e)
  })

  on('command.run', { command: 'improve' }, async ($, e) => {
    const args = e.args.trim()

    if (args === 'send') {
      const text = await read($, last)
      if (!text) return { text: 'Nothing to send yet: run /improve <rough prompt> first.' }
      await update($, last, () => null)
      // A command can't submit while it holds the turn: send just after it returns.
      $.clock.after(0, () => {
        void $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast('prompt-upgrade: could not send the prompt'))
      })

      return { text: 'Sending the upgraded prompt.' }
    }

    if (args === '') return { text: 'Usage: /improve <rough prompt>   (then review it, or /improve send)' }

    const better = await upgrade($, args)
    if (!better) return { text: 'Could not upgrade the prompt this time (the model call failed). Your original is unchanged.' }
    await update($, last, () => better)

    const filled = await $.prompt.fill({ text: better }).catch(() => ({ isFilled: false }))

    return {
      text: filled.isFilled
        ? 'Upgraded prompt is in the prompt box: edit it and press Enter, or run /improve send.'
        : `Upgraded prompt:\n\n${better}\n\nRun /improve send to send it as is, or copy and edit it.`,
    }
  }).catch(($, e, next) => next(e))
}
