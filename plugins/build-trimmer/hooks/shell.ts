// A small shell splitter: enough to find the commands a Bash call runs,
// not a full shell parser. Quotes are honoured; $(...) and backticks are not.

export type Segment = { argv: string[]; cwd?: string }

const WRAPPERS = new Set(['env', 'time', 'nohup', 'caffeinate', 'xcrun', 'command', 'exec', 'sudo'])
const SHELLS = new Set(['bash', 'sh', 'zsh'])

function tokenize(cmd: string): string[][] {
  const groups: string[][] = [[]]
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (hasWord) groups[groups.length - 1]!.push(word)
    word = ''
    hasWord = false
  }
  const endGroup = () => {
    endWord()
    if (groups[groups.length - 1]!.length > 0) groups.push([])
  }

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < cmd.length) {
      if (cmd[i + 1] === '\n') i++
      else {
        word += cmd[++i]
        hasWord = true
      }
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '>' || c === '<') {
      // a redirection is a word of its own: an fd before it, the operator, an &fd after it (2>&1)
      if (hasWord && !/^\d+$/.test(word)) endWord()
      word += c
      hasWord = true
      if (cmd[i + 1] === c) word += cmd[++i]
      if (cmd[i + 1] === '&') {
        word += cmd[++i]
        while (/[\d-]/.test(cmd[i + 1] ?? '')) word += cmd[++i]
      }
      endWord()
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endGroup()
    } else if (c === '#' && !hasWord) {
      while (i < cmd.length && cmd[i] !== '\n') i++
      endGroup()
    } else {
      word += c
      hasWord = true
    }
  }
  endGroup()
  return groups.filter(g => g.length > 0)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const REDIRECT = /^\d*(>>?|<<?)(&[\d-]*)?$/

/** The words of a command without its redirections (`2>&1`, `> out.log`, `<<'EOF'`). */
function dropRedirects(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!REDIRECT.test(w)) out.push(w)
    else if (!w.includes('&')) i++ // its target is the next word
  }
  return out
}

function unwrap(argv: string[]): string[] {
  let i = 0
  for (;;) {
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++
    const head = argv[i]
    if (head === undefined || !WRAPPERS.has(basename(head))) break
    i++
    while (i < argv.length && argv[i]!.startsWith('-')) i++
  }
  return argv.slice(i)
}

/** The commands a Bash call runs, each with the directory a preceding `cd` set. */
export function segments(cmd: string, depth = 0): Segment[] {
  const out: Segment[] = []
  let cwd: string | undefined
  for (const raw of tokenize(cmd)) {
    const argv = unwrap(dropRedirects(raw))
    const head = argv[0]
    if (head === undefined) continue
    if (head === 'cd' || head === 'pushd') {
      const dir = argv[1]
      if (dir !== undefined) cwd = /^[/~]/.test(dir) || cwd === undefined ? dir : `${cwd}/${dir}`
      continue
    }
    const shellArg = argv.indexOf('-c')
    if (SHELLS.has(basename(head)) && shellArg > 0 && argv[shellArg + 1] !== undefined && depth < 3) {
      for (const inner of segments(argv[shellArg + 1]!, depth + 1)) {
        out.push({ argv: inner.argv, cwd: inner.cwd ?? cwd })
      }
      continue
    }
    out.push({ argv: [basename(head), ...argv.slice(1)], cwd })
  }
  return out
}

export function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
}

const XCODEBUILD_INFO = new Set([
  '-version', '-showsdks', '-list', '-showBuildSettings', '-showdestinations',
  '-help', '-usage', '-checkFirstLaunchStatus', '-showTestPlans', '-license',
])

/** True when the segment runs a real xcodebuild (a build, test, archive...). */
export function isXcodebuild(seg: Segment): boolean {
  return seg.argv[0] === 'xcodebuild' && !seg.argv.some(a => XCODEBUILD_INFO.has(a))
}

/** Any command that builds or tests: xcodebuild, swift build/test, or a script named in the `extraBuildScripts` option. */
export function isBuild(seg: Segment, extraScripts: readonly string[] = []): boolean {
  const [head = '', sub] = seg.argv
  return (
    isXcodebuild(seg) ||
    (head === 'swift' && (sub === 'build' || sub === 'test')) ||
    extraScripts.some(name => head === name || head.endsWith(`/${name}`))
  )
}
