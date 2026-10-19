import type { SessionMessage } from 'claude-code'

export const DEFAULT_THRESHOLD = 250_000
export const MIN_THRESHOLD = 10_000

/** "250k", "1.2m", "250000" -> tokens; undefined when it is not a count. */
export function parseTokens(s: string): number | undefined {
  const m = s.trim().toLowerCase().replace(/[,_\s]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (!m) return undefined
  const n = Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
  return n >= MIN_THRESHOLD ? n : undefined
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}m` : `${Math.round(n / 1e3)}k`)

export const saveDir = (home: string, configDir?: string) => `${configDir || `${home}/.claude`}/compact-saves`

export const saveName = (now: number, sessionId: string, trigger: string) =>
  `${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${sessionId.slice(0, 8)}_${trigger}.md`

// Common credential shapes, replaced before anything reaches disk.
const SECRETS = [
  /\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{8,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /((?:password|passwd|passphrase|secret|token|api[ _-]?key|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',]{6,}/gi,
]

export const redact = (s: string) =>
  SECRETS.reduce((out, re) => out.replace(re, (m, lead) => (typeof lead === 'string' && /[:=]\s*["']?$/.test(lead) ? `${lead}[redacted]` : '[redacted]')), s)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s)

/** The transcript as markdown: every message's text, each tool call's input and a clipped result. */
export function transcript(
  messages: readonly SessionMessage[],
  meta: { sessionId: string; cwd: string; trigger: string; tokens?: number; now: number; instructions?: string },
): string {
  const head = [
    `# Pre-compaction save`,
    ``,
    `- Session: ${meta.sessionId}`,
    `- Folder: ${meta.cwd}`,
    `- Saved: ${new Date(meta.now).toISOString()}`,
    `- Trigger: ${meta.trigger}${meta.tokens !== undefined ? ` at ${fmtTokens(meta.tokens)} tokens` : ''}`,
    ...(meta.instructions ? [`- Compact instructions: ${meta.instructions}`] : []),
    `- Messages: ${messages.length}`,
    ``,
  ]
  const body = messages.flatMap((m, i) => {
    const out: string[] = []
    const text = m.text.trim()
    const results = m.toolResults ?? []
    if (m.role === 'user' && !text && results.length > 0) {
      for (const r of results) out.push(`> tool result${r.isError ? ' (error)' : ''}: ${clip(String(r.text ?? '').trim(), 2000)}`)
      return [...out, '']
    }
    out.push(`## ${i + 1}. ${m.role}`, '')
    if (text) out.push(text, '')
    for (const t of m.toolUses) {
      out.push(`**${t.tool}** \`${clip(JSON.stringify(t.input), 1500)}\``)
      if (t.text !== undefined) out.push(`> ${t.isError ? 'error: ' : ''}${clip(t.text.trim(), 2000)}`)
      out.push('')
    }
    return out
  })
  return redact([...head, ...body].join('\n'))
}
