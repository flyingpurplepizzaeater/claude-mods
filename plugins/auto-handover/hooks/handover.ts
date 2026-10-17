// Pure helpers for the auto-handover mod.

export const DEFAULT_THRESHOLD = 200_000
// Handover notes live in <config dir>/handovers: CLAUDE_CONFIG_DIR when set, else ~/.claude.
export const handoverDir = (home: string, configDir?: string) =>
  `${(configDir || `${home.replace(/\/+$/, '')}/.claude`).replace(/\/+$/, '')}/handovers`
export const logFile = (dir: string) => `${dir}/auto-handover.log`
// Per-project override of the threshold, relative to the session's project root.
export const PROJECT_FILE = '.claude/auto-handover.json'
// The desktop app's own session server, the one behind mcp__ccd_session__start_session.
export const SESSION_SERVER = 'ccd_session'

// Asked of a fork of the session (its cached transcript), so it costs one short answer.
export const HANDOVER_PROMPT = `Write a handover note so a brand-new Claude Code session, with none of this conversation, can pick up exactly where this one leaves off. Plain markdown, under 350 words, these headings in order:
## Goal (one or two lines)
## Current state (what works, what is half-done, anything left running or uncommitted)
## Done
## Next steps (numbered, the very next action first)
## Key files and paths (full paths)
## Decisions and gotchas (including anything the user asked for or ruled out)
Only facts from this session; no preamble, no sign-off, no tool calls. Reply with the note alone.`

// '200k', '1.5m', '50000' → tokens; undefined when it does not parse.
export const parseTokens = (s: string): number | undefined => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(s)
  if (!m) return undefined
  const n = Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1)
  return Number.isFinite(n) && n >= 1000 ? Math.round(n) : undefined
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}m` : `${Math.round(n / 1000)}k`)

// The threshold that applies: the set one, but never past 80% of the window, so it fires before auto-compaction would.
export const effectiveThreshold = (threshold: number, window?: number) =>
  window && window > 0 ? Math.min(threshold, Math.floor(window * 0.8)) : threshold

// '2026-10-17-1432-ab12cd34.md'
export const handoverName = (now: number, sessionId: string) => {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${sessionId.slice(0, 8)}.md`
}

export const handoverFile = (o: { note: string; sessionId: string; cwd: string; tokens?: number; now: number; why: string }) =>
  `# Handover\n\n- From session: ${o.sessionId}\n- Project folder: ${o.cwd}\n- Written: ${new Date(o.now).toISOString()} (${o.why}${o.tokens ? `, context ${fmtTokens(o.tokens)} tokens` : ''})\n\n${o.note.trim()}\n`

// The goal line of the note, for the new session's title.
export const goalOf = (note: string) => {
  const lines = note.split('\n').map(l => l.trim())
  const at = lines.findIndex(l => /^#*\s*\**goal\**/i.test(l))
  const after = at < 0 ? lines : lines.slice(at + 1)
  const inline = at >= 0 ? lines[at].replace(/^#*\s*\**goal\**:?\**\s*/i, '').trim() : ''
  const goal = inline || after.find(l => l && !l.startsWith('#')) || 'previous session'
  const clean = goal.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean
}

export const continuePrompt = (path: string, cwd: string) =>
  `Continue the work of a previous session that was handed over to keep context small. First read the handover file ${path} (it is outside the project, read it by that absolute path). The project folder is ${cwd}. Then carry on from its "Next steps", without redoing what is listed as done; check the current state of files before editing, since the note may lag slightly. Rebuild your task list from the note.`
