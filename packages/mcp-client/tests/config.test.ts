import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultMcpConfigPath,
  ensureMcpConfigFile,
  mcpToolName,
  parseMcpConfig,
  readMcpConfig,
  serverEnvironment,
  serverOfToolName,
} from '../src'

describe('mcp.json parsing', () => {
  it('accepts the Claude Desktop shape and infers transport types', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server-fs', '/tmp'], env: { A: '1', N: 2 } },
        remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
        legacy: { type: 'sse', url: 'http://localhost:3000/sse' },
        off: { command: 'foo', disabled: true },
      },
    })
    expect(errors).toEqual([])
    expect(servers).toEqual([
      {
        name: 'fs',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server-fs', '/tmp'],
        env: { A: '1', N: '2' },
        disabled: false,
      },
      {
        name: 'remote',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        disabled: false,
      },
      {
        name: 'legacy',
        type: 'sse',
        url: 'http://localhost:3000/sse',
        headers: {},
        disabled: false,
      },
      { name: 'off', type: 'stdio', command: 'foo', args: [], env: {}, disabled: true },
    ])
  })

  it('reports bad entries and keeps the good ones', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        'bad name!': { command: 'x' },
        nocmd: { args: ['a'] },
        badurl: { url: 'ftp://x' },
        badargs: { command: 'x', args: [1] },
        weird: { type: 'grpc', url: 'https://x' },
        ok: { command: 'x' },
      },
    })
    expect(servers.map((s) => s.name)).toEqual(['ok'])
    expect(errors).toHaveLength(5)
    expect(errors[0]).toContain('bad name!')
  })

  it('treats a missing file as empty and a broken file as one error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      expect(readMcpConfig(join(dir, 'none.json'))).toEqual({ servers: [], errors: [] })
      writeFileSync(join(dir, 'broken.json'), '{ not json')
      const broken = readMcpConfig(join(dir, 'broken.json'))
      expect(broken.servers).toEqual([])
      expect(broken.errors).toHaveLength(1)
      const created = ensureMcpConfigFile(join(dir, 'sub', 'mcp.json'))
      expect(JSON.parse(readFileSync(created, 'utf8'))).toEqual({ mcpServers: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the config path from the environment', () => {
    expect(defaultMcpConfigPath({ GENOFFICE_MCP_CONFIG: '/x/mcp.json' })).toBe('/x/mcp.json')
    expect(defaultMcpConfigPath({ GENOFFICE_HOME: '/home/u/.dune' })).toBe('/home/u/.dune/mcp.json')
    expect(defaultMcpConfigPath({})).toMatch(/\.genoffice\/mcp\.json$/)
  })
})

describe('tool naming', () => {
  it('namespaces tools per server and shortens over-long names stably', () => {
    expect(mcpToolName('fs', 'read_file')).toBe('mcp__fs__read_file')
    expect(mcpToolName('my server', 'do.it')).toBe('mcp__my_server__do_it')
    const long = mcpToolName(
      'a-very-long-server-name-indeed',
      'an_extremely_long_tool_name_that_goes_on_and_on',
    )
    expect(long.length).toBeLessThanOrEqual(63)
    expect(long).toBe(
      mcpToolName(
        'a-very-long-server-name-indeed',
        'an_extremely_long_tool_name_that_goes_on_and_on',
      ),
    )
    expect(serverOfToolName('mcp__fs__read_file')).toBe('fs')
    expect(serverOfToolName('read_file')).toBeNull()
  })
})

describe('server environment', () => {
  it('merges the login PATH and fallback dirs and applies the entry env last', () => {
    const env = serverEnvironment(
      { FOO: 'bar', PATH: 'ignored-by-merge' },
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    )
    expect(env.FOO).toBe('bar')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    // the entry's own PATH wins verbatim, like Claude Desktop
    expect(env.PATH).toBe('ignored-by-merge')
    const merged = serverEnvironment({}, { PATH: '/usr/bin' })
    expect(merged.PATH.split(':')[0]).toBe('/usr/bin')
    expect(merged.PATH.split(':').length).toBeGreaterThan(1)
  })
})
