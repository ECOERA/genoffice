import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@genoffice/mcp-client'
import { externalMcpServerOf, externalMcpServerOptions } from '../src/main/claude-code'

const SPECS: McpServerSpec[] = [
  {
    name: 'fs',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'server-fs'],
    env: { TOKEN: 't' },
    disabled: false,
  },
  {
    name: 'remote',
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer x' },
    disabled: false,
  },
  { name: 'legacy', type: 'sse', url: 'http://localhost:3000/sse', headers: {}, disabled: false },
  { name: 'off', type: 'stdio', command: 'x', args: [], env: {}, disabled: true },
  // a user entry cannot shadow the bridge's own document-tool server
  { name: 'genoffice', type: 'stdio', command: 'x', args: [], env: {}, disabled: false },
]

describe('external MCP servers for the Claude Code CLI', () => {
  it('maps mcp.json entries to the SDK mcpServers shape, skipping disabled and reserved names', () => {
    const out = externalMcpServerOptions(SPECS)
    expect(Object.keys(out)).toEqual(['fs', 'remote', 'legacy'])
    expect(out.fs).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'server-fs'] })
    // the entry env is applied on top of a usable PATH
    expect((out.fs as { env: Record<string, string> }).env.TOKEN).toBe('t')
    expect((out.fs as { env: Record<string, string> }).env.PATH).toContain('/')
    expect(out.remote).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(out.legacy).toEqual({ type: 'sse', url: 'http://localhost:3000/sse' })
  })

  it('recognizes which namespaced tools belong to an external server', () => {
    expect(externalMcpServerOf('mcp__fs__read_file')).toBe('fs')
    expect(externalMcpServerOf('mcp__genoffice__insert_content')).toBeNull()
    expect(externalMcpServerOf('Read')).toBeNull()
  })
})
