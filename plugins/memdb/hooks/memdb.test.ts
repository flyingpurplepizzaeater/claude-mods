import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Call = { argv: readonly string[]; stdin?: string; env?: Record<string, string> }

// The world beneath the mod: process.run is recorded and answered by `answer`.
function world(on: On, answer: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr?: string } | 'missing' = () => ({ exitCode: 0, stdout: 'ok' })) {
  const calls: Call[] = []
  on('process.run', (_$, e: any) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env })
    const r = answer(e.argv)
    if (r === 'missing') throw new Error('spawn python3 ENOENT')
    return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '' } } as never
  })
  return calls
}

const scriptCalls = (calls: Call[]) => calls.filter(c => c.argv[1]?.endsWith('/bin/memdb.py'))
const FACTS = { model: 'test-model', promptModel: 'test-model', surfaces: [], tools: [], outputStyle: null, traits: [] } as never
const TOOL = (n: string) => `mcp__memdb__${n}`

test('registers its tools and the /memdb command at session start', async ($, on) => {
  world(on)
  const registered: string[] = []
  const commands: string[] = []
  on('session.start', (_$, e: any) => ({ cwd: e.cwd }) as never)
  on('tool.register', (_$, e: any) => { registered.push(e.name); return { value: { tool: `mcp__memdb__${e.name}` } } as never })
  on('command.register', (_$, e: any) => { commands.push(e.name); return { value: { command: e.name } } as never })
  await $.session.start({ cwd: '/Users/test/projects' } as never)
  expect(registered).toEqual(['memdb_search', 'memdb_add', 'memdb_get', 'memdb_index', 'memdb_forget'])
  expect(commands).toEqual(['memdb'])
})

test('memdb_search passes argv with no shell, options first and the query after --', async ($, on) => {
  const calls = world(on, argv => ({ exitCode: 0, stdout: argv.includes('search') ? '● note:port (project)\n  the «port» is 5433' : '' }))
  const out: any = await $.tool.call({ tool: TOOL('memdb_search'), query: 'staging port', kind: 'note', project: 'api', limit: 3, full: true } as never)
  const run = scriptCalls(calls)[0]!
  expect(run.argv[0]).toBe('python3')
  expect(run.argv.slice(2)).toEqual(['search', '-k', 'note', '-p', 'api', '-n', '3', '-f', '--', 'staging port'])
  expect(JSON.stringify(out.result ?? out.text)).toMatch(/the «port» is 5433/)
})

test('memdb_add sends the body on stdin and defaults the type to project', async ($, on) => {
  const calls = world(on, argv => ({ exitCode: 0, stdout: argv.includes('add') ? 'Saved note:staging-port' : '' }))
  await $.tool.call({ tool: TOOL('memdb_add'), name: 'staging-port', body: 'It is 5433.\nNot 5432.', desc: 'DB port' } as never)
  const run = scriptCalls(calls)[0]!
  expect(run.argv.slice(2)).toEqual(['add', '-t', 'project', '-d', 'DB port', '--', 'staging-port', '-'])
  expect(run.stdin).toBe('It is 5433.\nNot 5432.')
})

test('memdb_get and memdb_index build their argv', async ($, on) => {
  const calls = world(on)
  await $.tool.call({ tool: TOOL('memdb_get'), name: 'staging-port' } as never)
  await $.tool.call({ tool: TOOL('memdb_index'), paths: ['/work/plan.md', '/work/notes.md'], project: 'api' } as never)
  const [get, index] = scriptCalls(calls)
  expect(get!.argv.slice(2)).toEqual(['get', '--', 'staging-port'])
  expect(index!.argv.slice(2)).toEqual(['index', '-p', 'api', '--', '/work/plan.md', '/work/notes.md'])
})

test('a failing script returns its stderr as the error', async ($, on) => {
  world(on, argv => (argv.includes('get') ? { exitCode: 1, stdout: '', stderr: "Nothing named 'zzz'." } : { exitCode: 0, stdout: '' }))
  const out: any = await $.tool.call({ tool: TOOL('memdb_get'), name: 'zzz' } as never)
  expect(JSON.stringify(out)).toMatch(/Nothing named 'zzz'/)
  expect(JSON.stringify(out)).toMatch(/exit 1/)
})

test('a missing required argument is refused without running python', async ($, on) => {
  const calls = world(on)
  const out: any = await $.tool.call({ tool: TOOL('memdb_search') } as never)
  expect(JSON.stringify(out)).toMatch(/Missing required argument/)
  expect(calls.length).toBe(0)
})

test('missing python gives a clear message instead of crashing', async ($, on) => {
  const calls = world(on, () => 'missing')
  const out: any = await $.tool.call({ tool: TOOL('memdb_search'), query: 'x' } as never)
  expect(JSON.stringify(out)).toMatch(/could not start/)
  expect(scriptCalls(calls).length).toBe(0)
})

test('python older than 3.8 and python without FTS5 are named', async ($, on) => {
  world(on, argv => (argv[1] === '-c' ? { exitCode: 3, stdout: '3.6.9' } : { exitCode: 0, stdout: '' }))
  const old: any = await $.tool.call({ tool: TOOL('memdb_get'), name: 'a' } as never)
  expect(JSON.stringify(old)).toMatch(/Python 3\.8 or newer, but python3 is 3\.6\.9/)
})

test('python without FTS5 is named', async ($, on) => {
  world(on, argv => (argv[1] === '-c' ? { exitCode: 4, stdout: '3.31.1' } : { exitCode: 0, stdout: '' }))
  const out: any = await $.tool.call({ tool: TOOL('memdb_get'), name: 'a' } as never)
  expect(JSON.stringify(out)).toMatch(/FTS5/)
})

test('the python check runs once per session', async ($, on) => {
  const calls = world(on)
  await $.tool.call({ tool: TOOL('memdb_get'), name: 'a' } as never)
  await $.tool.call({ tool: TOOL('memdb_get'), name: 'b' } as never)
  expect(calls.filter(c => c.argv[1] === '-c').length).toBe(1)
})

test('options choose the python command and the database path', { options: { python: 'python3.12', dbPath: '/data/mem.db' } }, async ($, on) => {
  const calls = world(on)
  await $.tool.call({ tool: TOOL('memdb_get'), name: 'a' } as never)
  const run = scriptCalls(calls)[0]!
  expect(run.argv[0]).toBe('python3.12')
  expect(run.env).toEqual({ MEMDB_PATH: '/data/mem.db' })
})

test('/memdb searches, shows stats and prints help', async ($, on) => {
  const calls = world(on, argv => ({ exitCode: 0, stdout: `ran ${argv.slice(2).join(' ')}` }))
  const search: any = await $.command.run({ command: 'memdb', args: 'staging port' } as never)
  const stats: any = await $.command.run({ command: 'memdb', args: 'stats' } as never)
  const help: any = await $.command.run({ command: 'memdb', args: '' } as never)
  expect(search.text).toBe('ran search -- staging port')
  expect(stats.text).toBe('ran stats')
  expect(help.text).toMatch(/\/memdb stats/)
  expect(scriptCalls(calls).length).toBe(2)
})

test('the system prompt gets a short memdb note, unless switched off', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as never)
  const ids = (await $.prompt.compose(FACTS)).sections.map(s => s.id)
  expect(ids).toContain('memdb:note')
})

test('promptNote off leaves the system prompt alone', { options: { promptNote: false } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as never)
  const ids = (await $.prompt.compose(FACTS)).sections.map(s => s.id)
  expect(ids).not.toContain('memdb:note')
})
