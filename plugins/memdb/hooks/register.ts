import type { Engine, Register } from 'claude-code'

import { HELP, NOTE, PLUGIN, PREFLIGHT, TOOLS, commandArgs, preflightMessage } from './memdb'
import type { Args } from './memdb'

type Outcome = { ok: true; text: string } | { ok: false; text: string }

type Config = { python: string; dbPath: string }

// The python check passes once per python command and is then remembered; a failure is retried on the next call.
const checked = new Set<string>()

async function check($: Engine, python: string): Promise<string | undefined> {
  if (checked.has(python)) return undefined
  try {
    const r = await $.process.run([python, '-c', PREFLIGHT], { timeoutMs: 15_000 })
    if (r.exitCode !== 0) return preflightMessage(python, r.exitCode, r.stdout)
  } catch {
    return `memdb could not start "${python}": it is not installed or not on PATH. Install Python 3.8+ or set the "python" option of the memdb plugin.`
  }
  checked.add(python)
  return undefined
}

async function run($: Engine, cfg: Config, args: string[], stdin?: string): Promise<Outcome> {
  const problem = await check($, cfg.python)
  if (problem) return { ok: false, text: problem }
  try {
    const r = await $.process.run([cfg.python, `${$.plugin.root}/bin/memdb.py`, ...args], {
      ...(stdin !== undefined ? { stdin } : {}),
      ...(cfg.dbPath ? { env: { MEMDB_PATH: cfg.dbPath } } : {}),
      timeoutMs: 60_000,
    })
    const out = r.stdout.trim()
    const err = r.stderr.trim()
    if (r.exitCode !== 0) return { ok: false, text: `memdb failed (exit ${r.exitCode}): ${err || out || 'no output'}` }
    return { ok: true, text: out || err || 'Done.' }
  } catch (e) {
    return { ok: false, text: `memdb could not run: ${String(e)}` }
  }
}

// Runs one tool call: builds its argv, runs memdb.py, and answers with the output (or an error the model reads).
async function serve($: Engine, cfg: Config, name: string, e: unknown): Promise<{ result: string } | { deny: string }> {
  const t = TOOLS.find(x => x.name === name)!
  let built
  try {
    built = t.build(e as Args)
  } catch (err) {
    return { deny: `${name}: ${(err as Error).message}` }
  }
  const out = await run($, cfg, built.args, built.stdin)
  return out.ok ? { result: out.text } : { deny: out.text }
}

const failed = () => ({ deny: 'memdb: the tool failed unexpectedly.' })

export const register: Register = (on, options) => {
  const cfg: Config = {
    python: (typeof options.python === 'string' && options.python.trim()) || 'python3',
    dbPath: typeof options.dbPath === 'string' ? options.dbPath.trim() : '',
  }
  const promptNote = options.promptNote !== false

  on('session.start', async ($, e, next) => {
    for (const t of TOOLS) {
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
    }
    await $.command.register({
      name: 'memdb',
      description: 'Search the memory database (/memdb <words>), or: stats, list, get <name>, sync',
      argumentHint: '<words> | stats | list | get <name> | sync',
    })
    return next(e)
  })

  // One hook per tool, each with its literal name.
  on('tool.call', { tool: 'mcp__memdb__memdb_search' }, ($, e) => serve($, cfg, 'memdb_search', e)).catch(failed)
  on('tool.call', { tool: 'mcp__memdb__memdb_add' }, ($, e) => serve($, cfg, 'memdb_add', e)).catch(failed)
  on('tool.call', { tool: 'mcp__memdb__memdb_get' }, ($, e) => serve($, cfg, 'memdb_get', e)).catch(failed)
  on('tool.call', { tool: 'mcp__memdb__memdb_index' }, ($, e) => serve($, cfg, 'memdb_index', e)).catch(failed)
  on('tool.call', { tool: 'mcp__memdb__memdb_forget' }, ($, e) => serve($, cfg, 'memdb_forget', e)).catch(failed)

  on('command.run', { command: 'memdb' }, async ($, e) => {
    const args = commandArgs(e.args)
    if (args === 'help') return { text: HELP }
    return { text: (await run($, cfg, args)).text }
  })

  if (promptNote) {
    on('prompt.compose', async ($, e, next) => {
      const r = await next(e)
      return { sections: [...r.sections, { id: `${PLUGIN}:note`, text: NOTE, scope: 'session' as const }] }
    }).catch(($, e, next) => next(e))
  }
}
