import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

function host(on: On) {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/Users/test/projects' }))
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? '/Users/test' : undefined }) as never)
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return ran
}

const XCODE = '/Applications/Xcode-beta.app/Contents/Developer'

describe('build commands', () => {
  test('a build is wrapped and trimmed, with the full log kept under the config dir', async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'cd ~/projects/MyApp && xcodebuild test -scheme MyApp' })
    const cmd = ran[0]!
    expect(cmd).toContain('xcodebuild test -scheme MyApp')
    expect(cmd).toContain('/bin/xctrim.py')
    expect(cmd).toContain('/Users/test/.claude/build-trimmer/logs')
    expect(cmd).toContain('(exit $__trim_rc)')
    expect(cmd).not.toContain('DEVELOPER_DIR')
  })
  test('no developer dir is set unless the option asks for it', async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild build -scheme MyApp' })
    expect(ran[0]).toContain('xctrim')
    expect(ran[0]).not.toContain('export DEVELOPER_DIR')
  })
  test('developerDir applies to every build when no path match is set', { options: { developerDir: XCODE } }, async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild build -scheme MyApp' })
    expect(ran[0]).toContain(`export DEVELOPER_DIR='${XCODE}'`)
  })
  test('developerDirPathMatch limits it to matching commands or folders', { options: { developerDir: XCODE, developerDirPathMatch: '/MyApp' } }, async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'cd ~/projects/MyApp && xcodebuild build' })
    await $.tool.call({ tool: 'Bash', command: 'cd ~/projects/Other && xcodebuild build' })
    expect(ran[0]).toContain(`export DEVELOPER_DIR='${XCODE}'`)
    expect(ran[1]).toContain('xctrim')
    expect(ran[1]).not.toContain('export DEVELOPER_DIR')
  })
  test('an explicit DEVELOPER_DIR in the command is kept', { options: { developerDir: XCODE } }, async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild build' })
    expect(ran[0]).not.toContain('export DEVELOPER_DIR')
    expect(ran[0]).toContain('xctrim')
  })
  test('swift test is wrapped; scripts only once listed in extraBuildScripts', async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'swift test --package-path Core' })
    await $.tool.call({ tool: 'Bash', command: './scripts/ci.sh' })
    expect(ran[0]).toContain('xctrim')
    expect(ran[1]).toBe('./scripts/ci.sh')
  })
  test('other commands and opt-outs are left alone', async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild -version' })
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild build # no-trim' })
    expect(ran).toEqual(['git status', 'xcodebuild -version', 'xcodebuild build # no-trim'])
  })
})

describe('options', () => {
  test('extraBuildScripts wraps the named scripts', { options: { extraBuildScripts: 'ci.sh, run-tests.sh' } }, async ($, on) => {
    const ran = host(on)
    await $.tool.call({ tool: 'Bash', command: './scripts/ci.sh' })
    await $.tool.call({ tool: 'Bash', command: 'cd scripts && ./run-tests.sh' })
    await $.tool.call({ tool: 'Bash', command: './scripts/other.sh' })
    expect(ran[0]).toContain('xctrim')
    expect(ran[1]).toContain('xctrim')
    expect(ran[2]).toBe('./scripts/other.sh')
  })
})
