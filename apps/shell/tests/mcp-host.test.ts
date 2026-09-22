import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpManager } from '@genoffice/mcp-client'
import { McpHost } from '../src/main/mcp-host'

/**
 * Hosted servers: a builtin entry resolves to the host's loopback URL and the
 * real MCP client talks Streamable HTTP to it; the entry's env reaches the tool.
 */
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function echoHost(): McpHost {
  const host = new McpHost()
  host.register({
    name: 'echo',
    tools: [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        run: (args, ctx) => `echo: ${String(args.text)} ${ctx.env.WHO ?? '(no env)'}`,
      },
      {
        name: 'boom',
        description: 'throws',
        inputSchema: { type: 'object', properties: {} },
        run: () => {
          throw new Error('boom')
        },
      },
      {
        name: 'flagged',
        description: 'returns an error result',
        inputSchema: { type: 'object', properties: {} },
        run: () => ({ text: 'nope', isError: true }),
      },
    ],
  })
  cleanup.push(() => host.stop())
  return host
}

describe('McpHost', () => {
  it('serves a hosted server to the MCP client over loopback HTTP', async () => {
    const host = echoHost()
    const base = await host.start()
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/)
    const dir = mkdtempSync(join(tmpdir(), 'host-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { echo: { builtin: 'echo', env: { WHO: 'arrakis' } } } }),
    )
    const m = new McpManager({
      configPath: join(dir, 'mcp.json'),
      permissions: { isAllowed: () => true, ask: async () => 'always', remember: () => {} },
      resolveBuiltin: (spec) => host.specFor(spec),
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
    })
    cleanup.push(() => m.stop())
    await m.start()
    expect(m.status().map((s) => [s.name, s.state, s.type])).toEqual([['echo', 'ready', 'builtin']])
    expect(m.listTools().map((t) => t.name)).toEqual([
      'mcp__echo__echo',
      'mcp__echo__boom',
      'mcp__echo__flagged',
    ])
    const r = await m.callTool('mcp__echo__echo', { text: 'hi' })
    expect(r).toMatchObject({ isError: false, output: 'echo: hi arrakis' })
    const thrown = await m.callTool('mcp__echo__boom', {})
    expect(thrown).toMatchObject({ isError: true, output: 'boom' })
    const flagged = await m.callTool('mcp__echo__flagged', {})
    expect(flagged).toMatchObject({ isError: true, output: 'nope' })
    // the spec handed to the Claude Code path is the same URL
    expect(m.specs[0]).toMatchObject({ type: 'http', url: `${base}/echo` })
  })

  it('answers 404 without the token or for an unknown server, and calls directly without HTTP', async () => {
    const host = echoHost()
    const base = await host.start()
    const origin = new URL(base).origin
    expect((await fetch(`${origin}/wrong-token/echo`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/nope`, { method: 'POST' })).status).toBe(404)
    const direct = await host.call('echo', 'echo', { text: 'x' })
    expect(direct).toMatchObject({ isError: false, text: 'echo: x (no env)' })
    expect(
      host.specFor({ name: 'e', type: 'builtin', builtin: 'missing', env: {}, disabled: false }),
    ).toBeNull()
  })
})
