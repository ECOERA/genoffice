import { describe, expect, it } from 'vitest'
import { resolveClaudeBinary, type BinaryProbe } from '../src/main/claude-code'

/** A probe over a fake filesystem: only the listed paths exist as files. */
function probe(
  platform: NodeJS.Platform,
  files: readonly string[],
  env: NodeJS.ProcessEnv = {},
  home = platform === 'win32' ? 'C:\\Users\\dev' : '/Users/dev',
): BinaryProbe {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return { platform, env, home, isFile: (path) => set.has(path.toLowerCase()) }
}

describe('resolveClaudeBinary', () => {
  it('prefers the native installer location over PATH on macOS and Linux', () => {
    const found = resolveClaudeBinary(
      probe('darwin', ['/Users/dev/.local/bin/claude', '/usr/local/bin/claude'], {
        PATH: '/usr/local/bin:/usr/bin',
      }),
    )
    expect(found).toBe('/Users/dev/.local/bin/claude')
  })

  it('falls back to PATH, and to nothing when the CLI is absent', () => {
    expect(
      resolveClaudeBinary(probe('linux', ['/opt/tools/claude'], { PATH: '/usr/bin:/opt/tools' })),
    ).toBe('/opt/tools/claude')
    expect(resolveClaudeBinary(probe('linux', [], { PATH: '/usr/bin' }))).toBeNull()
  })

  it('resolves a bare name against PATH and PATHEXT on Windows', () => {
    const found = resolveClaudeBinary(
      probe('win32', ['C:\\Tools\\claude.exe'], {
        Path: 'C:\\Windows\\System32;C:\\Tools',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }),
    )
    expect(found).toBe('C:\\Tools\\claude.exe')
  })

  it('follows an npm launcher shim to the package entry the SDK can spawn', () => {
    const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd'
    const exe =
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
    const cli =
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    const env = { Path: 'C:\\Users\\dev\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' }
    // newer packages ship a native exe next to the shim
    expect(resolveClaudeBinary(probe('win32', [shim, exe, cli], env))).toBe(exe)
    // older packages only ship cli.js, which the SDK runs with a JS runtime
    expect(resolveClaudeBinary(probe('win32', [shim, cli], env))).toBe(cli)
    // a shim with nothing behind it is not spawnable: report the CLI as absent
    expect(resolveClaudeBinary(probe('win32', [shim], env))).toBeNull()
  })

  it('checks the Windows native installer location before PATH', () => {
    const native = 'C:\\Users\\dev\\.local\\bin\\claude.exe'
    const found = resolveClaudeBinary(
      probe('win32', [native, 'C:\\Tools\\claude.exe'], { Path: 'C:\\Tools' }),
    )
    expect(found).toBe(native)
  })
})
