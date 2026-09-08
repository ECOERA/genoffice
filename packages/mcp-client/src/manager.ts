/**
 * Runs the user's MCP servers for the lifetime of the app: connects each
 * enabled entry of mcp.json, keeps its tool list, and executes tool calls
 * from the editors' agent loops behind a permission gate. One failing server
 * never affects the others; its error is shown in Settings instead.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { readMcpConfig, type McpBuiltinSpec, type McpServerSpec, type McpStdioSpec } from './config'
import { serverEnvironment } from './env'
import { mcpToolName } from './naming'
import { formatToolResult, type McpCallOutcome, type McpImageSink } from './result'

export type McpPermissionDecision = 'always' | 'once' | 'deny'

export interface McpPermissionGate {
  /** true when the user already allowed this server's tools for good */
  isAllowed(server: string): boolean
  /** asks the user; 'always' is persisted through remember() */
  ask(server: string, tool: string): Promise<McpPermissionDecision>
  remember(server: string): void
}

export type McpServerState = 'disabled' | 'starting' | 'ready' | 'error' | 'stopped'

export interface McpServerStatus {
  name: string
  type: McpServerSpec['type']
  state: McpServerState
  error?: string
  toolCount: number
  allowed: boolean
}

export interface McpToolInfo {
  /** namespaced name the model sees */
  name: string
  server: string
  tool: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpManagerOptions {
  configPath: string
  permissions: McpPermissionGate
  appName?: string
  appVersion?: string
  connectTimeoutMs?: number
  callTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** turns a `builtin` entry into the stdio command that runs it; null = not available */
  resolveBuiltin?: (spec: McpBuiltinSpec) => McpStdioSpec | null
  /** stores images returned by tools so results can reference them by URL */
  imageSink?: McpImageSink
  log?: (message: string) => void
  /** status or tool list changed (a server connected, failed, or the config was reloaded) */
  onChange?: () => void
}

interface Connection {
  spec: McpServerSpec
  state: McpServerState
  error?: string
  client: Client | null
  transport: Transport | null
  tools: McpToolInfo[]
  stderrTail: string[]
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)),
      ms,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class McpManager {
  private readonly opts: McpManagerOptions
  private readonly connections = new Map<string, Connection>()
  private readonly toolIndex = new Map<string, { server: string; tool: string }>()
  private configErrors: string[] = []
  private generation = 0

  constructor(opts: McpManagerOptions) {
    this.opts = opts
  }

  get configPath(): string {
    return this.opts.configPath
  }

  /** problems found in mcp.json on the last load */
  get errors(): readonly string[] {
    return this.configErrors
  }

  /** the entries as configured, builtins resolved to their stdio commands (the Claude Code path hands them to the CLI) */
  get specs(): McpServerSpec[] {
    const out: McpServerSpec[] = []
    for (const c of this.connections.values()) {
      const spec = c.spec.type === 'builtin' ? this.opts.resolveBuiltin?.(c.spec) : c.spec
      if (spec) out.push({ ...spec, disabled: c.spec.disabled })
    }
    return out
  }

  async start(): Promise<void> {
    const gen = ++this.generation
    const config = readMcpConfig(this.opts.configPath)
    this.configErrors = config.errors
    for (const spec of config.servers) {
      this.connections.set(spec.name, {
        spec,
        state: spec.disabled ? 'disabled' : 'starting',
        client: null,
        transport: null,
        tools: [],
        stderrTail: [],
      })
    }
    this.notify()
    await Promise.allSettled(
      config.servers.filter((s) => !s.disabled).map((s) => this.connect(s.name, gen)),
    )
  }

  async stop(): Promise<void> {
    this.generation++
    const open = [...this.connections.values()]
    this.connections.clear()
    this.toolIndex.clear()
    await Promise.allSettled(
      open.map(async (c) => {
        c.state = 'stopped'
        await c.client?.close().catch(() => {})
        await c.transport?.close().catch(() => {})
      }),
    )
    this.notify()
  }

  async reload(): Promise<void> {
    await this.stop()
    await this.start()
  }

  listTools(): McpToolInfo[] {
    return [...this.connections.values()].filter((c) => c.state === 'ready').flatMap((c) => c.tools)
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.spec.name,
      type: c.spec.type,
      state: c.state,
      ...(c.error ? { error: c.error } : {}),
      toolCount: c.tools.length,
      allowed: this.opts.permissions.isAllowed(c.spec.name),
    }))
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallOutcome> {
    const ref = this.toolIndex.get(name)
    const conn = ref ? this.connections.get(ref.server) : undefined
    if (!ref || !conn || conn.state !== 'ready' || !conn.client) {
      return {
        output: `Tool ${name} is not available (its MCP server is not connected).`,
        isError: true,
      }
    }
    if (!this.opts.permissions.isAllowed(ref.server)) {
      const decision = await this.opts.permissions.ask(ref.server, ref.tool)
      if (decision === 'deny') {
        return {
          output: `The user did not allow tools from the "${ref.server}" server to run.`,
          isError: true,
        }
      }
      if (decision === 'always') this.opts.permissions.remember(ref.server)
    }
    try {
      const result = await conn.client.callTool({ name: ref.tool, arguments: input }, undefined, {
        timeout: this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })
      return formatToolResult(result, this.opts.imageSink)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.log?.(`mcp: ${ref.server}/${ref.tool} failed: ${message}`)
      return { output: `${ref.server}/${ref.tool} failed: ${message}`, isError: true }
    }
  }

  private notify(): void {
    try {
      this.opts.onChange?.()
    } catch {
      // listeners must not break the manager
    }
  }

  private makeTransport(conn: Connection): Transport {
    let spec = conn.spec
    if (spec.type === 'builtin') {
      const resolved = this.opts.resolveBuiltin?.(spec)
      if (!resolved) throw new Error(`built-in server "${spec.builtin}" is not available`)
      spec = resolved
    }
    if (spec.type === 'stdio') {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: serverEnvironment(spec.env, this.opts.env),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        stderr: 'pipe',
      })
      transport.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim()
        if (!line) return
        conn.stderrTail.push(line)
        if (conn.stderrTail.length > 20) conn.stderrTail.shift()
      })
      return transport
    }
    const url = new URL(spec.url)
    const requestInit = Object.keys(spec.headers).length ? { headers: spec.headers } : undefined
    return spec.type === 'sse'
      ? new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
      : new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined)
  }

  private async connect(name: string, gen: number): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return
    const client = new Client(
      { name: this.opts.appName ?? 'DuneOffice', version: this.opts.appVersion ?? '0.0.0' },
      { capabilities: {} },
    )
    try {
      const transport = this.makeTransport(conn)
      conn.transport = transport
      const timeout = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      await withTimeout(client.connect(transport), timeout, `connecting to "${name}"`)
      const listed = await withTimeout(client.listTools(), timeout, `listing tools of "${name}"`)
      if (gen !== this.generation) {
        await client.close().catch(() => {})
        return
      }
      conn.client = client
      conn.tools = listed.tools.map((t) => {
        const full = mcpToolName(name, t.name)
        this.toolIndex.set(full, { server: name, tool: t.name })
        return {
          name: full,
          server: name,
          tool: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        }
      })
      conn.state = 'ready'
      conn.error = undefined
      transport.onclose = () => {
        if (this.connections.get(name) !== conn) return
        conn.state = 'error'
        conn.error = conn.stderrTail.at(-1) ?? 'connection closed'
        for (const t of conn.tools) this.toolIndex.delete(t.name)
        conn.tools = []
        this.notify()
      }
      this.opts.log?.(`mcp: "${name}" ready with ${conn.tools.length} tools`)
    } catch (err) {
      await client.close().catch(() => {})
      if (gen !== this.generation) return
      conn.client = null
      conn.state = 'error'
      const detail = err instanceof Error ? err.message : String(err)
      const stderr = conn.stderrTail.at(-1)
      conn.error = stderr ? `${detail} (${stderr})` : detail
      this.opts.log?.(`mcp: "${name}" failed: ${conn.error}`)
    }
    this.notify()
  }
}
