/**
 * Environment for stdio servers. A packaged app launched from the Dock
 * inherits no login shell, so `npx`, `uvx` or a Homebrew `node` would not
 * resolve; the login shell's PATH is read once and merged in, with the usual
 * install locations as a fallback when even that fails.
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const FALLBACK_DIRS =
  process.platform === 'win32'
    ? []
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(homedir(), '.local', 'bin'),
        join(homedir(), '.cargo', 'bin'),
        join(homedir(), '.bun', 'bin'),
        join(homedir(), '.volta', 'bin'),
      ]

let cachedLoginPath: string | null = null

/** PATH as the user's interactive login shell sees it (POSIX only); '' when unavailable. */
export function loginShellPath(): string {
  if (cachedLoginPath !== null) return cachedLoginPath
  cachedLoginPath = ''
  if (process.platform === 'win32') return ''
  const shell = process.env.SHELL || '/bin/sh'
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'], {
      timeout: 4000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /__PATH__([\s\S]*?)__END__/.exec(out)
    if (m) cachedLoginPath = m[1]
  } catch {
    // no login shell (CI, sandbox): the fallback dirs still apply
  }
  return cachedLoginPath
}

/** Base environment for a spawned server: the app's env, the login PATH, and the entry's own `env`. */
export function serverEnvironment(
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v
  const seen = new Set<string>()
  const merged: string[] = []
  for (const dir of [
    ...(env.PATH ?? '').split(delimiter),
    ...loginShellPath().split(delimiter),
    ...FALLBACK_DIRS,
  ]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir)
      merged.push(dir)
    }
  }
  env.PATH = merged.join(delimiter)
  // Electron sets this for its own helpers; a child node must not inherit it
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ...extra }
}
