// Pure helpers for the memdb mod: tool definitions, argv building, python preflight.

export type Args = Record<string, unknown>
export type Run = { argv: string[]; stdin?: string }

export const PLUGIN = 'memdb'

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const opt = (flag: string, v: unknown): string[] => (str(v).trim() === '' ? [] : [flag, str(v)])

/** A required string argument, or a message saying which is missing. */
function need(a: Args, key: string): string {
  const v = str(a[key]).trim()
  if (!v) throw new Error(`Missing required argument "${key}".`)
  return v
}

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** The memdb.py arguments (after the script path), plus stdin when the body goes there. */
  build: (a: Args) => { args: string[]; stdin?: string }
}

const KINDS = ['memory', 'note', 'doc']
const TYPES = ['user', 'feedback', 'project', 'reference']

export const TOOLS: ToolDef[] = [
  {
    name: 'memdb_search',
    description:
      'Ranked full-text search over the memory database: Claude memory files, saved notes and indexed docs. Use it before rereading a long notes file or when you need a fact you may have stored. Returns matching entries with snippets (set full to get whole bodies).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for; every word must match (prefix ok), with an any-word fallback.' },
        kind: { type: 'string', enum: KINDS, description: 'Only this kind of entry.' },
        project: { type: 'string', description: 'Only entries whose project contains this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 8).' },
        full: { type: 'boolean', description: 'Return full bodies instead of snippets.' },
      },
      required: ['query'],
    },
    build: a => ({
      args: [
        'search',
        ...opt('-k', a.kind),
        ...opt('-p', a.project),
        ...opt('-n', a.limit),
        ...(a.full === true ? ['-f'] : []),
        '--',
        need(a, 'query'),
      ],
    }),
  },
  {
    name: 'memdb_add',
    description:
      'Save or replace a note in the memory database (names are unique: adding an existing name replaces it). Use it for niche facts that are too small or too many for the always-loaded memory file.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short slug, e.g. "staging-db-port".' },
        body: { type: 'string', description: 'The note text.' },
        type: { type: 'string', enum: TYPES, description: 'user | feedback | project | reference (default project).' },
        project: { type: 'string', description: 'Project the note belongs to.' },
        desc: { type: 'string', description: 'One-line description, searched with higher weight than the body.' },
      },
      required: ['name', 'body'],
    },
    build: a => ({
      args: ['add', '-t', str(a.type).trim() || 'project', ...opt('-d', a.desc), ...opt('-p', a.project), '--', need(a, 'name'), '-'],
      stdin: need(a, 'body'),
    }),
  },
  {
    name: 'memdb_get',
    description: 'Show full entries by name (exact or substring match), up to 5.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Entry name or part of it.' } },
      required: ['name'],
    },
    build: a => ({ args: ['get', '--', need(a, 'name')] }),
  },
  {
    name: 'memdb_index',
    description:
      'Index markdown files (handoff notes, plans, long docs) into the database, split by heading, so memdb_search can find parts of them. Indexed files are re-synced automatically when they change.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Markdown file paths.' },
        project: { type: 'string', description: 'Project label for these docs.' },
      },
      required: ['paths'],
    },
    build: a => {
      const paths = Array.isArray(a.paths) ? a.paths.map(str).filter(s => s.trim() !== '') : []
      if (paths.length === 0) throw new Error('Missing required argument "paths".')
      return { args: ['index', ...opt('-p', a.project), '--', ...paths] }
    },
  },
  {
    name: 'memdb_forget',
    description: 'Delete a note that was saved with memdb_add. Memory files are removed by deleting the .md file instead.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact note name.' } },
      required: ['name'],
    },
    build: a => ({ args: ['forget', '--', need(a, 'name')] }),
  },
]

/** Checked once per session before the first call: Python 3.8+, with SQLite FTS5. */
export const PREFLIGHT = [
  'import sys',
  'if sys.version_info < (3, 8):',
  '    sys.stdout.write(sys.version.split()[0]); sys.exit(3)',
  'import sqlite3',
  'try:',
  '    sqlite3.connect(":memory:").execute("create virtual table t using fts5(a)")',
  'except Exception:',
  '    sys.stdout.write(sqlite3.sqlite_version); sys.exit(4)',
].join('\n')

export function preflightMessage(python: string, exitCode: number, stdout: string): string {
  if (exitCode === 3) return `memdb needs Python 3.8 or newer, but ${python} is ${stdout.trim() || 'older'}. Install a newer Python or set the "python" option of the memdb plugin.`
  if (exitCode === 4) return `memdb needs SQLite with FTS5, which this Python's sqlite3 (${stdout.trim() || 'unknown version'}) lacks. Use a Python built with FTS5 (python.org or Homebrew builds have it) via the "python" option.`
  return `memdb could not run ${python} (exit ${exitCode}). Install Python 3.8+ or set the "python" option of the memdb plugin.`
}

export const NOTE = `[memdb] A searchable memory database is available through the tools memdb_search, memdb_add, memdb_get and memdb_index (mcp__memdb__*). Search it before rereading long notes or memory files, and store niche facts that do not belong in the always-loaded memory with memdb_add.`

export const HELP = `/memdb <words>        search memories, notes and indexed docs
/memdb stats          counts and database size
/memdb list           list memories and notes
/memdb get <name>     show an entry in full
/memdb sync           re-sync memory files now
Tools for Claude: memdb_search, memdb_add, memdb_get, memdb_index, memdb_forget`

/** What a /memdb command line means, as memdb.py arguments. */
export function commandArgs(raw: string): string[] | 'help' {
  const text = raw.trim()
  if (text === '' || text === 'help') return 'help'
  const [verb = '', ...rest] = text.split(/\s+/)
  const tail = rest.join(' ')
  if (rest.length === 0 && (verb === 'stats' || verb === 'list' || verb === 'sync')) return [verb]
  if (verb === 'get' && tail) return ['get', '--', tail]
  return ['search', '--', text]
}
