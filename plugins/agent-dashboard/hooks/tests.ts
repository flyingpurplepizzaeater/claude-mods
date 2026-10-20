export const TEST_COMMAND =
  /\bxcodebuild\b[^|;&]*\btest(-without-building)?\b|\bswift test\b|\bxcrun xctest\b|\bpytest\b|\bpython3? -m (pytest|unittest)\b|\b(npm|pnpm|yarn) (run )?test\b|\bgo test\b|\bcargo test\b|\bplugin test\b|\bpio test\b|\btests?\/run\.sh\b|\brun[-_]?tests?\b/
// Background Bash output lands in <tmp root>/<project key>/<session id>/tasks/<task id>.output,
// the tmp root being claude-<uid> under /private/tmp (macOS) or /tmp.
export const POLL_MS = 15_000
export const POLL_LIMIT = 4 * 60 * 4 // four hours of polls

// Reads a test log's own verdict lines; undefined when the run has not finished.
// The summary is always plain counts, "12 passed" or "2 of 14 failed", whatever the runner.
export function judge(out: string): { verdict: 'passed' | 'failed'; summary: string } | undefined {
  const last = (re: RegExp) => [...out.matchAll(re)].pop()
  const n = (m: RegExpMatchArray | undefined, i: number) => (m?.[i] ? Number(m[i]) : 0)
  const verdict = (passed: number, failed: number, failedAnyway = false) =>
    failed > 0 || failedAnyway
      ? { verdict: 'failed' as const, summary: failed > 0 ? `${failed} of ${passed + failed} failed` : 'failed' }
      : { verdict: 'passed' as const, summary: `${passed} passed` }

  // xcodebuild / XCTest
  const xc = last(/Executed (\d+) tests?, with (\d+) failures?/g)
  if (xc) return verdict(n(xc, 1) - n(xc, 2), n(xc, 2), /\*\* TEST (FAILED|EXECUTE FAILED|BUILD FAILED) \*\*/.test(out))
  // swift-testing
  const st = last(/Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed)(?: after [\d.]+ seconds with (\d+) issues?)?/g)
  if (st) return st[2] === 'passed' ? verdict(n(st, 1), 0) : verdict(Math.max(0, n(st, 1) - n(st, 3)), n(st, 3) || 0, true)
  // bun test / claude plugin test: " 13 pass" and " 0 fail" on lines of their own
  const bunPass = last(/^\s*(\d+) pass\s*$/gm)
  const bunFail = last(/^\s*(\d+) fail\s*$/gm)
  if (bunPass || bunFail) return verdict(n(bunPass, 1), n(bunFail, 1))
  // jest / vitest
  const js = last(/^\s*Tests:?\s+(?:(\d+) failed[, |]+)?(?:(\d+) passed)?/gm)
  if (js && (js[1] || js[2])) return verdict(n(js, 2), n(js, 1))
  // cargo
  const cargo = last(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/g)
  if (cargo) return verdict(n(cargo, 2), n(cargo, 3), cargo[1] === 'FAILED')
  // pytest summary line
  const py = last(/^=+ (.*\b(?:passed|failed|error)\b.*) =+$/gm)
  if (py) {
    const failed = n(py[1].match(/(\d+) failed/) ?? undefined, 1) + n(py[1].match(/(\d+) errors?/) ?? undefined, 1)
    return verdict(n(py[1].match(/(\d+) passed/) ?? undefined, 1), failed)
  }
  // unittest
  const ran = last(/^Ran (\d+) tests? in /gm)
  if (ran) {
    const bad = out.match(/^FAILED \((?:failures=(\d+))?(?:, )?(?:errors=(\d+))?/m)
    if (bad) return verdict(n(ran, 1) - n(bad, 1) - n(bad, 2), n(bad, 1) + n(bad, 2), true)
    if (/^OK\b/m.test(out)) return verdict(n(ran, 1), 0)
  }
  // go test
  if (/^(--- FAIL|FAIL\s)/m.test(out)) return verdict(0, 0, true)
  if (/^ok\s+\S+/m.test(out)) return { verdict: 'passed', summary: 'passed' }
  if (/\*\* TEST (FAILED|EXECUTE FAILED|BUILD FAILED) \*\*/.test(out)) return verdict(0, 0, true)
  if (/\*\* TEST (SUCCEEDED|EXECUTE SUCCEEDED) \*\*/.test(out)) return { verdict: 'passed', summary: 'passed' }
  return undefined
}

// A short name for a test command: the test step itself, with paths cut to their last part,
// redirects and output filters dropped, and the folder it ran in when it starts with cd.
export function testLabel(command: string): string {
  const steps = command.split(/\s*(?:&&|\|\||;|\n)\s*/)
  const step = steps.find(s => TEST_COMMAND.test(s)) ?? steps[steps.length - 1] ?? command
  const dir = steps.find(s => /^cd\s/.test(s))?.replace(/^cd\s+/, '').replace(/["']/g, '').replace(/\/+$/, '')
  const short = step
    .split('|')[0]
    .replace(/\s+\d?>&?\s*\S+/g, '')
    .replace(/^(\w+=\S*\s+)+/, '')
    .replace(/(?:~|\.{0,2})?\/(?:[^\s/]+\/)+([^\s/]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const where = dir && step !== steps[0] ? ` in ${dir.split('/').pop()}` : ''
  const label = `${short}${where}`
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

// Long builds: any xcodebuild that builds (not -version, -list, -showBuildSettings and the like), swift build/test, and every test command.
const XCODEBUILD_QUERY = /\bxcodebuild\b[^|;&]*\s-(version|list|show\w*|help|usage|license|checkFirstLaunchStatus|runFirstLaunch)\b/
export const LONG_BUILD = /\bxcodebuild\b|\bswift (build|test)\b/

export const BUILD_NOTE = `[dashboard] That was a long build or test run in the foreground. Next time run long builds and tests in the background (Bash run_in_background: true) so the session stays responsive.`

export const isLongForeground = (command: string, background?: boolean) =>
  background !== true && ((LONG_BUILD.test(command) && !XCODEBUILD_QUERY.test(command)) || TEST_COMMAND.test(command))
