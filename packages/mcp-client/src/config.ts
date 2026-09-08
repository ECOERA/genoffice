/**
 * The user's MCP server list: ~/.genoffice/mcp.json in the Claude Desktop /
 * Claude Code `mcpServers` shape, so a file written for those apps works
 * here unchanged.
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"] },
 *       "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
 *     }
 *   }
 *
 * Extensions: `disabled: true` keeps an entry without starting it, and
 * `type` may be "stdio" | "sse" | "http" (inferred from command/url otherwise).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface McpStdioSpec {
  name: string
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  disabled: boolean
}

export interface McpRemoteSpec {
  name: string
  type: 'sse' | 'http'
  url: string
  headers: Record<string, string>
  disabled: boolean
}

export type McpServerSpec = McpStdioSpec | McpRemoteSpec

export interface McpConfig {
  servers: McpServerSpec[]
  /** entries that were skipped, with the reason (shown in Settings) */
  errors: string[]
}

/** Server names become part of tool names, so they are limited to a safe alphabet. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

export function defaultMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GENOFFICE_MCP_CONFIG
  if (override && override.trim()) return override.trim()
  return join(env.GENOFFICE_HOME?.trim() || join(homedir(), '.genoffice'), 'mcp.json')
}

export const MCP_CONFIG_TEMPLATE = `{
  "mcpServers": {
  }
}
`

/** Creates the file with an empty server map when it does not exist; returns the path. */
export function ensureMcpConfigFile(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, MCP_CONFIG_TEMPLATE, { mode: 0o600 })
  }
  return path
}

function stringRecord(value: unknown, what: string, errors: string[]): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${what} must be an object of strings`)
    return {}
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
    else errors.push(`${what}.${k} must be a string`)
  }
  return out
}

/** Validates a parsed mcp.json; bad entries are reported and skipped, never fatal. */
export function parseMcpConfig(raw: unknown): McpConfig {
  const errors: string[] = []
  const servers: McpServerSpec[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { servers, errors: ['mcp.json must be a JSON object with an "mcpServers" map'] }
  }
  const map = (raw as { mcpServers?: unknown }).mcpServers
  if (map === undefined) return { servers, errors }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { servers, errors: ['"mcpServers" must be an object keyed by server name'] }
  }
  for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
    if (!SERVER_NAME_RE.test(name)) {
      errors.push(`"${name}": server names may only use letters, digits, "_" and "-" (max 40)`)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`"${name}": entry must be an object`)
      continue
    }
    const e = entry as Record<string, unknown>
    const disabled = e.disabled === true
    const declaredType = typeof e.type === 'string' ? e.type : undefined
    const hasCommand = typeof e.command === 'string' && e.command.trim() !== ''
    const hasUrl = typeof e.url === 'string' && e.url.trim() !== ''
    if (declaredType === 'stdio' || (declaredType === undefined && hasCommand)) {
      if (!hasCommand) {
        errors.push(`"${name}": stdio server needs a "command"`)
        continue
      }
      const args = Array.isArray(e.args) ? e.args : []
      if (args.some((a) => typeof a !== 'string')) {
        errors.push(`"${name}": "args" must be an array of strings`)
        continue
      }
      servers.push({
        name,
        type: 'stdio',
        command: (e.command as string).trim(),
        args: args as string[],
        env: stringRecord(e.env, `"${name}".env`, errors),
        ...(typeof e.cwd === 'string' && e.cwd.trim() ? { cwd: e.cwd.trim() } : {}),
        disabled,
      })
      continue
    }
    if (
      declaredType === 'sse' ||
      declaredType === 'http' ||
      (declaredType === undefined && hasUrl)
    ) {
      if (!hasUrl) {
        errors.push(`"${name}": remote server needs a "url"`)
        continue
      }
      let url: URL
      try {
        url = new URL((e.url as string).trim())
      } catch {
        errors.push(`"${name}": "url" is not a valid URL`)
        continue
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.push(`"${name}": "url" must be http(s)`)
        continue
      }
      servers.push({
        name,
        type: declaredType === 'sse' ? 'sse' : 'http',
        url: url.toString(),
        headers: stringRecord(e.headers, `"${name}".headers`, errors),
        disabled,
      })
      continue
    }
    errors.push(
      declaredType
        ? `"${name}": unknown type "${declaredType}" (use stdio, sse or http)`
        : `"${name}": needs either a "command" (stdio) or a "url" (remote)`,
    )
  }
  return { servers, errors }
}

/** Reads and validates the file; a missing file is an empty config, a broken one a single error. */
export function readMcpConfig(path: string): McpConfig {
  if (!existsSync(path)) return { servers: [], errors: [] }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { servers: [], errors: [`${path}: ${(err as Error).message}`] }
  }
  return parseMcpConfig(raw)
}
