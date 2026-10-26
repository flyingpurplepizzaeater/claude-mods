// Phrases that hand the next move back to the user in plain prose.
const ASKING = [
  /\b(do you )?want me to\b/i,
  /\bwould you like (me )?to\b/i,
  /\b(should|shall|can|may) I\b[^.!\n]*\?/i,
  /\blet me know\b/i,
  /\b(ok|okay|good|fine) to (proceed|continue|go ahead)\b/i,
  /\b(ready|happy) to (proceed|continue)\b[^.!\n]*\?/i,
  /\bsay the word\b/i,
  /\bif you('d| would) like,? I\b/i,
  /\b(next|from here),? (I can|I could)\b/i,
]

// Only the end of the message counts: that is where a turn hands back.
const TAIL = 500

export function findHandBack(text: string | undefined): string | undefined {
  if (!text) return undefined
  const tail = text.slice(-TAIL)
  for (const re of ASKING) {
    const m = tail.match(re)
    if (m) {
      const start = tail.lastIndexOf('\n', m.index ?? 0) + 1
      const end = tail.indexOf('\n', m.index ?? 0)
      return tail.slice(start, end < 0 ? undefined : end).trim().slice(0, 160)
    }
  }
  return undefined
}

export function nudge(quote: string): string {
  return [
    `You ended the turn by handing the next move back in plain text: "${quote}"`,
    'The owner wants you to keep building instead of stopping. Do one of these now:',
    '1. If there is any work left that you can do without the owner, do it, and route around anything blocked (skip it, stub it, note it) instead of stopping.',
    '2. If you are truly blocked on a decision only the owner can make, ask it with AskUserQuestion: 2-4 concrete options, your recommendation first and marked "(Recommended)". In the desktop app, wrap_up\'s ask with buttons also counts.',
    'Confirmations the safety rules or CLAUDE.md require (push, PR, sending, deleting, purchases) still need asking, but ask them as options, not prose.',
    'If the work really is finished and nothing is pending, end with the summary and no question.',
  ].join('\n')
}
