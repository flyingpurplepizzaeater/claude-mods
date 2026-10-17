// Context size warnings: yellow past 150k tokens, red past 400k.
export const CONTEXT_WARN = 150_000
export const CONTEXT_ALARM = 400_000

export const CONTEXT_ADVICE = 'consider /compact, or start a fresh session for a new task'

// 0 under 150k (or unknown), 1 past 150k, 2 past 400k.
export const contextLevel = (tokens?: number) =>
  tokens === undefined ? 0 : tokens >= CONTEXT_ALARM ? 2 : tokens >= CONTEXT_WARN ? 1 : 0
