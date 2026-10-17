import type { Engine, PluginOptions, Register } from 'claude-code'

import { isBuild, segments } from './shell'

const KEEP_DAYS = 7

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Full logs live in <config dir>/build-trimmer/logs: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
async function logsDir($: Engine): Promise<string> {
  const home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  return `${configDir || `${home}/.claude`}/build-trimmer/logs`
}

export function wrap(
  command: string,
  opts: { root: string; logs: string; logName: string; developerDir?: string },
): string {
  const log = `${opts.logs}/${opts.logName}.log`
  return [
    `mkdir -p ${q(opts.logs)} && find ${q(opts.logs)} -name '*.log' -mtime +${KEEP_DAYS} -delete 2>/dev/null`,
    ...(opts.developerDir ? [`export DEVELOPER_DIR=${q(opts.developerDir)}`] : []),
    `__trim_log=${q(log)}`,
    '{',
    command,
    '} > "$__trim_log" 2>&1',
    '__trim_rc=$?',
    // Without python3 the log is shown whole rather than lost.
    `if command -v python3 >/dev/null 2>&1; then python3 -I ${q(`${opts.root}/bin/xctrim.py`)} "$__trim_log" "$__trim_rc"; else cat "$__trim_log"; fi`,
    '(exit $__trim_rc)',
  ].join('\n')
}

export const register: Register = (on, options: PluginOptions) => {
  // Optional: run builds with a particular Xcode (DEVELOPER_DIR), everywhere or only where a path matches.
  const developerDir = str(options.developerDir)
  const pathMatch = str(options.developerDirPathMatch)
  // Extra scripts (comma-separated names) that run xcodebuild or swift test themselves.
  const extraScripts = str(options.extraBuildScripts)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // `# no-trim` in a command opts it out; a wrapped command is never wrapped again.
    if (/no-trim|__trim_log/.test(e.command) || !segments(e.command).some(seg => isBuild(seg, extraScripts))) return next(e)

    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const useDeveloperDir =
      developerDir !== '' &&
      !e.command.includes('DEVELOPER_DIR') &&
      (pathMatch === '' || e.command.includes(pathMatch) || (await $.session.cwd()).includes(pathMatch))
    const command = wrap(e.command, {
      root: $.plugin.root,
      logs: await logsDir($),
      logName: `${stamp}-${e.tool_use_id.slice(-6)}`,
      developerDir: useDeveloperDir ? developerDir : undefined,
    })
    return next({ ...e, command })
  }).catch(($, e, next) => next(e)) // if the wrapper can't be built, run the command as it was
}
