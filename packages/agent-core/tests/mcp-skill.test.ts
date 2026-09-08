import { describe, expect, it, vi } from 'vitest'
import { composeSkills, createMcpSkill, type McpBridge, type McpToolInfo } from '../src'

const READ: McpToolInfo = {
  name: 'mcp__fs__read_file',
  server: 'fs',
  tool: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

function fakeBridge(
  initial: McpToolInfo[],
): McpBridge & { emit: () => void; tools: McpToolInfo[] } {
  let handler: (() => void) | null = null
  const b = {
    tools: initial,
    listTools: vi.fn(async () => b.tools),
    callTool: vi.fn(async (name: string, input: Record<string, unknown>) => ({
      output: `${name}(${JSON.stringify(input)})`,
      isError: false,
    })),
    onChanged: (h: () => void) => {
      handler = h
      return () => {
        handler = null
      }
    },
    emit: () => handler?.(),
  }
  return b
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createMcpSkill', () => {
  it('exposes the bridge tools once listed and hides its prompt while empty', async () => {
    const bridge = fakeBridge([READ])
    const skill = createMcpSkill(bridge)
    expect(skill.tools).toEqual([])
    expect(skill.systemPrompt).toBe('')
    await tick()
    expect(skill.tools).toEqual([
      { name: 'mcp__fs__read_file', description: 'Read a file', inputSchema: READ.inputSchema },
    ])
    expect(skill.systemPrompt).toContain('mcp__<server>__<tool>')
  })

  it('refreshes on change events and is read live through composeSkills', async () => {
    const bridge = fakeBridge([])
    const skill = createMcpSkill(bridge)
    const composed = composeSkills('all', '', [skill])
    await tick()
    expect(composed.tools).toEqual([])
    bridge.tools = [READ]
    bridge.emit()
    await tick()
    expect(composed.tools.map((t) => t.name)).toEqual(['mcp__fs__read_file'])
  })

  it('routes execution over the bridge with a server-prefixed summary', async () => {
    const bridge = fakeBridge([READ])
    const skill = createMcpSkill(bridge)
    await tick()
    const r = await skill.executeTool({
      id: '1',
      name: 'mcp__fs__read_file',
      input: { path: '/a' },
    })
    expect(r).toEqual({
      output: 'mcp__fs__read_file({"path":"/a"})',
      isError: false,
      summary: 'fs: read_file',
    })
    vi.mocked(bridge.callTool).mockRejectedValueOnce(new Error('ipc down'))
    const failed = await skill.executeTool({ id: '2', name: 'mcp__fs__read_file', input: {} })
    expect(failed).toMatchObject({ isError: true, output: 'ipc down' })
  })

  it('is an empty skill without a bridge', async () => {
    const skill = createMcpSkill(undefined)
    await tick()
    expect(skill.tools).toEqual([])
    const r = await skill.executeTool({ id: '1', name: 'mcp__x__y', input: {} })
    expect(r.isError).toBe(true)
  })
})
