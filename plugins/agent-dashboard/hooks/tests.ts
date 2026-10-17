import type { Engine } from 'claude-code'

export const TEST_COMMAND =
  /\bxcodebuild\b[^|;&]*\btest(-without-building)?\b|\bswift test\b|\bxcrun xctest\b|\bpytest\b|\bpython3? -m (pytest|unittest)\b|\b(npm|pnpm|yarn) (run )?test\b|\bgo test\b|\bcargo test\b|\bplugin test\b|\bpio test\b|\btests?\/run\.sh\b|\brun[-_]?tests?\b/
// Background Bash output lands in <tmp root>/<project key>/<session id>/tasks/<task id>.output,
// the tmp root being claude-<uid> under /private/tmp (macOS) or /tmp.
export const POLL_MS = 15_000
export const POLL_LIMIT = 4 * 60 * 4 // four hours of polls

// Reads a test log's own verdict lines; undefined when the run has not finished.
export function judge(out: string): { verdict: 'passed' | 'failed'; summary: string } | undefined {
  const pick = (re: RegExp) => [...out.matchAll(re)].pop()
  const xc = pick(/Executed (\d+) tests?, with (\d+) failures?/g)
  const st = pick(/Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed)/g)
  const py = pick(/=+ (?:(\d+) failed, )?(\d+) passed|=+ (\d+) failed/g)
  const count = xc
    ? `${xc[1]} tests, ${xc[2]} failed`
    : st
      ? `${st[1]} tests ${st[2]}`
      : py
        ? (py[0].match(/[\d]+ (passed|failed)(, [\d]+ (passed|failed))?/)?.[0] ?? '')
        : ''
  if (/\*\* TEST (FAILED|EXECUTE FAILED|BUILD FAILED) \*\*|✘ Test run with|\bFAILED \(failures|=+ \d+ failed/.test(out) || (xc && xc[2] !== '0')) {
    return { verdict: 'failed', summary: count || 'failed' }
  }
  if (/\*\* TEST (SUCCEEDED|EXECUTE SUCCEEDED) \*\*|✔ Test run with|Test run with .* passed|=+ \d+ passed|\bOK\b\s*$|Executed \d+ tests?, with 0 failures/m.test(out)) {
    return { verdict: 'passed', summary: count || 'passed' }
  }
  return undefined
}

export async function findTaskOutput($: Engine, taskId: string): Promise<string | undefined> {
  const sid = await $.session.id()
  const uid = String((await $.process.run(['/usr/bin/id', '-u']).catch(() => undefined))?.stdout ?? '').trim()
  if (!/^\d+$/.test(uid)) return undefined
  for (const root of [`/private/tmp/claude-${uid}`, `/tmp/claude-${uid}`]) {
    const dirs = await $.fs.list(root).catch(() => [])
    for (const dir of dirs) {
      const path = `${root}/${dir.name}/${sid}/tasks/${taskId}.output`
      if (dir.kind === 'dir' && (await $.fs.exists(path))) return path
    }
  }
  return undefined
}

// Long builds: any xcodebuild that builds (not -version, -list, -showBuildSettings and the like), swift build/test, and every test command.
const XCODEBUILD_QUERY = /\bxcodebuild\b[^|;&]*\s-(version|list|show\w*|help|usage|license|checkFirstLaunchStatus|runFirstLaunch)\b/
export const LONG_BUILD = /\bxcodebuild\b|\bswift (build|test)\b/

export const BUILD_NOTE = `[dashboard] That was a long build or test run in the foreground. Next time run long builds and tests in the background (Bash run_in_background: true) so the session stays responsive.`

export const isLongForeground = (command: string, background?: boolean) =>
  background !== true && ((LONG_BUILD.test(command) && !XCODEBUILD_QUERY.test(command)) || TEST_COMMAND.test(command))
