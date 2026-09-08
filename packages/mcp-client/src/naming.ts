/**
 * External tools reach the model as `mcp__<server>__<tool>`, the scheme
 * Claude Code uses, so a tool has the same name whichever provider runs the
 * conversation. Providers cap tool names (Anthropic and OpenAI at 64
 * characters, Gemini at 63), so over-long names are shortened with a stable
 * hash; the manager keeps the mapping back to server and tool.
 */
import { createHash } from 'node:crypto'

export const MCP_TOOL_PREFIX = 'mcp__'
export const MAX_TOOL_NAME = 63

function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function mcpToolName(server: string, tool: string): string {
  const full = `${MCP_TOOL_PREFIX}${safe(server)}__${safe(tool)}`
  if (full.length <= MAX_TOOL_NAME) return full
  const hash = createHash('sha1').update(`${server}\0${tool}`).digest('hex').slice(0, 8)
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${hash}`
}

/** The server a namespaced tool belongs to when the name was not shortened. */
export function serverOfToolName(name: string): string | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  return sep > 0 ? rest.slice(0, sep) : null
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}
