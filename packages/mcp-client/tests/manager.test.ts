import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpManager, type McpPermissionGate } from '../src'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-server.mjs')

const dirs: string[] = []
const managers: McpManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function configFile(servers: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-'))
  dirs.push(dir)
  const path = join(dir, 'mcp.json')
  writeFileSync(path, JSON.stringify({ mcpServers: servers }))
  return path
}

function gate(
  initial: string[] = [],
): McpPermissionGate & {
  allowed: Set<string>
  asks: string[]
  answer: 'always' | 'once' | 'deny'
} {
  const allowed = new Set(initial)
  const g = {
    allowed,
    asks: [] as string[],
    answer: 'always' as 'always' | 'once' | 'deny',
    isAllowed: (s: string) => allowed.has(s),
    ask: vi.fn(async (s: string, t: string) => {
      g.asks.push(`${s}/${t}`)
      return g.answer
    }),
    remember: (s: string) => {
      allowed.add(s)
    },
  }
  return g
}

function manager(
  configPath: string,
  permissions: McpPermissionGate,
  extra: Record<string, unknown> = {},
): McpManager {
  const m = new McpManager({
    configPath,
    permissions,
    connectTimeoutMs: 15_000,
    callTimeoutMs: 10_000,
    ...extra,
  })
  managers.push(m)
  return m
}

const echoServer = (env: Record<string, string> = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  env,
})

describe('McpManager', () => {
  it('connects a stdio server, lists namespaced tools, and runs calls', async () => {
    const changes = vi.fn()
    const m = manager(
      configFile({ echo: echoServer({ FIXTURE_SECRET: 's3cret' }) }),
      gate(['echo']),
      {
        onChange: changes,
      },
    )
    await m.start()
    expect(m.errors).toEqual([])
    expect(m.status()).toEqual([
      { name: 'echo', type: 'stdio', state: 'ready', toolCount: 3, allowed: true },
    ])
    expect(m.listTools().map((t) => t.name)).toEqual([
      'mcp__echo__echo',
      'mcp__echo__fail',
      'mcp__echo__env',
    ])
    expect(m.listTools()[0]).toMatchObject({
      server: 'echo',
      tool: 'echo',
      description: 'Echoes the text back',
      inputSchema: { type: 'object', required: ['text'] },
    })
    expect(await m.callTool('mcp__echo__echo', { text: 'hi' })).toEqual({
      output: 'echo: hi',
      isError: false,
    })
    expect(await m.callTool('mcp__echo__fail', {})).toEqual({ output: 'boom', isError: true })
    // the entry's env reaches the server process, on top of a PATH it can use
    expect(await m.callTool('mcp__echo__env', { name: 'FIXTURE_SECRET' })).toEqual({
      output: 's3cret',
      isError: false,
    })
    expect((await m.callTool('mcp__echo__env', { name: 'PATH' })).output).toContain('/')
    expect(changes).toHaveBeenCalled()
  })

  it('gates calls on the permission decision and remembers "always"', async () => {
    const g = gate()
    const m = manager(configFile({ echo: echoServer() }), g)
    await m.start()
    g.answer = 'deny'
    const denied = await m.callTool('mcp__echo__echo', { text: 'x' })
    expect(denied.isError).toBe(true)
    expect(denied.output).toContain('did not allow')
    expect(g.asks).toEqual(['echo/echo'])
    g.answer = 'once'
    expect(await m.callTool('mcp__echo__echo', { text: 'a' })).toEqual({
      output: 'echo: a',
      isError: false,
    })
    expect(g.allowed.has('echo')).toBe(false)
    g.answer = 'always'
    await m.callTool('mcp__echo__echo', { text: 'b' })
    expect(g.allowed.has('echo')).toBe(true)
    await m.callTool('mcp__echo__echo', { text: 'c' })
    expect(g.asks).toHaveLength(3)
    expect(m.status()[0].allowed).toBe(true)
  })

  it('isolates a broken server, keeps disabled ones idle, and survives a reload', async () => {
    const path = configFile({
      echo: echoServer(),
      broken: { command: '/nonexistent/mcp-server-binary' },
      off: { ...echoServer(), disabled: true },
    })
    const m = manager(path, gate(['echo', 'broken']))
    await m.start()
    const byName = Object.fromEntries(m.status().map((s) => [s.name, s]))
    expect(byName.echo.state).toBe('ready')
    expect(byName.broken.state).toBe('error')
    expect(byName.broken.error).toBeTruthy()
    expect(byName.off.state).toBe('disabled')
    expect(m.listTools()).toHaveLength(3)
    expect(m.specs.map((s) => s.name)).toEqual(['echo', 'broken', 'off'])

    writeFileSync(path, JSON.stringify({ mcpServers: { echo2: echoServer() } }))
    await m.reload()
    expect(m.status().map((s) => `${s.name}:${s.state}`)).toEqual(['echo2:ready'])
    expect(m.listTools().map((t) => t.name)).toContain('mcp__echo2__echo')
    expect((await m.callTool('mcp__echo__echo', { text: 'x' })).isError).toBe(true)
  })

  it('reports an unknown tool and a config with errors without throwing', async () => {
    const path = configFile({ 'bad name': { command: 'x' } })
    const m = manager(path, gate())
    await m.start()
    expect(m.errors).toHaveLength(1)
    expect(m.status()).toEqual([])
    const r = await m.callTool('mcp__nothing__here', {})
    expect(r).toMatchObject({ isError: true })
  })
})
